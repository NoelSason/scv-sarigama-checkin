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

    /// Admissions bought at the door, and how they were paid for.
    ///
    /// Held as one value so the count, the method, and the amount cannot drift
    /// apart between the screen that chose them and the screen that confirms
    /// them — the confirmation has to be describing the thing about to happen.
    struct Sale: Equatable {
        let household: Household
        /// Zero is legitimate: a family that already bought their admissions
        /// and is only now paying for them.
        let added: Int
        let method: DoorPayment
        /// What is being handed over right now, not what the record already says.
        let amountCents: Int

        var newTotal: Int { household.ticketsPurchased + added }

        /// The line the audit trail keeps. It has to survive the evening on its
        /// own: whoever reconciles the cash box next week reads this, not the
        /// screen the volunteer was looking at.
        func reason(device: String) -> String {
            var text = added > 0
                ? "Added \(added) at the door — \(method.label)"
                : "Paid at the door — \(method.label)"
            if method.collects { text += " \(Money.text(amountCents))" }
            if !device.isEmpty { text += " · \(device)" }
            return String(text.prefix(200))
        }
    }

    enum Phase: Equatable {
        case scanning
        case looking
        case found(Household)
        case confirming(Household, Int)
        case selling(Household)
        case confirmingSale(Sale)
        case sold(Sale, Household)
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

    // MARK: - Selling at the door

    func startSale(for household: Household) {
        cancelDismissal()
        Chime.shared.play(.tap)
        set(.selling(household))
    }

    func proposeSale(_ sale: Sale) {
        Chime.shared.play(.tap)
        set(.confirmingSale(sale))
    }

    func backToSale(_ household: Household) {
        set(.selling(household))
    }

    func cancelSale(_ household: Household) {
        set(.found(household))
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

    /// Sell admissions, take the money, or both.
    ///
    /// Two calls, deliberately in this order and deliberately not merged. The
    /// admissions are the thing the family is standing there for, so they go
    /// first; if the payment call then fails, the volunteer is told plainly
    /// that the tickets exist and the money is not written down yet — a state
    /// the desk can fix. The reverse order would leave a paid-up family with no
    /// admissions and no way to tell that from a family who has not paid.
    func commitSale(_ sale: Sale) {
        Task {
            var pass = sale.household

            if sale.added > 0 {
                set(.working("Adding \(sale.added)…"))
                do {
                    pass = try await backend.addTickets(
                        householdId: pass.id,
                        newTotal: sale.newTotal,
                        reason: sale.reason(device: backend.device)
                    )
                } catch let error as BackendError {
                    fail("NOTHING WAS ADDED", (error.errorDescription ?? "The change did not save.") + " Do not take their money.")
                    return
                } catch {
                    fail("NOTHING WAS ADDED", "Could not reach the server. Do not take their money — try again.")
                    return
                }
            }

            set(.working(sale.method.collects ? "Recording \(sale.method.label.lowercased())…" : "Recording the comp…"))
            do {
                pass = try await backend.recordPayment(
                    householdId: pass.id,
                    status: sale.method.wireStatus,
                    method: sale.method.wireMethod,
                    // The column is a running total, so what was collected now
                    // is added to whatever the record already carried. A comp
                    // is left alone: nothing was handed over.
                    amountPaidCents: sale.method.collects
                        ? (pass.amountPaidCents ?? 0) + sale.amountCents
                        : nil
                )
            } catch {
                if sale.added > 0 {
                    fail(
                        "PAYMENT NOT WRITTEN DOWN",
                        "The \(sale.added) admission\(sale.added == 1 ? "" : "s") WERE added, but the payment did not save. Take the money to the registration desk before they eat."
                    )
                } else {
                    fail(
                        "PAYMENT NOT WRITTEN DOWN",
                        "Nothing was changed. Send them to the registration desk."
                    )
                }
                return
            }

            Chime.shared.play(.admitted)
            land(.sold(sale, pass), dwell: successDwell, then: .found(pass))
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
    /// while the next family is already holding up a phone at it. A sale is the
    /// one result that does not end at the camera: the family who just bought
    /// admissions is still standing there waiting to use them, so `then` sends
    /// the screen back to their count instead.
    private func land(_ next: Phase, dwell: TimeInterval, then destination: Phase = .scanning) {
        set(next)
        cancelDismissal()
        dismissal = Task {
            try? await Task.sleep(nanoseconds: UInt64(dwell * 1_000_000_000))
            guard !Task.isCancelled else { return }
            set(destination)
        }
    }

    private func cancelDismissal() {
        dismissal?.cancel()
        dismissal = nil
    }
}
