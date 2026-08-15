import SwiftUI

/// Two fields, typed once per tablet per fortnight.
///
/// The address is asked for rather than compiled in so the same build runs
/// against a staging site the week before and the real one on the day, without
/// anyone needing Xcode to change it.
struct SignInView: View {
    @EnvironmentObject private var backend: Backend
    @State private var password = ""
    @State private var problem: String?
    @State private var busy = false
    @FocusState private var focus: Field?

    private enum Field { case address, password }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 26) {
                VStack(spacing: 10) {
                    Lamp()
                    Eyebrow(text: "SCV SARIGAMA")
                    Text("Onam Check-In")
                        .font(.system(size: 44, weight: .heavy, design: .serif))
                        .foregroundStyle(.white)
                    Text("Sign this iPad in once. It stays signed in for two weeks.")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(.white.opacity(0.55))
                }

                VStack(spacing: 14) {
                    field(
                        label: "SERVER ADDRESS",
                        placeholder: "checkin.scvsarigama.org",
                        text: $backend.address,
                        secure: false,
                        field: .address
                    )

                    field(
                        label: "VOLUNTEER PASSWORD",
                        placeholder: "••••••••",
                        text: $password,
                        secure: true,
                        field: .password
                    )
                }

                if let problem {
                    Text(problem)
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Palette.danger)
                        .multilineTextAlignment(.center)
                        .transition(.opacity)
                }

                Button(action: submit) {
                    Group {
                        if busy {
                            ProgressView().tint(Palette.ink)
                        } else {
                            Text("Sign in")
                                .font(.system(size: 22, weight: .heavy, design: .rounded))
                        }
                    }
                    .frame(height: 34)
                    .padding(.vertical, 16)
                }
                .buttonStyle(SurfaceButton())
                .disabled(busy || password.isEmpty || backend.address.isEmpty)
                .opacity(password.isEmpty || backend.address.isEmpty ? 0.45 : 1)
            }
            .padding(44)
            .frame(width: 560)
            .glass(radius: 34)

            Spacer()

            Text("Ask the event admin for the password.")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.white.opacity(0.4))
                .padding(.bottom, 36)
        }
        .onSubmit(submit)
        .onAppear { focus = backend.address.isEmpty ? .address : .password }
    }

    private func field(
        label: String,
        placeholder: String,
        text: Binding<String>,
        secure: Bool,
        field: Field
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: label)
            Group {
                if secure {
                    SecureField(placeholder, text: text)
                } else {
                    TextField(placeholder, text: text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
            }
            .font(.system(size: 22, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.white.opacity(0.06))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(focus == field ? Palette.gold.opacity(0.8) : Color.white.opacity(0.12), lineWidth: 1.5)
            )
            .focused($focus, equals: field)
        }
    }

    private func submit() {
        guard !busy, !password.isEmpty, !backend.address.isEmpty else { return }
        busy = true
        withAnimation { problem = nil }

        Task {
            do {
                try await backend.signIn(password: password)
                Chime.shared.play(.admitted)
                password = ""
            } catch {
                Chime.shared.play(.refused)
                withAnimation {
                    problem = (error as? BackendError)?.errorDescription ?? "Could not sign in."
                }
            }
            busy = false
        }
    }
}
