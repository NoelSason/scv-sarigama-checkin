import SwiftUI

/// The door.
///
/// The camera is the screen — panels sit over it as glass rather than replacing
/// it, so a volunteer never loses sight of what they are pointing at, and the
/// next guest can already be lining up their phone while the current one is
/// being admitted.
struct ScanView: View {
    @EnvironmentObject private var backend: Backend
    @StateObject private var camera = CameraController()
    @StateObject private var flow = ScanFlow()

    @State private var ripples: [Ripple] = []
    @State private var searching = false

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                cameraLayer(in: geometry.size)

                VStack(spacing: 0) {
                    TopBar(
                        station: backend.device,
                        live: camera.isRunning,
                        onSearch: { searching = true },
                        onSignOut: { backend.signOut() }
                    )
                    Spacer()
                }

                sidePanel(width: min(520, max(360, geometry.size.width * 0.42)))

                fullScreenResult
            }
        }
        .ignoresSafeArea()
        .sheet(isPresented: $searching) {
            SearchSheet { household in
                searching = false
                flow.pick(household)
            }
        }
        .onAppear {
            camera.onScan = { payload in flow.scanned(payload) }
            camera.start()
        }
        .onChange(of: flow.phase) { _, phase in
            // One switch controls whether the decoder is allowed to report at
            // all. Everything on screen follows from it.
            camera.paused = !phase.isIdle
        }
    }

    // MARK: - Camera surface

    private func cameraLayer(in size: CGSize) -> some View {
        ZStack {
            switch camera.access {
            case .granted:
                CameraSurface(controller: camera)
                    .overlay(vignette)
                    .overlay(sightingMarks)
                    .overlay(reticle)
                    .overlay(rippleMarks)
                    .gesture(
                        SpatialTapGesture().onEnded { tap in
                            self.camera.focus(atLayerPoint: tap.location)
                            Chime.shared.play(.tap)
                            addRipple(at: tap.location)
                        }
                    )
            case .denied, .unavailable:
                CameraTrouble(denied: camera.access == .denied)
            case .unknown:
                Color.clear
            }
        }
        .frame(width: size.width, height: size.height)
        .background(Palette.ink)
    }

    private var vignette: some View {
        // Darkened top-to-bottom so white text stays readable over whatever the
        // camera happens to be looking at, which at a food line is frequently a
        // bright window.
        LinearGradient(
            colors: [.black.opacity(0.62), .black.opacity(0.1), .black.opacity(0.55)],
            startPoint: .top,
            endPoint: .bottom
        )
        .allowsHitTesting(false)
    }

    /// A frame drawn on every code in view.
    ///
    /// With one code it is confirmation. With two it is the whole interaction:
    /// the app will not guess which phone belongs to the family in front of the
    /// volunteer, so both get a frame and one gets tapped.
    private var sightingMarks: some View {
        ZStack {
            ForEach(camera.sightings) { sighting in
                let ambiguous = camera.sightings.count > 1
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(ambiguous ? Palette.gold : Palette.green, lineWidth: 4)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill((ambiguous ? Palette.gold : Palette.green).opacity(0.18))
                    )
                    .frame(width: sighting.rect.width, height: sighting.rect.height)
                    .position(x: sighting.rect.midX, y: sighting.rect.midY)
                    .shadow(color: (ambiguous ? Palette.gold : Palette.green).opacity(0.7), radius: 18)
                    .overlay(alignment: .center) {
                        if ambiguous {
                            Text("TAP TO PICK")
                                .font(.system(size: 13, weight: .black, design: .rounded))
                                .tracking(1.4)
                                .foregroundStyle(Palette.ink)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(Capsule().fill(Palette.gold))
                                .position(x: sighting.rect.midX, y: sighting.rect.maxY + 22)
                        }
                    }
                    .onTapGesture { camera.choose(sighting.id) }
                    .animation(.spring(response: 0.25, dampingFraction: 0.75), value: sighting.rect)
            }
        }
        .allowsHitTesting(camera.sightings.count > 1)
    }

    private var reticle: some View {
        Group {
            if flow.phase.isIdle && camera.sightings.isEmpty && camera.isRunning {
                Reticle()
                    .transition(.opacity.combined(with: .scale(scale: 0.94)))
            }
        }
        .allowsHitTesting(false)
        .animation(.easeInOut(duration: 0.25), value: camera.sightings.isEmpty)
    }

    private var rippleMarks: some View {
        ZStack {
            ForEach(ripples) { ripple in
                RippleMark(point: ripple.point) {
                    ripples.removeAll { $0.id == ripple.id }
                }
            }
        }
        .allowsHitTesting(false)
    }

    private func addRipple(at point: CGPoint) {
        ripples.append(Ripple(point: point))
    }

    // MARK: - Panels

    @ViewBuilder
    private func sidePanel(width: CGFloat) -> some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)

            Group {
                switch flow.phase {
                case .looking:
                    WorkingPanel(text: "Looking up pass…")

                case .working(let label):
                    WorkingPanel(text: label)

                case .found(let household):
                    CountPanel(
                        household: household,
                        onChoose: { flow.propose($0, for: household) },
                        onGiveBack: { flow.giveBack(household: household, quantity: $0) },
                        onCancel: { flow.reset() }
                    )

                case .confirming(let household, let quantity):
                    ConfirmPanel(
                        household: household,
                        quantity: quantity,
                        onAdmit: { flow.admit(quantity, for: household) },
                        onBack: { flow.backToCount(household) }
                    )

                default:
                    EmptyView()
                }
            }
            .frame(width: width)
            .padding(.trailing, 26)
            .padding(.vertical, 92)
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
    }

    /// Outcomes take the whole screen.
    ///
    /// A result shown in a corner gets missed, and "wait for the green screen"
    /// only works as a rule if the green screen is impossible to miss.
    @ViewBuilder
    private var fullScreenResult: some View {
        switch flow.phase {
        case .admitted(let receipt):
            AdmittedScreen(
                receipt: receipt,
                onNext: { flow.reset() },
                onGiveBack: { quantity in
                    guard let id = receipt.redemptionId else { return }
                    flow.giveBack(redemptionId: id, quantity: quantity, name: receipt.name)
                }
            )
            .transition(.opacity.combined(with: .scale(scale: 1.04)))

        case .returned(let name, let restored, let remaining):
            ReturnedScreen(name: name, restored: restored, remaining: remaining) { flow.reset() }
                .transition(.opacity)

        case .failure(let title, let detail):
            RefusedScreen(title: title, detail: detail) { flow.reset() }
                .transition(.opacity)

        default:
            EmptyView()
        }
    }
}

