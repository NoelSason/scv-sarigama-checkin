import SwiftUI

/// Find a family by name when the code cannot be read.
///
/// A cracked screen, a dead phone, a printed roster — the camera is the fast
/// path, not the only one, and an entrance with no fallback is an entrance that
/// stops when one guest's battery dies.
struct SearchSheet: View {
    let onPick: (Household) -> Void

    @EnvironmentObject private var backend: Backend
    @Environment(\.dismiss) private var dismiss

    @State private var term = ""
    @State private var results: [Household] = []
    @State private var searching = false
    @State private var query: Task<Void, Never>?
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            Aurora()

            VStack(spacing: 20) {
                HStack {
                    Eyebrow(text: "FIND A FAMILY")
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(.white.opacity(0.8))
                            .frame(width: 42, height: 42)
                            .background(Circle().fill(.ultraThinMaterial))
                    }
                }

                TextField("Name, email, or phone", text: $term)
                    .font(.system(size: 24, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focused)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 18)
                    .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(.white.opacity(0.07)))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(Palette.gold.opacity(0.55), lineWidth: 1.5)
                    )

                if searching {
                    ProgressView().tint(Palette.gold)
                }

                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(results) { household in
                            Button {
                                Chime.shared.play(.tap)
                                onPick(household)
                            } label: {
                                row(household)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if !searching && term.trimmingCharacters(in: .whitespaces).count >= 2 && results.isEmpty {
                    Text("No match. Try a shorter part of the name.")
                        .font(.system(size: 17))
                        .foregroundStyle(.white.opacity(0.55))
                }

                Spacer(minLength: 0)
            }
            .padding(34)
        }
        .onAppear { focused = true }
        .onChange(of: term) { _, value in schedule(value) }
        .onDisappear { query?.cancel() }
    }

    private func row(_ household: Household) -> some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(household.displayName)
                    .font(.system(size: 21, weight: .heavy))
                    .foregroundStyle(.white)
                HStack(spacing: 10) {
                    StatusChip(label: household.statusLabel, ok: household.usable)
                    Text("\(household.ticketsRemaining) of \(household.ticketsPurchased) left")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.55))
                        .monospacedDigit()
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(.white.opacity(0.35))
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass(radius: 22)
    }

    /// Debounced: a name typed at speed would otherwise be eight lookups, and
    /// every one of them is written to the audit log as an access to a guest's
    /// record.
    private func schedule(_ value: String) {
        query?.cancel()
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else {
            results = []
            searching = false
            return
        }

        searching = true
        query = Task {
            try? await Task.sleep(nanoseconds: 280_000_000)
            guard !Task.isCancelled else { return }
            let found = (try? await backend.search(trimmed)) ?? []
            guard !Task.isCancelled else { return }
            results = found
            searching = false
        }
    }
}
