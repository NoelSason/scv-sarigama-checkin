import Foundation

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

    /// Mirrors the web scanner's rule: a pass opens the gate only when it is
    /// enabled and the money is settled one way or the other.
    var usable: Bool {
        passEnabled && (paymentStatus == "paid" || paymentStatus == "comped")
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
