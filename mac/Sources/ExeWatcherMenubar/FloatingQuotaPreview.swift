import Foundation

/// Developer-only fixture launch. It never reads credentials or contacts a provider.
@MainActor
enum FloatingQuotaPreview {
    static var isEnabled: Bool { ProcessInfo.processInfo.arguments.contains("--floating-quota-preview") }
    static var defaults: UserDefaults {
        isEnabled ? UserDefaults(suiteName: "com.askexe.watcher.floating-quota-preview")! : .standard
    }
    static func configure(store: AppStore, preferences: FloatingQuotaPreferences) {
        preferences.isEnabled = true
        let state = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--quota-state=") }?.split(separator: "=").last.map(String.init) ?? "live"
        let now = Date()
        let formatter = ISO8601DateFormatter()
        let periods = Dictionary(uniqueKeysWithValues: Period.allCases.enumerated().map { index, period in
            (period.cliArg, TimeBlock(indexedAt: formatter.string(from: now), since: "2026-04-24T00:00:00Z",
                through: formatter.string(from: now), aiRunningMs: Double(9_420_000 * (index + 1)),
                elapsedBusyMs: Double(5_400_000 * (index + 1)), userActiveMs: Double(2_760_000 * (index + 1)),
                estimatedAiMs: 0, coverage: "complete", pendingFiles: 0, indexedFiles: 24,
                firstRecordedAt: nil, lastRecordedAt: nil, providers: [], notes: []))
        })
        let anchor = PayloadCacheKey(period: .today, provider: .all, now: now).dateAnchor
        store.applyTimeSnapshots(TimeRecoverySnapshots(generated: formatter.string(from: now), provider: "all", periods: periods,
            allPeriods: nil, recovery: TimeRecoveryProgress(runnableFiles: 0, waitingFiles: 0, pendingBytes: 0, token: "preview")), dateAnchor: anchor)
        store.subscription = SubscriptionUsage(
            tier: .max20x, rawTier: nil,
            fiveHourPercent: 64, fiveHourResetsAt: now.addingTimeInterval(state == "expired" ? -60 : 6480),
            sevenDayPercent: 38, sevenDayResetsAt: now.addingTimeInterval(3 * 86400 + 6 * 3600),
            sevenDayOpusPercent: 82, sevenDayOpusResetsAt: now.addingTimeInterval(3 * 86400 + 6 * 3600),
            sevenDaySonnetPercent: nil, sevenDaySonnetResetsAt: nil,
            fetchedAt: now.addingTimeInterval(state == "stale" ? -1200 : 0))
        store.subscriptionLoadState = state == "stale" ? .failed : .loaded
        if state == "disconnected" || state == "loading" {
            store.subscription = nil
            store.subscriptionLoadState = state == "loading" ? .loading : .noCredentials
        }
    }
}
