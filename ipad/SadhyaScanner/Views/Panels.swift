import SwiftUI

/// Something is in flight. Says which thing, because "loading" next to a family
/// waiting to eat is not an answer.
struct WorkingPanel: View {
    let text: String

    var body: some View {
        VStack(spacing: 18) {
            ProgressView()
                .controlSize(.large)
                .tint(Palette.gold)
            Text(text)
                .font(.system(size: 22, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
            Text("Wait for the green screen.")
                .font(.system(size: 16))
                .foregroundStyle(.white.opacity(0.55))
        }
        .frame(maxWidth: .infinity)
        .padding(40)
        .glass()
    }
}

/// The pass, and the one question that decides how many admissions leave it.
struct CountPanel: View {
    let household: Household
    let onChoose: (Int) -> Void
    let onGiveBack: (Int) -> Void
    let onSell: () -> Void
    let onCancel: () -> Void

    @State private var givingBack = false

    var body: some View {
        // Scrollable because the grid now grows to twelve tiles: on a shorter
        // iPad in landscape that is taller than the panel, and a number a
        // volunteer cannot reach is the bug this whole change is fixing.
        // `.basedOnSize` keeps it feeling fixed whenever it does fit.
        ScrollView {
            VStack(spacing: 0) {
                if household.usable && household.ticketsRemaining > 0 {
                    usablePass
                } else {
                    blockedPass
                }
            }
            .padding(30)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxWidth: .infinity)
        .glass()
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(
                    (household.usable && household.ticketsRemaining > 0 ? Palette.green : Palette.danger).opacity(0.65),
                    lineWidth: 2
                )
        )
    }

    private var usablePass: some View {
        VStack(spacing: 0) {
            header

            PriorScans(scans: household.recentScans ?? [])

            Text("\(household.ticketsRemaining)")
                .font(.system(size: 96, weight: .black, design: .rounded))
                .foregroundStyle(Palette.green)
                .monospacedDigit()
                .padding(.top, 14)
            Eyebrow(text: "REMAINING")

            Text("HOW MANY ARE ENTERING?")
                .font(.system(size: 21, weight: .black, design: .rounded))
                .foregroundStyle(.white)
                .padding(.top, 26)

            // The rule that costs the event money when it is missed, printed
            // where the number is chosen rather than in a help page.
            Text("Count every child 6 and older. Under 6 eat free.")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(Palette.gold)
                .multilineTextAlignment(.center)
                .padding(.top, 4)

            // Twelve, not six. A household of ten arrives as ten people, and a
            // grid that stops at six makes the common case the awkward one.
            NumberGrid(upTo: min(household.ticketsRemaining, 12), tint: Palette.green, action: onChoose)
                .padding(.top, 16)

            // Above twelve is rare enough to type. It still has to be reachable.
            if household.ticketsRemaining > 12 {
                CustomCount(limit: household.ticketsRemaining, action: onChoose)
                    .padding(.top, 12)
            }

            sellControl

            if household.ticketsRedeemed > 0 {
                giveBackControl(max: household.ticketsRedeemed)
            }

            secondary("Cancel", action: onCancel)
        }
    }

    private var blockedPass: some View {
        VStack(spacing: 0) {
            header

            Image(systemName: "xmark.octagon.fill")
                .font(.system(size: 54))
                .foregroundStyle(Palette.danger)
                .padding(.top, 20)

            Text(blockedTitle)
                .font(.system(size: 26, weight: .black, design: .rounded))
                .foregroundStyle(Palette.danger)
                .multilineTextAlignment(.center)
                .padding(.top, 12)

            Text(blockedDetail)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .padding(.top, 6)

            PriorScans(scans: household.recentScans ?? [])

            sellControl

            // A fully-used pass is exactly where an over-count surfaces: someone
            // arrives, finds nothing left, and says they only ate twice.
            if household.ticketsRedeemed > 0 {
                giveBackControl(max: household.ticketsRedeemed)
            }

            secondary("Back to scanner", action: onCancel)
        }
    }

    /// Which of the two blocking reasons this is. They lead to different next
    /// steps now that the door can take money, so they can no longer share one
    /// "send them to the desk".
    private var blockedTitle: String {
        if !household.passEnabled { return "PASS NOT VALID" }
        if !household.settled { return "NOT PAID YET" }
        return "NO TICKETS REMAINING"
    }

    private var blockedDetail: String {
        if !household.passEnabled { return "Send them to the registration desk." }
        if !household.settled { return "Take the payment here, then let them in." }
        return "All \(household.ticketsPurchased) admissions have already been used."
    }

    /// A pass tops out at fifty admissions, so the door cannot offer more than
    /// the gap between what was bought and that ceiling.
    private var roomToAdd: Int { max(0, 50 - household.ticketsPurchased) }

    /// Adding admissions or taking money is only ever worth offering on a pass
    /// that is otherwise alive. A disabled pass is a desk problem, and money
    /// taken against one buys the family nothing.
    @ViewBuilder
    private var sellControl: some View {
        if household.passEnabled && (roomToAdd > 0 || !household.settled) {
            Button(action: onSell) {
                VStack(spacing: 3) {
                    Text(household.settled ? "＋ Add admissions" : "＋ Add admissions or take payment")
                        .font(.system(size: 18, weight: .black, design: .rounded))
                    Text("You collect the money — this writes it down.")
                        .font(.system(size: 13, weight: .semibold))
                        .opacity(0.7)
                }
                .padding(.vertical, 15)
            }
            .buttonStyle(SurfaceButton(tint: Palette.gold, filled: !household.settled))
            .padding(.top, 18)
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Text(household.displayName)
                .font(.system(size: 30, weight: .heavy, design: .serif))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.6)
                .lineLimit(2)

            HStack(spacing: 10) {
                StatusChip(label: household.statusLabel, ok: household.usable)
                Text("\(household.ticketsPurchased) bought · \(household.ticketsRedeemed) used")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.55))
            }
        }
    }

    @ViewBuilder
    private func giveBackControl(max: Int) -> some View {
        if givingBack {
            VStack(spacing: 12) {
                Text("How many to give back?")
                    .font(.system(size: 18, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
                Text("\(max) used so far")
                    .font(.system(size: 14))
                    .foregroundStyle(.white.opacity(0.5))
                NumberGrid(upTo: Swift.min(max, 12), tint: Palette.gold) { quantity in
                    givingBack = false
                    onGiveBack(quantity)
                }
                Button("Cancel") { withAnimation { givingBack = false } }
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.6))
            }
            .padding(18)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Palette.gold.opacity(0.10))
            )
            .padding(.top, 18)
        } else {
            // Kept behind a tap on purpose: "give back" a thumb's width from
            // "how many are entering" is how free meals get handed out.
            Button {
                withAnimation { givingBack = true }
            } label: {
                Text("↩ Counted wrong earlier? Give back (\(max) used)")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Palette.gold)
                    .padding(.top, 18)
            }
        }
    }

    private func secondary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 17, weight: .bold, design: .rounded))
                .padding(.vertical, 14)
        }
        .buttonStyle(SurfaceButton(tint: .white.opacity(0.85), filled: false))
        .padding(.top, 18)
    }
}

