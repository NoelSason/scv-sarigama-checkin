import SwiftUI

/// The green screen.
///
/// Volunteers are trained on one sentence — "wait for the green screen, then let
/// them through" — so it takes the entire display, states the number admitted
/// large enough to read from behind the volunteer, and carries the undo for the
/// one mistake that happens often: tapping the wrong count.
struct AdmittedScreen: View {
    let receipt: ScanFlow.Receipt
    let onNext: () -> Void
    let onGiveBack: (Int) -> Void

    @State private var burst = false
    @State private var undoing = false

    var body: some View {
        ZStack {
            Palette.greenDeep.ignoresSafeArea()

            Circle()
                .fill(Palette.green.opacity(0.35))
                .frame(width: 520, height: 520)
                .blur(radius: 90)
                .scaleEffect(burst ? 1.6 : 0.6)
                .opacity(burst ? 0 : 1)

            VStack(spacing: 0) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 120, weight: .bold))
                    .foregroundStyle(.white)
                    .scaleEffect(burst ? 1 : 0.4)

                Text("\(receipt.admitted) ADMITTED")
                    .font(.system(size: 76, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
                    .monospacedDigit()
                    .padding(.top, 18)

                Text(receipt.name)
                    .font(.system(size: 30, weight: .semibold, design: .serif))
                    .foregroundStyle(.white.opacity(0.9))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)
                    .padding(.horizontal, 60)
                    .padding(.top, 8)

                HStack(spacing: 10) {
                    Text("\(receipt.remaining)")
                        .font(.system(size: 34, weight: .black, design: .rounded))
                        .monospacedDigit()
                    Text("REMAINING")
                        .font(.system(size: 18, weight: .black, design: .rounded))
                        .tracking(2)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 26)
                .padding(.vertical, 14)
                .background(Capsule().fill(.white.opacity(0.18)))
                .padding(.top, 26)

                if undoing, receipt.redemptionId != nil {
                    VStack(spacing: 12) {
                        Text("How many to give back?")
                            .font(.system(size: 20, weight: .black, design: .rounded))
                            .foregroundStyle(.white)
                        NumberGrid(upTo: receipt.admitted, tint: Palette.gold) { quantity in
                            undoing = false
                            onGiveBack(quantity)
                        }
                        .frame(width: 380)
                        Button("Cancel") { withAnimation { undoing = false } }
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                    .padding(22)
                    .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(.white.opacity(0.14)))
                    .padding(.top, 26)
                } else {
                    HStack(spacing: 14) {
                        Button(action: onNext) {
                            Text("Scan next")
                                .font(.system(size: 20, weight: .black, design: .rounded))
                                .padding(.vertical, 18)
                                .padding(.horizontal, 40)
                        }
                        .buttonStyle(SurfaceButton(tint: .white, filled: true))

                        if receipt.redemptionId != nil {
                            Button {
                                withAnimation { undoing = true }
                            } label: {
                                Text("↩ Wrong number?")
                                    .font(.system(size: 17, weight: .bold, design: .rounded))
                                    .padding(.vertical, 18)
                                    .padding(.horizontal, 26)
                            }
                            .buttonStyle(SurfaceButton(tint: .white, filled: false))
                        }
                    }
                    .frame(maxWidth: 520)
                    .padding(.top, 30)
                }
            }
        }
        .onAppear {
            withAnimation(.spring(response: 0.5, dampingFraction: 0.6)) { burst = true }
        }
    }
}

/// Admissions put back. Gold rather than green: it is a correction, and it
/// should not be mistakable for an admission when glanced at across a hall.
struct ReturnedScreen: View {
    let name: String
    let restored: Int
    let remaining: Int
    let onNext: () -> Void