// MARK: - Pieces

struct Ripple: Identifiable {
    let id = UUID()
    let point: CGPoint
}

/// Expanding ring under a finger. Confirms the tap landed on the picture rather
/// than on nothing, which on a full-bleed camera view is otherwise unknowable.
private struct RippleMark: View {
    let point: CGPoint
    let done: () -> Void

    @State private var grown = false

    var body: some View {
        Circle()
            .strokeBorder(Palette.gold.opacity(grown ? 0 : 0.9), lineWidth: grown ? 1 : 3)
            .frame(width: grown ? 180 : 30, height: grown ? 180 : 30)
            .position(point)
            .onAppear {
                withAnimation(.easeOut(duration: 0.55)) { grown = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: done)
            }
    }
}

/// Corner brackets and a sweeping line — where to hold the phone.
private struct Reticle: View {
    @State private var sweep = false
    private let side: CGFloat = 320

    var body: some View {
        ZStack {
            ForEach(0..<4, id: \.self) { corner in
                Bracket()
                    .stroke(Palette.gold, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .frame(width: 54, height: 54)
                    .rotationEffect(.degrees(Double(corner) * 90))
                    .offset(
                        x: (corner == 0 || corner == 3 ? -1 : 1) * (side / 2 - 27),
                        y: (corner < 2 ? -1 : 1) * (side / 2 - 27)
                    )
            }

            Rectangle()
                .fill(
                    LinearGradient(
                        colors: [.clear, Palette.gold.opacity(0.85), .clear],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(width: side - 24, height: 2.5)
                .offset(y: sweep ? side / 2 - 30 : -side / 2 + 30)
                .shadow(color: Palette.gold.opacity(0.8), radius: 10)
        }
        .frame(width: side, height: side)
        .onAppear {
            withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
                sweep = true
            }
        }
    }
}

private struct Bracket: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let radius: CGFloat = 18
        path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + radius))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + radius, y: rect.minY),
            control: CGPoint(x: rect.minX, y: rect.minY)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        return path
    }
}

private struct TopBar: View {
    let station: String
    let live: Bool
    let onSearch: () -> Void
    let onSignOut: () -> Void

    var body: some View {
        HStack(spacing: 18) {
            Lamp(scale: 0.42)

            VStack(alignment: .leading, spacing: 2) {
                Text("SADHYA SCANNER")
                    .font(.system(size: 15, weight: .black, design: .rounded))
                    .tracking(2.6)
                    .foregroundStyle(.white)
                Text(station)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.5))
            }

            Spacer()

            HStack(spacing: 8) {
                Circle()
                    .fill(live ? Palette.green : Palette.danger)
                    .frame(width: 9, height: 9)
                Text(live ? "CAMERA LIVE" : "CAMERA OFF")
                    .font(.system(size: 12, weight: .black, design: .rounded))
                    .tracking(1.6)
                    .foregroundStyle(.white.opacity(0.7))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Capsule().fill(.ultraThinMaterial))

            barButton("magnifyingglass", action: onSearch)
            barButton("rectangle.portrait.and.arrow.right", action: onSignOut)
        }
        .padding(.horizontal, 26)
        .padding(.top, 22)
        .padding(.bottom, 16)
    }

    private func barButton(_ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))
                .frame(width: 46, height: 46)
                .background(Circle().fill(.ultraThinMaterial))
        }
    }
}

private struct CameraTrouble: View {
    let denied: Bool

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "video.slash.fill")
                .font(.system(size: 54))
                .foregroundStyle(Palette.danger)
            Text(denied ? "Camera blocked" : "Camera unavailable")
                .font(.system(size: 30, weight: .heavy))
                .foregroundStyle(.white)
            Text(denied
                 ? "Allow camera access in Settings → Sadhya, then reopen the app. Search still works."
                 : "This iPad's camera could not be opened. Use search instead.")
                .font(.system(size: 17))
                .foregroundStyle(.white.opacity(0.6))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
        }
    }
}