/// When this pass was used before.
///
/// "3 used" says a family has eaten; it does not say whether that was an hour
/// ago at the other door or ninety seconds ago at this one — and the second is a
/// phone being handed back down the queue. The time is what turns a number into
/// a question worth asking, so it sits with the count rather than in a history
/// screen nobody opens with a line waiting.
///
/// Draws nothing on a pass nobody has used, so the ordinary scan stays a name
/// and a row of numbers.
struct PriorScans: View {
    let scans: [ScanMark]

    var body: some View {
        if let latest = scans.first {
            VStack(alignment: .leading, spacing: 4) {
                Text("⏱ SCANNED BEFORE")
                    .font(.system(size: 13, weight: .black, design: .rounded))
                    .kerning(1.2)
                    .foregroundStyle(Palette.gold)

                HStack(spacing: 6) {
                    Text("\(latest.quantity) admitted at \(latest.timeLabel)")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                    if let ago = latest.agoLabel() {
                        Text("· \(ago)")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.6))
                    }
                }

                if let device = latest.device, !device.isEmpty {
                    Text("at \(device)")
                        .font(.system(size: 14))
                        .foregroundStyle(.white.opacity(0.5))
                }

                // Earlier sittings, if any. Listed plainly — the volunteer is
                // reading them out to the family standing there.
                ForEach(Array(scans.dropFirst().enumerated()), id: \.offset) { _, scan in
                    Text("\(scan.quantity) at \(scan.timeLabel)" + (scan.device.map { " · \($0)" } ?? ""))
                        .font(.system(size: 14))
                        .foregroundStyle(.white.opacity(0.5))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Palette.gold.opacity(0.12))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Palette.gold.opacity(0.5), lineWidth: 1.5)
            )
            .padding(.top, 18)
        }
    }
}

