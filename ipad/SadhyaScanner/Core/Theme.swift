import SwiftUI

/// The scanner runs with a live camera behind everything, in a hall that is
/// usually dim and always crowded. So the palette is built for a dark screen:
/// near-black ground the video can sit under, gold for anything the eye should
/// land on, and one unmistakable colour each for admitted and refused.
enum Palette {
    static let ink = Color(red: 0.035, green: 0.055, blue: 0.050)
    static let inkSoft = Color(red: 0.070, green: 0.105, blue: 0.095)
    static let gold = Color(red: 0.933, green: 0.749, blue: 0.322)
    static let goldDeep = Color(red: 0.780, green: 0.570, blue: 0.130)
    static let green = Color(red: 0.160, green: 0.720, blue: 0.450)
    static let greenDeep = Color(red: 0.050, green: 0.360, blue: 0.240)
    static let danger = Color(red: 0.930, green: 0.280, blue: 0.280)
}

/// Slow-drifting light behind the glass panels.
///
/// Purely decorative, and deliberately slow: anything faster reads as motion in
/// the corner of the eye, and a volunteer watching a food line does not need a
/// second thing moving on the screen.
struct Aurora: View {
    @State private var drift = false

    var body: some View {
        ZStack {
            Palette.ink
            blob(Palette.greenDeep, size: 620)
                .offset(x: drift ? -160 : 120, y: drift ? -220 : -80)
            blob(Palette.goldDeep.opacity(0.75), size: 520)
                .offset(x: drift ? 220 : -60, y: drift ? 240 : 140)
        }
        .ignoresSafeArea()
        .onAppear {
            withAnimation(.easeInOut(duration: 14).repeatForever(autoreverses: true)) {
                drift = true
            }
        }
    }

    private func blob(_ colour: Color, size: CGFloat) -> some View {
        Circle()
            .fill(colour)
            .frame(width: size, height: size)
            .blur(radius: 140)
            .opacity(0.55)
    }
}

extension View {
    /// The one surface treatment in the app: frosted, hairline-edged, lifted.
    func glass(radius: CGFloat = 28) -> some View {
        background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.13), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.45), radius: 30, y: 16)
    }
}

/// Everything tappable presses in slightly and springs back.
///
/// It is the only confirmation a volunteer gets that a tap landed while the
/// network call is still in flight, and on a tablet held at arm's length that
/// matters more than it does on a phone.
struct SurfaceButton: ButtonStyle {
    var tint: Color = Palette.gold
    var filled = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(filled ? tint : Color.white.opacity(0.07))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(filled ? .clear : tint.opacity(0.55), lineWidth: 1.5)
            )
            .foregroundStyle(filled ? Palette.ink : tint)
            .scaleEffect(configuration.isPressed ? 0.955 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.6), value: configuration.isPressed)
    }
}

/// Small all-caps label used above every number in the app.
struct Eyebrow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 13, weight: .black, design: .rounded))
            .tracking(2.4)
            .foregroundStyle(.white.opacity(0.55))
    }
}
