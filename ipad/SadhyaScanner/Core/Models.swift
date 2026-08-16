import Foundation

/// A scan already made against a pass: when, how many it let in, and at which
/// station.
///
/// The time arrives as a plain UTC ISO string with no fractional seconds — one
/// shape, parsed once — and is shown on the iPad's own clock, because that is
/// the clock the volunteer is comparing it against.
struct ScanMark: Decodable, Hashable {
    let at: String
    let quantity: Int
    let device: String?

    private static let parser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    var date: Date? { Self.parser.date(from: at) }

    /// "12:40 PM". Empty only if the server ever sends something unparseable,
    /// in which case the count beside it still stands on its own.
    var timeLabel: String {
        guard let date else { return "" }
        return Self.clock.string(from: date)
    }

    /// "4 minutes ago" while that is the striking fact, nothing once it is not.
    ///
    /// A pass scanned minutes ago is a phone being passed back down the queue;
    /// one scanned two hours ago is a family returning for a second sitting.
    /// Past an hour the clock time says it better on its own.
    func agoLabel(now: Date = Date()) -> String? {
        guard let date else { return nil }
        let minutes = Int(now.timeIntervalSince(date) / 60)
        guard minutes >= 0, minutes < 60 else { return nil }
        if minutes < 1 { return "just now" }
        return "\(minutes) minute\(minutes == 1 ? "" : "s") ago"
    }
}

/// The subset of a household row the scanner needs.
///
/// Decoding is deliberately partial — the API returns the full record, and
/// anything not listed here is ignored rather than mapped. A column added to the
/// web app must never be able to break the tablet at the door.
struct Household: Decodable, Identifiable, Hashable {
    let id: String
    let displayName: String
    let paymentStatus: String
    let ticketsPurchased: Int
    let ticketsRedeemed: Int
    let ticketsRemaining: Int
    let childrenUnder6: Int
    let passEnabled: Bool
    /// Optional so an older deployment that does not send them still decodes.
    let paymentMethod: String?
    let amountPaidCents: Int?
    /// Earlier scans on this pass, newest first. Optional for the same reason:
    /// a server that predates them leaves the door working, just quieter.
    let recentScans: [ScanMark]?

    /// The scan a volunteer is deciding against — the most recent one.
    var lastScan: ScanMark? { recentScans?.first }

    /// The money side alone: settled, however it was settled.
    var settled: Bool {
        paymentStatus == "paid" || paymentStatus == "comped"
    }

    /// Mirrors the web scanner's rule: a pass opens the gate only when it is
    /// enabled and the money is settled one way or the other.
    var usable: Bool {
        passEnabled && settled
    }

    var statusLabel: String {
        switch paymentStatus {
        case "paid": return "PAID"
        case "comped": return "COMPED"
        case "unpaid": return "UNPAID"
        case "pending": return "PENDING"
        case "refunded": return "REFUNDED"
        case "partially_refunded": return "PART. REFUNDED"
        case "needs_review": return "NEEDS REVIEW"
        default: return paymentStatus.uppercased()
        }
    }
}

/// How a family paid at the door.
///
/// The money never moves through this app — a volunteer takes cash, watches a
/// Zelle transfer land, or runs a card on the desk reader, and this is only the
/// record of which of those happened. Cards are listed because the desk has a
/// reader, not because the iPad has one.
enum DoorPayment: String, CaseIterable, Identifiable {
    case cash
    case zelle
    case square
    case other
    case complimentary

    var id: String { rawValue }

    /// The value the households table stores. Matches the server's accepted
    /// list exactly — anything else comes back as a refusal.
    var wireMethod: String { rawValue }

    /// What the payment status becomes once this is written down.
    var wireStatus: String { self == .complimentary ? "comped" : "paid" }

    /// Whether money actually changes hands. A comp is recorded, not collected.
    var collects: Bool { self != .complimentary }

    var label: String {
        switch self {
        case .cash: return "Cash"
        case .zelle: return "Zelle"
        case .square: return "Card"
        case .other: return "Other"
        case .complimentary: return "No charge"
        }
    }

    var detail: String {
        switch self {
        case .cash: return "Notes into the box"
        case .zelle: return "Wait for it to land"
        case .square: return "Reader at the desk"
        case .other: return "Check, Venmo, anything else"
        case .complimentary: return "Guest of the committee"
        }
    }

    var symbol: String {
        switch self {
        case .cash: return "banknote"
        case .zelle: return "paperplane.fill"
        case .square: return "creditcard"
        case .other: return "ellipsis.circle"
        case .complimentary: return "gift"
        }
    }
}

/// Whole dollars where the cents are zero, which at this event they almost
/// always are. "$60" reads across a hall; "$60.00" does not read any better.
enum Money {
    static func text(_ cents: Int) -> String {
        cents % 100 == 0
            ? "$\(cents / 100)"
            : String(format: "$%.2f", Double(cents) / 100)
    }
}

/// What every ticket-moving endpoint answers with, success or refusal.
///
/// A refusal comes back as HTTP 200 with `success: false` and a named error, so
/// there is exactly one shape to decode and no branch where the app has to guess
/// whether tickets moved.
struct TicketResult: Decodable {
    let success: Bool
    let error: String?
    let displayName: String?
    let redemptionId: String?
    let redeemedNow: Int?
    let requested: Int?
    let restored: Int?
    let ticketsRemaining: Int?

    /// Volunteer-facing wording for each named refusal. Every string says what
    /// happened to the tickets and what to do with the family standing there —
    /// "something went wrong" on its own strands both of them.
    var refusal: (title: String, detail: String) {
        switch error {
        case "INSUFFICIENT_TICKETS":
            let left = ticketsRemaining ?? 0
            return (
                "ONLY \(left) REMAINING",
                "You asked for \(requested ?? 0). Nothing was redeemed — scan again and choose \(left) or fewer."
            )
        case "NOT_PAID":
            return ("NOT PAID", "Send them to the registration desk to pay.")
        case "PASS_DISABLED":
            return ("PASS DISABLED", "Send them to the registration desk.")
        case "PASS_NOT_FOUND":
            return ("PASS NOT VALID", "Send them to the registration desk.")
        case "INVALID_QUANTITY":
            return ("INVALID NUMBER", "Nothing was redeemed. Try again.")
        case "UNAUTHORIZED":
            return ("SIGNED OUT", "Sign in again to keep scanning.")
        case "OUTSIDE_UNDO_WINDOW":
            return ("TOO LATE TO UNDO", "This scan is older than half an hour. Get the admin.")
        default:
            return ("SOMETHING WENT WRONG", "Nothing was redeemed. Try again.")
        }
    }
}