/// The age check, and the last stop before admissions are consumed.
///
/// It exists for two reasons: "the kids are free" is true right up until a child
/// turns six, and a fat-thumbed 6 on the previous screen would otherwise go
/// straight through. The count and the rule have to be read together.
struct ConfirmPanel: View {
    let household: Household
    let quantity: Int
    let onAdmit: () -> Void
    let onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Eyebrow(text: "ADMITTING")

            Text("\(quantity)")
                .font(.system(size: 120, weight: .black, design: .rounded))
                .foregroundStyle(Palette.gold)
                .monospacedDigit()

            Text(household.displayName)
                .font(.system(size: 22, weight: .heavy, design: .serif))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.7)

            // Repeated from the keypad on purpose: this is the screen where the
            // admissions actually leave the pass, and a family that already ate
            // is the one case where the number in front of the volunteer
            // deserves a second look.
            if let last = household.lastScan {
                Text(
                    "Already scanned at \(last.timeLabel)"
                    + (last.agoLabel().map { " · \($0)" } ?? "")
                    + " — \(last.quantity) admitted then."
                )
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(Palette.gold)
                .multilineTextAlignment(.center)
                .padding(.top, 10)
            }

            VStack(spacing: 8) {
                Text("Any children with them?")
                    .font(.system(size: 20, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
                Text("Every child 6 and older needs an admission. Only under 6 eat free.")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.75))
                    .multilineTextAlignment(.center)

                if household.childrenUnder6 > 0 {
                    Text("This family registered \(household.childrenUnder6) child\(household.childrenUnder6 == 1 ? "" : "ren") under 6. Check they are still under 6.")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Palette.gold)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(18)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Palette.gold.opacity(0.12))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(Palette.gold.opacity(0.5), lineWidth: 1.5)
            )
            .padding(.top, 22)

            Button(action: onAdmit) {
                Text("Yes — admit \(quantity)")
                    .font(.system(size: 24, weight: .black, design: .rounded))
                    .padding(.vertical, 22)
            }
            .buttonStyle(SurfaceButton(tint: Palette.green))
            .foregroundStyle(.white)
            .padding(.top, 22)

            Button(action: onBack) {
                Text("Change the number")
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .padding(.vertical, 14)
            }
            .buttonStyle(SurfaceButton(tint: .white.opacity(0.85), filled: false))
            .padding(.top, 12)
        }
        .padding(30)
        .frame(maxWidth: .infinity)
        .glass()
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(Palette.gold.opacity(0.7), lineWidth: 2)
        )
    }
}

/// Selling at the door: how many more they want, and how they are paying.
///
/// The app never touches the money. A volunteer takes cash, watches a Zelle
/// land, or runs a card on the desk reader, and this panel is the record of it
/// — which is why the confirmation is worded as "collect it, then tap", not as
/// a checkout.
struct SellPanel: View {
    let household: Household
    let onReview: (Int, DoorPayment, Int) -> Void
    let onCancel: () -> Void

    /// Typed once per event and remembered, because the price is the same for
    /// every family who walks up and nobody should retype it at a queue.
    @AppStorage("sadhya.door.priceCents") private var priceCents: Int = 3000

    @State private var added: Int?
    @State private var collected: Int?
    @State private var editingPrice = false
    @State private var editingAmount = false

    private var roomToAdd: Int { max(0, 50 - household.ticketsPurchased) }

    /// What to ask for, before anyone overrides it. For a family buying more it
    /// is the new admissions; for one who bought already and never paid it is
    /// whatever is still outstanding on the pass.
    private var suggestedCents: Int {
        guard let added else { return 0 }
        if added > 0 { return added * priceCents }
        return max(0, household.ticketsPurchased * priceCents - (household.amountPaidCents ?? 0))
    }

