import SwiftUI

struct HeroSection: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
        HStack {
            SectionCaption(text: caption)
            Spacer()
            Text("\(store.payload.current.calls.asThousandsSeparated()) calls")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Text("·")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
            Text("\(store.payload.current.sessions) sess")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        if store.selectedPeriod == .all {
            if let warning = store.payload.diagnostics?.warnings.first(where: { $0.contains("historical Claude token counters") }) {
                Text("Includes recovered history estimates")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .help(warning)
            }
            if let warning = store.payload.diagnostics?.warnings.first(where: { $0.contains("earliest dated local usage") }) {
                Text("Earlier history is incomplete")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .help(warning)
            }
        }
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private var caption: String {
        let label = store.payload.current.label.isEmpty ? store.selectedPeriod.rawValue : store.payload.current.label
        if store.selectedPeriod == .today {
            return "\(label) · \(todayDate)"
        }
        return "\(label) · API equivalent"
    }

    private var todayDate: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE MMM d"
        return formatter.string(from: Date())
    }
}
