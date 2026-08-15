import Foundation
import UIKit

enum BackendError: LocalizedError {
    case notConfigured
    case signedOut
    case passNotFound
    /// The server answered, but has nothing at that path.
    ///
    /// Separate from `passNotFound` on purpose: both arrive as HTTP 404, and
    /// they mean opposite things. On the pass lookup a 404 is a guest holding
    /// the wrong QR code. Anywhere else it is the app asking for an endpoint
    /// this deployment does not have — and telling a volunteer typing a
    /// password that their code is not a Sadhya pass sends them hunting for a
    /// problem that is not there.
    case missing
    case offline
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "No server address set."
        case .signedOut: return "This iPad is signed out."
        case .passNotFound: return "That code is not a Sadhya pass."
        case .missing: return "This server has no sign-in endpoint for the app yet. Check the address, or deploy the latest site."
        case .offline: return "Could not reach the server."
        case .badResponse(let detail): return detail
        }
    }
}

/// Talks to the same endpoints the browser scanner uses.
///
/// Session handling is deliberately identical to a browser's: sign-in sets the
/// `onam_staff` cookie, `HTTPCookieStorage.shared` keeps it across launches for
/// its full two weeks, and every later request carries it automatically. The
/// tablet therefore has no second credential to leak and no token of its own to
/// revoke — an admin killing the session in the web app kills this one too.
@MainActor
final class Backend: ObservableObject {
    enum Status: Equatable {
        case checking
        case needsSignIn
        case ready(staff: String)
    }

    /// One instance for the whole app.
    ///
    /// Not a convenience: the cookie that authenticates every call lives in this
    /// object's URLSession, and a second Backend would be a second, differently
    /// signed-in scanner running on the same iPad.
    static let shared = Backend()

    @Published private(set) var status: Status = .checking
    @Published var address: String {
        didSet { UserDefaults.standard.set(address, forKey: Self.addressKey) }
    }

    private static let addressKey = "sadhya.server.address"

    /// The station name written into the audit trail for every scan made here,
    /// so a disputed redemption can be traced to a door rather than to "an iPad".
    let device: String = String(UIDevice.current.name.prefix(80))

    private let http: URLSession = {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = .shared
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        // Short: at a food line, a request that has not answered in eight
        // seconds has failed, whatever the network eventually decides.
        config.timeoutIntervalForRequest = 8
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    init() {
        address = UserDefaults.standard.string(forKey: Self.addressKey) ?? ""
    }

    private var baseURL: URL? {
        var trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if !trimmed.contains("://") { trimmed = "https://" + trimmed }
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return URL(string: trimmed)
    }

    // MARK: - Session

    /// Launch check. Decides between the camera and the password screen without
    /// making the volunteer type anything they have already typed.
    func restore() async {
        guard baseURL != nil else {
            status = .needsSignIn
            return
        }
        status = .checking
        do {
            let response: SessionResponse = try await get("/api/staff/session")
            status = .ready(staff: response.staff?.name ?? "Volunteer")
        } catch {
            status = .needsSignIn
        }
    }

    func signIn(password: String) async throws {
        guard baseURL != nil else { throw BackendError.notConfigured }
        let response: SessionResponse = try await post("/api/staff/session", body: ["password": password])
        status = .ready(staff: response.staff?.name ?? "Volunteer")
    }

    func signOut() {
        if let baseURL, let cookies = HTTPCookieStorage.shared.cookies(for: baseURL) {
            for cookie in cookies { HTTPCookieStorage.shared.deleteCookie(cookie) }
        }
        status = .needsSignIn
    }

    // MARK: - Scanning

    /// Resolve a scanned code. Never changes anything — the volunteer still has
    /// to read the name aloud and choose a count before a ticket moves.
    func lookup(token: String) async throws -> Household {
        do {
            let response: LookupResponse = try await get("/api/staff/lookup", query: ["token": token])
            guard let household = response.household else { throw BackendError.passNotFound }
            return household
        } catch BackendError.missing {
            // Here, and only here, a 404 means the code is not a pass.
            throw BackendError.passNotFound
        }
    }

    func search(_ term: String) async throws -> [Household] {
        let response: SearchResponse = try await get("/api/staff/lookup", query: ["q": term])
        return response.results ?? []
    }

    func redeem(household: Household, quantity: Int) async throws -> TicketResult {
        try await post("/api/staff/redeem", body: [
            "householdId": household.id,
            "quantity": quantity,
            "device": device,
        ])
    }

    func giveBack(redemptionId: String, quantity: Int) async throws -> TicketResult {
        try await post("/api/staff/reverse", body: [
            "redemptionId": redemptionId,
            "quantity": quantity,
        ])
    }

    func giveBack(householdId: String, quantity: Int) async throws -> TicketResult {
        try await post("/api/staff/reverse", body: [
            "householdId": householdId,
            "quantity": quantity,
        ])
    }

    // MARK: - Transport

    private struct SessionResponse: Decodable {
        struct Staff: Decodable { let name: String }
        let ok: Bool
        let staff: Staff?
    }

    private struct LookupResponse: Decodable {
        let household: Household?
    }

    private struct SearchResponse: Decodable {
        let results: [Household]?
    }

    private struct StatedError: Decodable {
        let error: String?
    }

    /// Built by string, not by `appendingPathComponent`: the paths here are
    /// absolute and already start with a slash, and appending them as components
    /// yields a doubled separator that the router does not match.
    private func url(_ path: String, query: [String: String] = [:]) throws -> URL {
        guard let baseURL else { throw BackendError.notConfigured }
        guard var components = URLComponents(string: baseURL.absoluteString + path) else {
            throw BackendError.notConfigured
        }
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw BackendError.notConfigured }
        return url
    }

    private func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try await send(URLRequest(url: try url(path, query: query)))
    }

    private func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        var request = URLRequest(url: try url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await http.data(for: request)
        } catch {
            throw BackendError.offline
        }

        let code = (response as? HTTPURLResponse)?.statusCode ?? 0

        // 401 is the one status that changes what the whole app shows, so it is
        // handled here rather than at each call site: the session died, and the
        // next thing on screen is the password field, not a scan result.
        if code == 401 {
            status = .needsSignIn
            // A wrong password comes back as 401 too, and "this iPad is signed
            // out" is a useless thing to read while typing one. Prefer whatever
            // the server said about it.
            if let stated = try? decoder.decode(StatedError.self, from: data).error {
                throw BackendError.badResponse(stated)
            }
            throw BackendError.signedOut
        }
        if code == 404 { throw BackendError.missing }
        guard (200..<300).contains(code) else {
            throw BackendError.badResponse("The server answered \(code).")
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw BackendError.badResponse("The server sent something unexpected.")
        }
    }
}