    private var amountCents: Int { collected ?? suggestedCents }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                header
                if added == nil {
                    countStep
                } else {
                    methodStep
                }
            }
            .padding(30)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxWidth: .infinity)
        .glass()
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(Palette.gold.opacity(0.7), lineWidth: 2)
        )
        // A pass already at the fifty-admission ceiling has nothing to sell, so
        // the only thing left to do with it is take the money.
        .onAppear { if roomToAdd == 0 { added = 0 } }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Eyebrow(text: "AT THE DOOR")

            Text(household.displayName)
                .font(.system(size: 28, weight: .heavy, design: .serif))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.6)
                .lineLimit(2)

            Text("\(household.ticketsPurchased) bought · \(household.ticketsRedeemed) used · \(household.statusLabel)")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white.opacity(0.55))
        }
    }

    // MARK: - Step one: how many

    private var countStep: some View {
        VStack(spacing: 0) {
            Text("HOW MANY MORE ARE THEY BUYING?")
                .font(.system(size: 20, weight: .black, design: .rounded))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .padding(.top, 24)

            priceLine

            NumberGrid(upTo: min(roomToAdd, 12), tint: Palette.gold) { count in
                collected = nil
                withAnimation { added = count }
            }
            .padding(.top, 14)

            if roomToAdd > 12 {
                CustomCount(limit: roomToAdd) { count in
                    collected = nil
                    withAnimation { added = count }
                }
                .padding(.top, 12)
            }

            // The other half of this panel: a family who bought online, never
            // paid, and is settling up at the door without adding anyone.
            if !household.settled {
                Button {
                    collected = nil
                    withAnimation { added = 0 }
                } label: {
                    Text("They're not buying more — just paying")
                        .font(.system(size: 16, weight: .bold, design: .rounded))
                        .padding(.vertical, 14)
                }
                .buttonStyle(SurfaceButton(tint: Palette.gold, filled: false))
                .padding(.top, 14)
            }

            secondary("Cancel", action: onCancel)
        }
    }

    @ViewBuilder
    private var priceLine: some View {
        if editingPrice {
            MoneyField(
                title: "Price per admission",
                cents: priceCents,
                onCancel: { withAnimation { editingPrice = false } },
                onSet: { value in
                    priceCents = value
                    collected = nil
                    withAnimation { editingPrice = false }
                }
            )
            .padding(.top, 12)
        } else {
            Button {
                withAnimation { editingPrice = true }
            } label: {
                Text("\(Money.text(priceCents)) each · change")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Palette.gold)
                    .padding(.top, 8)
            }
        }
    }

    // MARK: - Step two: how they are paying

    private var methodStep: some View {
        VStack(spacing: 0) {
            Text(amountCents > 0 ? "COLLECT" : "NOTHING TO COLLECT")
                .font(.system(size: 15, weight: .black, design: .rounded))
                .tracking(2.4)
                .foregroundStyle(.white.opacity(0.55))
                .padding(.top, 24)

            Text(Money.text(amountCents))
                .font(.system(size: 78, weight: .black, design: .rounded))
                .foregroundStyle(Palette.gold)
                .monospacedDigit()
                .minimumScaleFactor(0.5)
                .lineLimit(1)

            Text(sellSummary)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))
                .multilineTextAlignment(.center)

            amountLine

            Text("HOW ARE THEY PAYING?")
                .font(.system(size: 20, weight: .black, design: .rounded))
                .foregroundStyle(.white)
                .padding(.top, 24)

            methodGrid
                .padding(.top, 12)

            if roomToAdd > 0 {
                secondary("Change the number") {
                    withAnimation {
                        added = nil
                        collected = nil
                    }
                }
            }

            Button("Cancel") { onCancel() }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white.opacity(0.6))
                .padding(.top, 14)
        }
    }

    private var sellSummary: String {
        guard let added else { return "" }
        if added > 0 {
            return "\(added) more admission\(added == 1 ? "" : "s") · \(household.ticketsPurchased) → \(household.ticketsPurchased + added)"
        }
        return "For the \(household.ticketsPurchased) admission\(household.ticketsPurchased == 1 ? "" : "s") they already have"
    }

    @ViewBuilder
    private var amountLine: some View {
        if editingAmount {
            MoneyField(
                title: "Amount being handed over",
                cents: amountCents,
                onCancel: { withAnimation { editingAmount = false } },
                onSet: { value in
                    collected = value
                    withAnimation { editingAmount = false }
                }
            )
            .padding(.top, 14)
        } else {
            Button {
                withAnimation { editingAmount = true }
            } label: {
                Text("Paying a different amount? Change it")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(Palette.gold)
                    .padding(.top, 10)
            }
        }
    }

    private var methodGrid: some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)],
            spacing: 10
        ) {
            ForEach(DoorPayment.allCases) { method in
                Button {
                    onReview(added ?? 0, method, method.collects ? amountCents : 0)
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: method.symbol)
                            .font(.system(size: 24, weight: .semibold))
                        Text(method.label)
                            .font(.system(size: 19, weight: .black, design: .rounded))
                        Text(method.detail)
                            .font(.system(size: 12, weight: .semibold))
                            .opacity(0.7)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.vertical, 16)
                    .padding(.horizontal, 6)
                }
                .buttonStyle(SurfaceButton(
                    tint: method.collects ? Palette.gold : .white.opacity(0.85),
                    filled: false
                ))
            }
        }
    }

    private func secondary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 17, weight: .bold, design: .rounded))
                .padding(.vertical, 14)
        }
        .buttonStyle(SurfaceButton(tint: .white.opacity(0.85), filled: false))
        .padding(.top, 18)
    }
}

