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

            Text(household.ticketsRemaining <= 0 ? "NO TICKETS REMAINING" : "PASS NOT VALID")
                .font(.system(size: 26, weight: .black, design: .rounded))
                .foregroundStyle(Palette.danger)
                .multilineTextAlignment(.center)
                .padding(.top, 12)

            Text(household.ticketsRemaining <= 0
                 ? "All \(household.ticketsPurchased) admissions have already been used."
                 : "Send them to the registration desk.")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .padding(.top, 6)

            // A fully-used pass is exactly where an over-count surfaces: someone
            // arrives, finds nothing left, and says they only ate twice.
            if household.ticketsRedeemed > 0 {
                giveBackControl(max: household.ticketsRedeemed)
            }

            secondary("Back to scanner", action: onCancel)
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
