import SwiftUI

/// The state machine a scan moves through, and the only place tickets are asked
/// to move.
///
/// It mirrors the browser scanner deliberately, step for step: look up, read the
/// name, choose a count, confirm the age rule, then redeem. Every one of those
/// stops exists because skipping it costs the event free meals, and a second
/// client that quietly dropped one would be a hole in the door rather than a
/// nicer scanner.
@MainActor
final class ScanFlow: ObservableObject {
    struct Receipt: Equatable {
        let name: String
        let admitted: Int
        let remaining: Int
        let redemptionId: String?
    }

    enum Phase: Equatable {
        case scanning
        case looking
        case found(Household)
        case confirming(Household, Int)
        case working(String)
        case admitted(Receipt)
        case returned(name: String, restored: Int, remaining: Int)
        case failure(title: String, detail: String)

        /// Anything but the camera being live means the scanner is suspended.
        var isIdle: Bool { self == .scanning }
    }

    @Published private(set) var phase: Phase = .scanning

    /// How long a result stays up before the camera takes over again.
    ///
    /// The success screen sits there longer than it takes to read, because that
    /// pause is the only window a volunteer has to notice a wrong number and tap
    /// give-back. A refusal stays longer still — it usually has to be read out
    /// to the person it concerns.
    private let successDwell: TimeInterval = 3.0
    private let failureDwell: TimeInterval = 5.5

    private let backend = Backend.shared
    private var dismissal: Task<Void, Never>?

    // MARK: - Steps

    func scanned(_ payload: String) {
        guard phase.isIdle else { return }
        Task { await lookUp(payload) }
    }

    func pick(_ household: Household) {
        cancelDismissal()
        set(.found(household))
    }

    func propose(_ quantity: Int, for household: Household) {
        Chime.shared.play(.tap)
        set(.confirming(household, quantity))
    }

    func backToCount(_ household: Household) {
        set(.found(household))
    }

    func reset() {
        cancelDismissal()
        set(.scanning)
    }

    // MARK: - Network

    private func lookUp(_ payload: String) async {
        set(.looking)
        do {
            let household = try await backend.lookup(token: payload)
            set(.found(household))
        } catch BackendError.passNotFound {
            fail("PASS NOT VALID", "This code is not a Sadhya pass. Send them to the registration desk.")
        } catch BackendError.signedOut {
            fail("SIGNED OUT", "Sign in again to keep scanning.")
        } catch {
            fail("CONNECTION PROBLEM", "Could not reach the server. Do not admit anyone yet — try again.")
        }
    }

    func admit(_ quantity: Int, for household: Household) {
        Task {
            set(.working("Admitting \(quantity)…"))
            do {
                let result = try await backend.redeem(household: household, quantity: quantity)
                guard result.success else {
                    let refusal = result.refusal
                    fail(refusal.title, refusal.detail)
                    return
                }
                Chime.shared.play(.admitted)
                land(.admitted(Receipt(
                    name: result.displayName ?? household.displayName,
                    admitted: result.redeemedNow ?? quantity,
                    remaining: result.ticketsRemaining ?? 0,
                    redemptionId: result.redemptionId
                )), dwell: successDwell)
            } catch {
                // Nothing is assumed about what the server did with a request it
                // never answered. The volunteer is told to rescan, and the scan
                // will show the truth.
                fail("CONNECTION PROBLEM", "Nothing was confirmed. Check the signal and scan again.")
            }
        }
    }

    /// Undo the scan just made, from the success screen.
    func giveBack(redemptionId: String, quantity: Int, name: String) {
        Task {
            set(.working("Giving back \(quantity)…"))
            await handleGiveBack(name: name) {
                try await self.backend.giveBack(redemptionId: redemptionId, quantity: quantity)
            }
        }
    }

    /// Give back admissions used earlier, when the family is known but the scan
    /// that over-counted them is not.
    func giveBack(household: Household, quantity: Int) {
        Task {
            set(.working("Giving back \(quantity)…"))
            await handleGiveBack(name: household.displayName) {
                try await self.backend.giveBack(householdId: household.id, quantity: quantity)
            }
        }
    }

    private func handleGiveBack(name: String, _ call: () async throws -> TicketResult) async {
        do {
            let result = try await call()
            guard result.success else {
                let refusal = result.refusal
                fail("COULD NOT GIVE BACK", refusal.detail)
                return
            }
            Chime.shared.play(.admitted)
            land(.returned(
                name: result.displayName ?? name,
                restored: result.restored ?? 0,
                remaining: result.ticketsRemaining ?? 0
            ), dwell: successDwell)
        } catch {
            fail("COULD NOT GIVE BACK", "The admissions were NOT returned. Check the signal and try again.")
        }
    }

    // MARK: - Plumbing

    private func set(_ next: Phase) {
        withAnimation(.spring(response: 0.42, dampingFraction: 0.82)) { phase = next }
    }

    private func fail(_ title: String, _ detail: String) {
        Chime.shared.play(.refused)
        land(.failure(title: title, detail: detail), dwell: failureDwell)
    }

    /// Show a result, then hand the screen back to the camera on its own.
    ///
    /// Automatic because the alternative is a tablet left on a success screen
    /// while the next family is already holding up a phone at it.
    private func land(_ next: Phase, dwell: TimeInterval) {
        set(next)
        cancelDismissal()
        dismissal = Task {
            try? await Task.sleep(nanoseconds: UInt64(dwell * 1_000_000_000))
            guard !Task.isCancelled else { return }
            set(.scanning)
        }
    }

    private func cancelDismissal() {
        dismissal?.cancel()
        dismissal = nil
    }
}