/// The last stop before a sale is written down.
///
/// It repeats the amount rather than the tickets, because the amount is the
/// part that cannot be corrected by tapping something on this iPad — the money
/// is in a box, and getting it back out is a conversation.
struct SellConfirmPanel: View {
    let sale: ScanFlow.Sale
    let onCommit: () -> Void
    let onBack: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Eyebrow(text: sale.method.collects ? "TAKE THIS NOW" : "NO CHARGE")

            Text(sale.method.collects ? Money.text(sale.amountCents) : sale.method.label)
                .font(.system(size: 96, weight: .black, design: .rounded))
                .foregroundStyle(Palette.gold)
                .monospacedDigit()
                .minimumScaleFactor(0.5)
                .lineLimit(1)

            Text(sale.method.collects ? "in \(sale.method.label.lowercased())" : "nothing to collect")
                .font(.system(size: 19, weight: .bold, design: .rounded))
                .foregroundStyle(.white.opacity(0.75))

            Text(sale.household.displayName)
                .font(.system(size: 22, weight: .heavy, design: .serif))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
                .padding(.top, 14)

            VStack(spacing: 8) {
                if sale.added > 0 {
                    Text("\(sale.household.ticketsPurchased) → \(sale.newTotal) admissions")
                        .font(.system(size: 22, weight: .black, design: .rounded))
                        .foregroundStyle(.white)
                        .monospacedDigit()
                } else {
                    Text("Marks this pass paid")
                        .font(.system(size: 22, weight: .black, design: .rounded))
                        .foregroundStyle(.white)
                }

                Text("The app does not take the money. Collect it first, then tap below.")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.75))
                    .multilineTextAlignment(.center)
            }
            .padding(18)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Palette.gold.opacity(0.12))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(Palette.gold.opacity(0.5), lineWidth: 1.5)
            )
            .padding(.top, 18)

            Button(action: onCommit) {
                Text(sale.method.collects ? "Got it — write it down" : "Comp them")
                    .font(.system(size: 23, weight: .black, design: .rounded))
                    .padding(.vertical, 22)
            }
            .buttonStyle(SurfaceButton(tint: Palette.green))
            .foregroundStyle(.white)
            .padding(.top, 20)

            Button(action: onBack) {
                Text("Go back")
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .padding(.vertical, 14)
            }
            .buttonStyle(SurfaceButton(tint: .white.opacity(0.85), filled: false))
            .padding(.top, 12)
        }
        .padding(30)
        .frame(maxWidth: .infinity)
        .glass()
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(Palette.gold.opacity(0.7), lineWidth: 2)
        )
    }
}

