import SwiftUI

struct AITimeSection: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        VStack(spacing: 0) {
            AITimeContent(time: store.payload.time, recoveryPaused: store.timeRecoveryMessage != nil)
            VStack(alignment: .leading, spacing: 5) {
                Toggle("Track active AI app time on this Mac", isOn: Binding(
                    get: { store.personalActivity.enabled }, set: { store.personalActivity.setEnabled($0) }))
                    .toggleStyle(.switch).controlSize(.mini)
                    .disabled(store.personalActivity.error != nil)
                Text(store.personalActivity.error ?? "Local app and idle metadata only. No typing or screen contents recorded.")
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .font(.system(size: 9)).padding(.horizontal, 14).padding(.bottom, 12)
            if let message = store.timeRecoveryMessage {
                HStack {
                    Text(message).foregroundStyle(.secondary)
                    Spacer()
                    Button("Retry") { store.retryTimeRecovery() }
                        .noFocusRing()
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
                metric("Your time ≈", time?.personalTimeMs, time?.personalTimeCaption ?? "Estimate unavailable")
            }
            if let estimate = time?.sessionEstimate {
                Text("Historical sessions ≈ \(TimeBlock.duration(estimate.lowerMs))–\(TimeBlock.duration(estimate.upperMs))")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                    .help("The main value uses a 15-minute session gap; this range uses 10–30 minutes. It is a sensitivity range, not measured attention.")
            }
            if let activity = time?.appActivity {
                Text("Tracked app activity: \(TimeBlock.duration(activity.totalMs)) · \(activity.enabled ? "tracking on" : "tracking off")")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
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
            .noFocusRing()
            if showDetails {
                if let time {
                    if let activity = time.appActivity {
                        Text("App tracking began \(String(activity.startedAt.prefix(10))). Idle after 2 minutes; sleep and lock gaps are excluded. Terminal/editor context: \(TimeBlock.duration(activity.contextualMs)), inferred from a recent AI turn. Browsers and unsupported apps remain unknown. App activity is a proxy for engagement, not measured attention.")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(time.providers.filter { TimeBlock.duration($0.aiRunningMs) != "Unknown" }) { provider in
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