    var body: some View {
        ZStack {
            Palette.goldDeep.ignoresSafeArea()

            VStack(spacing: 14) {
                Image(systemName: "arrow.uturn.backward.circle.fill")
                    .font(.system(size: 100, weight: .bold))
                    .foregroundStyle(.white)

                Text("\(restored) GIVEN BACK")
                    .font(.system(size: 64, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
                    .monospacedDigit()

                Text(name)
                    .font(.system(size: 28, weight: .semibold, design: .serif))
                    .foregroundStyle(.white.opacity(0.9))

                Text("\(remaining) REMAINING")
                    .font(.system(size: 24, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 12)
                    .background(Capsule().fill(.white.opacity(0.2)))

                Button(action: onNext) {
                    Text("Scan next")
                        .font(.system(size: 20, weight: .black, design: .rounded))
                        .padding(.vertical, 18)
                        .padding(.horizontal, 40)
                }
                .buttonStyle(SurfaceButton(tint: .white))
                .frame(maxWidth: 340)
                .padding(.top, 14)
            }
        }
    }
}

/// A door sale went through.
///
/// Deliberately neither green nor a gold flood: this is not an admission and it
/// is not an undo, and a volunteer glancing across the hall must not read it as
/// either. It states the money first, because that is the half of the
/// transaction the app cannot prove — the cash is in someone's hand, and this
/// screen is the only confirmation that it was written down.
struct SoldScreen: View {
    let sale: ScanFlow.Sale
    let household: Household
    let onContinue: () -> Void

    var body: some View {
        ZStack {
            Palette.ink.ignoresSafeArea()

            VStack(spacing: 12) {
                Image(systemName: sale.method.collects ? "checkmark.seal.fill" : "gift.fill")
                    .font(.system(size: 92, weight: .bold))
                    .foregroundStyle(Palette.gold)

                Text(sale.added > 0 ? "\(sale.added) ADDED" : "MARKED PAID")
                    .font(.system(size: 62, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
                    .monospacedDigit()

                Text(household.displayName)
                    .font(.system(size: 27, weight: .semibold, design: .serif))
                    .foregroundStyle(.white.opacity(0.85))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)
                    .padding(.horizontal, 60)

                Text(sale.method.collects
                     ? "\(Money.text(sale.amountCents)) \(sale.method.label.lowercased()) — recorded"
                     : "No charge — recorded")
                    .font(.system(size: 20, weight: .black, design: .rounded))
                    .foregroundStyle(Palette.gold)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 12)
                    .background(Capsule().fill(Palette.gold.opacity(0.15)))
                    .padding(.top, 4)

                HStack(spacing: 10) {
                    Text("\(household.ticketsRemaining)")
                        .font(.system(size: 34, weight: .black, design: .rounded))
                        .monospacedDigit()
                    Text("REMAINING")
                        .font(.system(size: 18, weight: .black, design: .rounded))
                        .tracking(2)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 26)
                .padding(.vertical, 14)
                .background(Capsule().fill(.white.opacity(0.12)))
                .padding(.top, 10)

                Button(action: onContinue) {
                    Text("Now let them in →")
                        .font(.system(size: 20, weight: .black, design: .rounded))
                        .padding(.vertical, 18)
                        .padding(.horizontal, 40)
                }
                .buttonStyle(SurfaceButton(tint: Palette.gold))
                .frame(maxWidth: 420)
                .padding(.top, 18)
            }
        }
    }
}

/// Refused. States what happened to the tickets first — a volunteer's next
/// question is always "did that go through?" and the answer is always no.
struct RefusedScreen: View {
    let title: String
    let detail: String
    let onNext: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.82).ignoresSafeArea()

            VStack(spacing: 18) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 86, weight: .bold))
                    .foregroundStyle(Palette.danger)

                Text(title)
                    .font(.system(size: 52, weight: .black, design: .rounded))
                    .foregroundStyle(Palette.danger)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.6)

                Text(detail)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 620)

                Button(action: onNext) {
                    Text("Back to scanner")
                        .font(.system(size: 19, weight: .black, design: .rounded))
                        .padding(.vertical, 18)
                        .padding(.horizontal, 36)
                }
                .buttonStyle(SurfaceButton(tint: .white, filled: false))
                .frame(maxWidth: 360)
                .padding(.top, 10)
            }
            .padding(50)
            .glass(radius: 34)
            .frame(maxWidth: 760)
        }
    }
}