/// A dollar amount, typed. Whole dollars only — nobody is handing over change
/// at a food line, and a decimal point is one more thing to fat-thumb.
struct MoneyField: View {
    let title: String
    let cents: Int
    let onCancel: () -> Void
    let onSet: (Int) -> Void

    @State private var typed = ""

    private var value: Int? {
        guard let dollars = Int(typed), dollars >= 0, dollars <= 10_000 else { return nil }
        return dollars * 100
    }

    var body: some View {
        VStack(spacing: 10) {
            Text(title)
                .font(.system(size: 15, weight: .black, design: .rounded))
                .foregroundStyle(.white.opacity(0.75))

            HStack(spacing: 10) {
                TextField("$", text: $typed)
                    .keyboardType(.numberPad)
                    .font(.system(size: 24, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
                    .monospacedDigit()
                    .multilineTextAlignment(.center)
                    .padding(.vertical, 14)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.white.opacity(0.07)))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(Palette.gold.opacity(0.5), lineWidth: 1.5)
                    )
                    .onChange(of: typed) { _, new in
                        let digits = new.filter(\.isNumber)
                        if digits != new { typed = digits }
                    }

                Button {
                    if let value { onSet(value) }
                } label: {
                    Text("Set")
                        .font(.system(size: 18, weight: .black, design: .rounded))
                        .padding(.vertical, 16)
                        .padding(.horizontal, 8)
                }
                .buttonStyle(SurfaceButton(tint: Palette.gold))
                .frame(width: 92)
                .disabled(value == nil)
                .opacity(value == nil ? 0.4 : 1)
            }

            Button("Cancel", action: onCancel)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white.opacity(0.6))
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Palette.gold.opacity(0.10))
        )
        .onAppear { typed = cents % 100 == 0 ? String(cents / 100) : "" }
    }
}

/// Big square number tiles — the only control a volunteer uses all evening.
struct NumberGrid: View {
    let upTo: Int
    var tint: Color = Palette.green
    let action: (Int) -> Void

    private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            // Never offer a number that would be refused: the grid stops at what
            // the pass actually has left.
            ForEach(1...Swift.max(upTo, 1), id: \.self) { number in
                Button {
                    action(number)
                } label: {
                    Text("\(number)")
                        .font(.system(size: 36, weight: .black, design: .rounded))
                        .monospacedDigit()
                        .padding(.vertical, 22)
                }
                .buttonStyle(SurfaceButton(tint: tint))
                .foregroundStyle(.white)
            }
        }
    }
}

/// Typed count, for the household too large for the grid.
struct CustomCount: View {
    let limit: Int
    let action: (Int) -> Void

    @State private var typed = ""

    private var value: Int? {
        guard let number = Int(typed), number >= 1, number <= limit else { return nil }
        return number
    }

    var body: some View {
        HStack(spacing: 10) {
            TextField("Other (up to \(limit))", text: $typed)
                .keyboardType(.numberPad)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .monospacedDigit()
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.white.opacity(0.07)))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(Palette.green.opacity(0.5), lineWidth: 1.5)
                )
                // Digits only: the count goes straight into a redeem call, and
                // anything the keypad lets through that is not a number would
                // arrive at the server as a refusal a volunteer has to decode.
                .onChange(of: typed) { _, new in
                    let digits = new.filter(\.isNumber)
                    if digits != new { typed = digits }
                }

            Button {
                if let value {
                    action(value)
                    typed = ""
                }
            } label: {
                Text("Go")
                    .font(.system(size: 19, weight: .black, design: .rounded))
                    .padding(.vertical, 16)
                    .padding(.horizontal, 8)
            }
            .buttonStyle(SurfaceButton(tint: Palette.green))
            .foregroundStyle(.white)
            .frame(width: 96)
            .disabled(value == nil)
            .opacity(value == nil ? 0.4 : 1)
        }
    }
}

struct StatusChip: View {
    let label: String
    let ok: Bool

    var body: some View {
        Text(label)
            .font(.system(size: 12, weight: .black, design: .rounded))
            .tracking(1.4)
            .foregroundStyle(ok ? Palette.ink : .white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().fill(ok ? Palette.green : Palette.danger))
    }
}
