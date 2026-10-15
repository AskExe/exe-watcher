import SwiftUI

struct HeroSection: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
        HStack {
            SectionCaption(text: caption)
            Spacer()
            Text("\(store.payload.callCount.displayValue) calls")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .help(store.payload.callCount.explanation)
            Text("·")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
            Text("\(store.payload.current.sessions) sess")
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        if store.selectedPeriod == .today {
            Text("API equivalent at current model rates")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
        if store.payload.diagnostics?.hasUnpricedUsage == true {
            Text("Cost is incomplete · some usage has no known API price")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .help("Recorded tokens are included. Usage without a known model price is excluded from cost totals.")
        }
        if let warning = store.payload.diagnostics?.discoveryWarning {
            Text("Some local usage could not be read")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .help(warning)
        }
        if !store.payload.generated.isEmpty && store.selectedProvider == .all && store.payload.current.calls == 0 && store.payload.current.cost == 0 && !store.payload.hasIncompleteCallCounts {
            Text("No recorded usage in this period · supported tools are found automatically")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
        if store.selectedPeriod == .all {
            if let warning = store.payload.diagnostics?.warnings.first(where: { $0.contains("historical Claude token counters") }) {
                Text("Recovered history · call counts incomplete")
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
