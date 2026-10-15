import SwiftUI

struct AITimeSection: View {
    @Environment(AppStore.self) private var store
    @State private var showDetails = false

    var body: some View {
        let time = store.payload.time
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Label("AI time", systemImage: "clock")
                    .font(.system(size: 11, weight: .semibold))
                Spacer()
                Text(time?.aiRunningMs == nil ? "Timing unknown" : "Partial history")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .top, spacing: 8) {
                metric("AI running", time?.aiRunningMs, "Added across agents")
                metric("Elapsed busy", time?.elapsedBusyMs, "Overlap counted once")
                metric("Your time ≈", time?.userActiveMs, "Interaction estimate")
            }
            Button {
                showDetails.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: showDetails ? "chevron.down" : "chevron.right")
                    Text(coverage(time))
                }
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if showDetails {
                if let time {
                    ForEach(time.providers) { provider in
                        HStack {
                            Text(provider.name)
                            Spacer()
                            Text(TimeBlock.duration(provider.aiRunningMs))
                            Text("\(provider.timedFiles)/\(provider.files) files")
                                .foregroundStyle(.secondary)
                        }
                        .font(.system(size: 10))
                    }
                    ForEach(time.notes, id: \.self) { note in
                        Text(note).font(.system(size: 10)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text("Timing has not been recovered for this view. Refresh to load available records; missing time is unknown, not zero.")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func metric(_ label: String, _ value: Double?, _ caption: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
            Text(TimeBlock.duration(value)).font(.system(size: 16, weight: .semibold, design: .rounded))
                .monospacedDigit().minimumScaleFactor(0.65).lineLimit(1)
            Text(caption).font(.system(size: 9)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func coverage(_ time: TimeBlock?) -> String {
        guard let time else { return "Missing records · about these times" }
        if time.pendingFiles > 0 { return "\(time.pendingFiles) files awaiting recovery · details" }
        if time.estimatedAiMs > 0 { return "Includes inferred AI time · missing records · details" }
        return "Since Jul 1, 2025 · missing records · details"
    }
}
