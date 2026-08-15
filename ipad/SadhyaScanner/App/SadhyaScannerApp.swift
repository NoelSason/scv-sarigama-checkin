import SwiftUI

@main
struct SadhyaScannerApp: App {
    @StateObject private var backend = Backend.shared

    init() {
        // A scanner that sleeps mid-queue is a scanner someone has to wake up
        // with a passcode while a family waits. It stays awake for the event.
        UIApplication.shared.isIdleTimerDisabled = true
        Chime.shared.warmUp()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(backend)
                .preferredColorScheme(.dark)
                .statusBarHidden()
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var backend: Backend

    var body: some View {
        ZStack {
            Aurora()

            switch backend.status {
            case .checking:
                Splash()
            case .needsSignIn:
                SignInView()
            case .ready:
                ScanView()
            }
        }
        .animation(.easeInOut(duration: 0.35), value: backend.status)
        .task { await backend.restore() }
    }
}

/// Held for as long as the session check takes, which on a good network is one
/// frame. It exists so that launch never flashes the password screen at an iPad
/// that is already signed in.
private struct Splash: View {
    var body: some View {
        VStack(spacing: 22) {
            Lamp()
            ProgressView()
                .tint(Palette.gold)
        }
    }
}

/// The nilavilakku that marks the app everywhere it appears.
struct Lamp: View {
    var scale: CGFloat = 1

    var body: some View {
        ZStack {
            Circle()
                .fill(Palette.gold.opacity(0.22))
                .frame(width: 120 * scale, height: 120 * scale)
                .blur(radius: 26 * scale)

            Image(systemName: "flame.fill")
                .font(.system(size: 46 * scale, weight: .medium))
                .foregroundStyle(
                    LinearGradient(
                        colors: [Palette.gold, Palette.goldDeep],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
        }
    }
}
