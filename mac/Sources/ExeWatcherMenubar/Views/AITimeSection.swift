import SwiftUI

struct AITimeSection: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        VStack(spacing: 0) {
            AITimeContent(time: store.payload.time, recoveryPaused: store.timeRecoveryMessage != nil)
            if let message = store.timeRecoveryMessage {
                HStack {
                    Text(message).foregroundStyle(.secondary)
                    Spacer()
                    Button("Retry") { store.retryTimeRecovery() }
                }
                .font(.system(size: 10))
                .padding(.horizontal, 14).padding(.bottom, 12)
            }
        }
    }
}

struct AITimeContent: View {
    let time: TimeBlock?
    var recoveryPaused = false
    @State private var showDetails = false

    var body: some View {
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
                            Text("\(provider.timedFiles)/\(provider.files) timed in view")
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
        if let recovery = time.recovery, recovery.runnableFiles > 0 {
            if recoveryPaused { return "Timing update paused · details" }
            return "Updating \(recovery.runnableFiles) logs · details"
        }
        if let recovery = time.recovery, recovery.waitingFiles > 0 {
            return "\(recovery.waitingFiles) logs have incomplete end data · details"
        }
        if time.pendingFiles > 0 { return "\(time.pendingFiles) logs need timing updates · details" }
        if time.estimatedAiMs > 0 { return "Includes inferred AI time · missing records · details" }
        if let recorded = time.firstRecordedAt {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: recorded) {
                return "Recorded from \(date.formatted(date: .abbreviated, time: .omitted)) · partial history"
            }
        }
        return "Since Jul 1, 2025 · missing records · details"
    }
}
