import Foundation
import Observation

private let todayCacheTTLSeconds: TimeInterval = 30
private let historicalCacheTTLSeconds: TimeInterval = 5 * 60
typealias MenubarPayloadFetcher = @Sendable (Period, ProviderFilter, Bool) async throws -> MenubarPayload
typealias AppStoreDateProvider = @Sendable () -> Date
typealias TimeSnapshotsFetcher = @Sendable (ProviderFilter) async throws -> TimeRecoverySnapshots
typealias TimeRecoveryRest = @Sendable (TimeInterval) async throws -> Void
typealias SubscriptionUsageFetcher = @Sendable (Bool) async throws -> SubscriptionUsage

private struct BadgeSnapshot: Codable {
    let dateAnchor: String
    let fetchedAt: Date
    let payload: MenubarPayload
}

struct CachedPayload {
    let payload: MenubarPayload
    let fetchedAt: Date
    var historicalValidatedAt: Date? = nil
    func isFresh(now: Date, period: Period) -> Bool {
        if payload.savedHistory != nil { return false }
        let ttl = period == .today ? todayCacheTTLSeconds : historicalCacheTTLSeconds
        let timestamp = period == .today ? fetchedAt : historicalValidatedAt ?? fetchedAt
        return now.timeIntervalSince(timestamp) < ttl
    }
}

private struct PersistedPeriod: Codable {
    let period: String
    let provider: String
    let fetchedAt: Date
    let historicalValidatedAt: Date?
    let payload: MenubarPayload
}
private struct PeriodCacheSnapshot: Codable {
    let version: Int
    let dateAnchor: String
    let entries: [PersistedPeriod]
}

private struct TimingCacheSnapshot: Codable {
    let version: Int
    let dateAnchor: String
    let fetchedAt: Date
    let periods: [String: TimeBlock]
}

struct PayloadCacheKey: Hashable {
    let period: Period
    let provider: ProviderFilter
    let includeOptimize: Bool
    let dateAnchor: String

    init(period: Period, provider: ProviderFilter, includeOptimize: Bool = false, now: Date = Date()) {
        self.period = period
        self.provider = provider
        self.includeOptimize = includeOptimize
        self.dateAnchor = Self.anchor(for: period, now: now)
    }

    private static func anchor(for _: Period, now: Date) -> String {
        let calendar = Calendar(identifier: .gregorian)
        let comps = calendar.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", comps.year ?? 0, comps.month ?? 0, comps.day ?? 0)
    }
}

@MainActor
@Observable
final class AppStore {
    var selectedProvider: ProviderFilter = .all
    var selectedPeriod: Period = .today
    var selectedInsight: InsightMode = .trend
    var currency: String = "USD"
    var isLoading: Bool = false
    private(set) var timeRecoveryMessage: String?
    var subscription: SubscriptionUsage?
    var subscriptionError: String?
    var subscriptionConnectionMessage: String?
    var subscriptionLoadState: SubscriptionLoadState = .idle
    private(set) var subscriptionNextRefreshAt: Date = .distantPast
    private(set) var subscriptionRateLimitedUntil: Date = .distantPast
    private var subscriptionLastAttempt: Date = .distantPast
    @ObservationIgnored private var subscriptionTask: Task<SubscriptionUsage, Error>?
    private let fetchSubscription: SubscriptionUsageFetcher
    private let persistSubscriptionSnapshots: Bool
    private var floatingTimeSnapshots: [Period: TimeBlock] = [:]
    private var floatingTimeAnchor = ""
    private var floatingTimeFetchedAt: Date?
    @ObservationIgnored private var floatingTimeTask: Task<TimeRecoverySnapshots, Error>?
    @ObservationIgnored private var floatingTimeRetryAt: Date = .distantPast
    private(set) var floatingTimeError: String?
    private(set) var isLoadingFloatingTime = false
    var providerQuotaStates: [QuotaProviderID: ProviderQuotaState] = [:]
    @ObservationIgnored private var providerQuotaTasks: [QuotaProviderID: Task<ProviderQuotaSnapshot, Error>] = [:]
    private let fetchProviderQuota: ProviderQuotaFetcher
    var capacityEstimates: [String: CapacityEstimate] = [:]

    /// Lightweight self-diagnostics for the menubar refresh loop. These make stale-counter bugs
    /// visible instead of forcing us to infer state from screenshots or process lists.
    private(set) var activeFetchCount: Int = 0
    private(set) var lastBadgeRefreshAttemptAt: Date?
    private(set) var lastBadgeRefreshSuccessAt: Date?
    private(set) var lastBadgeRefreshError: String?
    private(set) var lastUsageChangeAt: Date?

    /// Health monitor for self-healing feedback loop. Initialized by AppDelegate after launch.
    var healthMonitor: HealthMonitor?

    private let fetchPayload: MenubarPayloadFetcher
    private let fetchTimeSnapshots: TimeSnapshotsFetcher
    private let restForTimeRecovery: TimeRecoveryRest
    @ObservationIgnored private var timeRecoveryTask: Task<Void, Never>?
    @ObservationIgnored private var timeRecoveryPacer = TimeRecoveryPacer()
    @ObservationIgnored private var historyRecoveryTask: Task<Void, Never>?
    private var pausedHistoryToken: String?
    private let now: AppStoreDateProvider
    private let badgeCacheURL: URL?
    private var periodCacheURL: URL? {
        badgeCacheURL?.deletingLastPathComponent().appendingPathComponent("period-snapshots.json")
    }
    private var timingCacheURL: URL? {
        badgeCacheURL?.deletingLastPathComponent().appendingPathComponent("native-time-snapshots.json")
    }
    private var cache: [PayloadCacheKey: CachedPayload] = [:]
    private var errorsByKey: [PayloadCacheKey: String] = [:]
    private var retryAfter: [PayloadCacheKey: Date] = [:]
    private var failureCounts: [PayloadCacheKey: Int] = [:]

    /// Same-key requests share ownership; the process runner admits one child globally.
    private let badgeAdmission = FetchAdmission(limit: 1)
    private let detailAdmission = FetchAdmission(limit: 1)
    private let fetchSavedPayload: MenubarPayloadFetcher?
    private var fetchTasks: [PayloadCacheKey: Task<MenubarPayload, Error>] = [:]
    /// Incremented when macOS resumes/unlocks and we intentionally discard stale in-flight
    /// bookkeeping. Fetches that started before the generation changed are ignored on return so
    /// a pre-lock CLI scan cannot overwrite the fresh post-unlock payload.
    private var refreshGeneration: UInt64 = 0

    init(
        fetchPayload: @escaping MenubarPayloadFetcher = DataClient.fetch,
        now: @escaping AppStoreDateProvider = Date.init,
        badgeCacheURL: URL? = nil,
        fetchSavedPayload: MenubarPayloadFetcher? = nil,
        fetchTimeSnapshots: @escaping TimeSnapshotsFetcher = { try await DataClient.fetchTimeSnapshots(provider: $0) },
        restForTimeRecovery: @escaping TimeRecoveryRest = { try await Task.sleep(for: .seconds($0)) },
        fetchSubscription: @escaping SubscriptionUsageFetcher = { try await SubscriptionClient.fetch(allowKeychainPrompt: $0) },
        persistSubscriptionSnapshots: Bool = true,
        fetchProviderQuota: @escaping ProviderQuotaFetcher = { try await ProviderQuotaClient.fetch($0, allowKeychainPrompt: $1) }
    ) {
        self.fetchPayload = fetchPayload
        self.fetchSavedPayload = fetchSavedPayload
        self.fetchTimeSnapshots = fetchTimeSnapshots
        self.restForTimeRecovery = restForTimeRecovery
        self.fetchProviderQuota = fetchProviderQuota
        self.fetchSubscription = fetchSubscription
        self.persistSubscriptionSnapshots = persistSubscriptionSnapshots
        self.now = now
        self.badgeCacheURL = badgeCacheURL
        let todayKey = PayloadCacheKey(period: .today, provider: .all, now: now())
        if let url = badgeCacheURL,
           let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
           size <= 2 * 1024 * 1024,
           let data = try? Data(contentsOf: url),
           let saved = try? JSONDecoder().decode(BadgeSnapshot.self, from: data),
           saved.dateAnchor == todayKey.dateAnchor,
           saved.fetchedAt <= now(),
           (try? DataClient.validate(saved.payload)) != nil {
            cache[todayKey] = CachedPayload(payload: saved.payload, fetchedAt: saved.fetchedAt)
            lastBadgeRefreshSuccessAt = saved.fetchedAt
        }
        if let url = periodCacheURL,
           let data = try? SafeFile.read(from: url.path, maxBytes: 20 * 1024 * 1024),
           let saved = try? JSONDecoder().decode(PeriodCacheSnapshot.self, from: data),
           saved.version == 1 {
            for entry in saved.entries {
                guard let period = Period(rawValue: entry.period),
                      let provider = ProviderFilter(rawValue: entry.provider),
                      entry.fetchedAt <= now(),
                      (saved.dateAnchor == todayKey.dateAnchor || period == .all),
                      (try? DataClient.validate(entry.payload)) != nil else { continue }
                let target = PayloadCacheKey(period: period, provider: provider, now: now())
                if cache[target].map({ $0.fetchedAt > entry.fetchedAt }) == true { continue }
                var payload = entry.payload
                if saved.dateAnchor != todayKey.dateAnchor && payload.savedHistory == nil {
                    payload.savedHistory = SavedHistoryStatus(through: saved.dateAnchor,
                        message: "Showing the saved All total from \(saved.dateAnchor). Updating newer history.")
                }
                cache[target] = CachedPayload(payload: payload, fetchedAt: entry.fetchedAt,
                                              historicalValidatedAt: entry.historicalValidatedAt)
            }
        }
        if let url = timingCacheURL,
           let data = try? SafeFile.read(from: url.path, maxBytes: 2 * 1024 * 1024),
           let saved = try? JSONDecoder().decode(TimingCacheSnapshot.self, from: data),
           saved.version == 1, saved.fetchedAt <= now() {
            floatingTimeAnchor = todayKey.dateAnchor
            floatingTimeFetchedAt = saved.fetchedAt
            for period in Period.allCases where saved.dateAnchor == todayKey.dateAnchor || period == .all {
                floatingTimeSnapshots[period] = saved.periods[period.cliArg]
            }
        }
    }

    private func persistTiming() {
        guard let url = timingCacheURL, let fetchedAt = floatingTimeFetchedAt else { return }
        let periods = Dictionary(uniqueKeysWithValues: floatingTimeSnapshots.map { ($0.key.cliArg, $0.value) })
        let saved = TimingCacheSnapshot(version: 1, dateAnchor: floatingTimeAnchor, fetchedAt: fetchedAt, periods: periods)
        if let data = try? JSONEncoder().encode(saved), data.count <= 2 * 1024 * 1024 {
            try? SafeFile.write(data, to: url.path)
        }
    }

    private func persistPeriods() {
        guard let url = periodCacheURL else { return }
        let anchor = PayloadCacheKey(period: .today, provider: .all, now: now()).dateAnchor
        let entries = cache.filter { !$0.key.includeOptimize && $0.key.dateAnchor == anchor }.map { key, value in
            PersistedPeriod(period: key.period.rawValue, provider: key.provider.rawValue,
                            fetchedAt: value.fetchedAt, historicalValidatedAt: value.historicalValidatedAt,
                            payload: value.payload)
        }
        let saved = PeriodCacheSnapshot(version: 1, dateAnchor: anchor, entries: entries)
        if let data = try? JSONEncoder().encode(saved), data.count <= 20 * 1024 * 1024 {
            try? SafeFile.write(data, to: url.path)
        }
    }

    private func persistBadge() {
        let target = key(period: .today, provider: .all, includeOptimize: false)
        guard let url = badgeCacheURL, let saved = cache[target],
              let data = try? JSONEncoder().encode(BadgeSnapshot(dateAnchor: target.dateAnchor,
                  fetchedAt: saved.fetchedAt, payload: saved.payload)), data.count <= 2 * 1024 * 1024 else { return }
        try? SafeFile.write(data, to: url.path)
    }

    private static func newerTime(_ existing: TimeBlock?, _ incoming: TimeBlock?) -> TimeBlock? {
        guard let incoming else { return existing }
        guard let existing else { return incoming }
        guard let newDate = incoming.indexedAt else { return existing.indexedAt == nil ? incoming : existing }
        guard let oldDate = existing.indexedAt else { return incoming }
        return newDate >= oldDate ? incoming : existing
    }

    /// Update timing without making an old cost result look newly fetched/validated.
    func applyTimeSnapshots(_ fresh: TimeRecoverySnapshots, dateAnchor: String) {
        guard dateAnchor == key(period: .today, provider: .all, includeOptimize: false).dateAnchor,
              let provider = ProviderFilter.allCases.first(where: { $0.cliArg == fresh.provider }) else { return }
        var slices = [(provider, fresh.periods)]
        if let all = fresh.allPeriods { slices.append((.all, all)) }
        for (scope, periods) in slices {
            for period in Period.allCases {
                let target = key(period: period, provider: scope, includeOptimize: false)
                guard let time = periods[period.cliArg] else { continue }
                if scope == .all {
                    if floatingTimeAnchor != dateAnchor { floatingTimeSnapshots = [:] }
                    floatingTimeAnchor = dateAnchor
                    floatingTimeFetchedAt = now()
                    floatingTimeSnapshots[period] = Self.newerTime(floatingTimeSnapshots[period], time)
                }
                guard let saved = cache[target] else { continue }
                var payload = saved.payload
                payload.time = Self.newerTime(payload.time, time)
                cache[target] = CachedPayload(payload: payload, fetchedAt: saved.fetchedAt,
                    historicalValidatedAt: saved.historicalValidatedAt)
            }
        }
        // Save independent timing even while recovery is pending and no financial
        // All Time payload exists. Never write or refresh cost timestamps here.
        persistTiming()
        // Source progress is already durable per step. Avoid rewriting full financial
        // snapshots every chunk; persist the display once the known queue is drained.
        if fresh.recovery.runnableFiles == 0 {
            timeRecoveryMessage = nil
            persistPeriods(); persistBadge()
        }
    }

    /// All-provider timing does not depend on which financial view the popover has loaded.
    func floatingTime(for period: Period) -> TimeBlock? {
        let anchor = key(period: .today, provider: .all, includeOptimize: false).dateAnchor
        let separate = floatingTimeAnchor == anchor || period == .all ? floatingTimeSnapshots[period] : nil
        return Self.newerTime(mergedPayload(period: period, provider: .all)?.time, separate)
    }

    func loadFloatingTimeIfNeeded(for period: Period, force: Bool = false) async {
        if !force, floatingTimeAnchor == key(period: .today, provider: .all, includeOptimize: false).dateAnchor,
           floatingTimeSnapshots[period] != nil, floatingTimeSnapshots[.all] != nil,
           let fetchedAt = floatingTimeFetchedAt, fetchedAt <= now(), now().timeIntervalSince(fetchedAt) < 5 * 60 {
            scheduleTimeRecovery(floatingTimeSnapshots[period]?.recovery)
            return
        }
        if !force, now() < floatingTimeRetryAt { return }
        if let task = floatingTimeTask { _ = try? await task.value; return }
        let anchor = key(period: .today, provider: .all, includeOptimize: false).dateAnchor
        let fetch = fetchTimeSnapshots
        let task = Task { try await fetch(.all) }
        floatingTimeTask = task
        isLoadingFloatingTime = true
        defer { floatingTimeTask = nil; isLoadingFloatingTime = false }
        do {
            let snapshots = try await task.value
            try Task.checkCancellation()
            guard anchor == key(period: .today, provider: .all, includeOptimize: false).dateAnchor else { return }
            floatingTimeError = nil
            floatingTimeRetryAt = .distantPast
            applyTimeSnapshots(snapshots, dateAnchor: anchor)
            scheduleTimeRecovery(snapshots.recovery)
        } catch is CancellationError {
        } catch {
            floatingTimeRetryAt = now().addingTimeInterval(5 * 60)
            floatingTimeError = "Timing unavailable. Open the report to recover retained history."
        }
    }

    private func scheduleTimeRecovery(_ progress: TimeRecoveryProgress?) {
        if progress?.runnableFiles == 0 { timeRecoveryMessage = nil }
        guard timeRecoveryTask == nil, let progress, timeRecoveryPacer.begin(progress) else { return }
        timeRecoveryMessage = nil
        let generation = refreshGeneration
        let anchor = key(period: .today, provider: .all, includeOptimize: false).dateAnchor
        timeRecoveryTask = Task(priority: .utility) { [weak self] in
            guard let self else { return }
            defer { self.timeRecoveryTask = nil }
            var previous = progress
            do {
                while !Task.isCancelled {
                    try await self.restForTimeRecovery(self.timeRecoveryPacer.delay)
                    try Task.checkCancellation()
                    let started = ProcessInfo.processInfo.systemUptime
                    let result = try await self.fetchTimeSnapshots(self.selectedProvider)
                    try Task.checkCancellation()
                    guard generation == self.refreshGeneration,
                          anchor == self.key(period: .today, provider: .all, includeOptimize: false).dateAnchor else { return }
                    self.applyTimeSnapshots(result, dateAnchor: anchor)
                    let again = self.timeRecoveryPacer.completed(previous: previous.token,
                        progress: result.recovery, elapsed: ProcessInfo.processInfo.systemUptime - started)
                    previous = result.recovery
                    if !again {
                        if result.recovery.runnableFiles > 0 { self.timeRecoveryMessage = "Timing update paused after no progress." }
                        break
                    }
                }
            } catch is CancellationError {
                // Ownership is retained until the cancelled CLI has exited/reaped.
            } catch {
                guard !Task.isCancelled, generation == self.refreshGeneration else { return }
                self.timeRecoveryPacer.pause(previous.token)
                self.timeRecoveryMessage = "Timing update paused. You can retry it."
                NSLog("Exe Watcher: timing recovery paused: %@", error.localizedDescription)
            }
        }
    }

    func cancelTimeRecovery() {
        floatingTimeTask?.cancel()
        timeRecoveryTask?.cancel()
        timeRecoveryPacer.reset()
        timeRecoveryMessage = nil
        historyRecoveryTask?.cancel()
    }

    func retryTimeRecovery() {
        timeRecoveryPacer.reset()
        scheduleTimeRecovery(todayPayload?.time?.recovery ?? payload.time?.recovery)
    }

    private func ingestPeriods(from fresh: MenubarPayload, provider: ProviderFilter, dateAnchor: String) {
        guard dateAnchor == key(period: .today, provider: provider, includeOptimize: false).dateAnchor,
              let snapshots = fresh.periodSnapshots else { return }
        for period in Period.allCases {
            guard let snapshot = snapshots[period.cliArg] else { continue }
            let target = key(period: period, provider: provider, includeOptimize: false)
            if snapshot.savedHistory != nil, let existing = cache[target],
               existing.payload.current.cost > snapshot.current.cost {
                // An incomplete rollup must not replace a larger previously known total.
                var retained = existing.payload
                retained.savedHistory = snapshot.savedHistory
                cache[target] = CachedPayload(payload: retained, fetchedAt: existing.fetchedAt,
                    historicalValidatedAt: existing.historicalValidatedAt)
                errorsByKey.removeValue(forKey: target)
                retryAfter.removeValue(forKey: target)
                failureCounts.removeValue(forKey: target)
                continue
            }
            let payload = MenubarPayload(
                generated: fresh.generated, cliVersion: fresh.cliVersion, minAppVersion: fresh.minAppVersion,
                current: snapshot.current, optimize: MenubarPayload.empty.optimize, history: fresh.history,
                diagnostics: snapshot.diagnostics, agentStats: fresh.agentStats,
                exeOsDetected: fresh.exeOsDetected, statsFileAge: fresh.statsFileAge, projectSpend: snapshot.projectSpend,
                time: Self.newerTime(cache[target]?.payload.time, snapshot.time),
                savedHistory: snapshot.savedHistory
            )
            cache[target] = CachedPayload(payload: payload, fetchedAt: now(),
                historicalValidatedAt: Date(timeIntervalSince1970: snapshot.historyValidatedAt / 1000))
            errorsByKey.removeValue(forKey: target)
            retryAfter.removeValue(forKey: target)
            failureCounts.removeValue(forKey: target)
        }
    }

    private func key(period: Period, provider: ProviderFilter, includeOptimize: Bool) -> PayloadCacheKey {
        PayloadCacheKey(period: period, provider: provider, includeOptimize: includeOptimize, now: now())
    }

    private var currentBaseKey: PayloadCacheKey {
        key(period: selectedPeriod, provider: selectedProvider, includeOptimize: false)
    }

    private var currentOptimizeKey: PayloadCacheKey {
        key(period: selectedPeriod, provider: selectedProvider, includeOptimize: true)
    }

    private func mergedPayload(period: Period, provider: ProviderFilter) -> MenubarPayload? {
        let base = cache[key(period: period, provider: provider, includeOptimize: false)]
        let optimized = cache[key(period: period, provider: provider, includeOptimize: true)]

        switch (base, optimized) {
        case (nil, nil):
            return nil
        case let (.some(basePayload), nil):
            return basePayload.payload
        case let (nil, .some(optimizedPayload)):
            return optimizedPayload.payload
        case let (.some(basePayload), .some(optimizedPayload)):
            let body = optimizedPayload.fetchedAt >= basePayload.fetchedAt ? optimizedPayload.payload : basePayload.payload
            return MenubarPayload(
                generated: body.generated,
                cliVersion: body.cliVersion,
                minAppVersion: body.minAppVersion,
                current: body.current,
                optimize: optimizedPayload.payload.optimize,
                history: body.history,
                diagnostics: body.diagnostics,
                agentStats: body.agentStats,
                exeOsDetected: body.exeOsDetected,
                statsFileAge: body.statsFileAge,
                projectSpend: body.projectSpend,
                time: Self.newerTime(basePayload.payload.time, optimizedPayload.payload.time),
                savedHistory: body.savedHistory
            )
        }
    }

    var lastError: String? {
        errorsByKey[currentOptimizeKey] ?? errorsByKey[currentBaseKey]
    }

    var baseLastError: String? {
        errorsByKey[currentBaseKey]
    }

    var payload: MenubarPayload {
        mergedPayload(period: selectedPeriod, provider: selectedProvider) ?? .empty
    }

    /// Summary payload for the selected period across all providers. Header totals and provider
    /// tabs must stay anchored to this payload so the grand total always matches the visible
    /// provider breakdown.
    var selectedPeriodSummaryPayload: MenubarPayload? {
        mergedPayload(period: selectedPeriod, provider: .all)
    }

    /// Header should always reflect the selected period's aggregate spend, not whichever provider
    /// detail tab happens to be open underneath.
    var headerPayload: MenubarPayload {
        selectedPeriodSummaryPayload ?? .empty
    }

    /// Today (across all providers) is pinned for the always-visible menubar icon, independent of
    /// the popover's selected period or provider.
    var todayPayload: MenubarPayload? {
        mergedPayload(period: .today, provider: .all)
    }

    /// All-provider payload for the currently selected period. Used by tab labels to show each
    /// provider's cost even when a specific provider tab is active.
    var allProviderPayloadForPeriod: MenubarPayload? {
        selectedPeriodSummaryPayload
    }

    /// Provider tabs should only render from data scoped to the selected period. Falling back to
    /// today's payload makes the tab strip lie when a historical period is still loading or has
    /// failed, which is how we ended up with a $0 header and $117/$45 provider tabs.
    var providerTabsPayload: MenubarPayload? {
        selectedPeriodSummaryPayload
    }

    var showProviderTabs: Bool {
        guard let providerTabsPayload else { return false }
        return !providerTabsPayload.current.providers.isEmpty
    }

    var hasCachedData: Bool {
        mergedPayload(period: selectedPeriod, provider: selectedProvider) != nil
    }

    var isCurrentSelectionLoading: Bool {
        inFlightKeys.contains(currentBaseKey) || inFlightKeys.contains(currentOptimizeKey)
    }

    var findingsCount: Int {
        payload.optimize.findingCount
    }

    /// Loading is not zero spend. Only actual work is labelled as updating;
    /// failures remain actionable without suggesting recorded charges expired.
    var headerStatus: String? {
        let summaryKey = key(period: selectedPeriod, provider: .all, includeOptimize: false)
        if selectedPeriodSummaryPayload == nil {
            return errorsByKey[summaryKey] == nil ? "Loading…" : "Update unavailable"
        }
        if inFlightKeys.contains(summaryKey) { return "Updating…" }
        if errorsByKey[summaryKey] != nil { return "Update paused" }
        return selectedPeriodSummaryPayload?.savedHistory != nil ? "Saved total" : nil
    }

    func noteUsageChange() { lastUsageChangeAt = now() }

    /// Switch to a period. Shows cached data instantly, then refreshes in background.
    func switchTo(period: Period) async {
        selectedPeriod = period
        // If we have cached data, it's already showing via the @Observable payload getter.
        Task { await self.refreshForSelectionInBackground(period: period, provider: selectedProvider) }
    }

    /// Switch to a provider filter. Shows cached data instantly, then refreshes in background.
    func switchTo(provider: ProviderFilter) async {
        selectedProvider = provider
        Task { await self.refreshForSelectionInBackground(period: selectedPeriod, provider: provider) }
    }

    /// Refresh the visible popover selection. Wake/unlock and popover-open paths must hydrate
    /// the selected provider/period, not just the always-visible Today/All badge; otherwise a
    /// stale provider tab can sit on the first-load loading overlay until manual Refresh.
    func refreshVisibleSelection() async {
        await refreshForSelectionInBackground(period: selectedPeriod, provider: selectedProvider)
    }

    /// macOS can freeze/suspend the accessory app while a CLI scan is in progress during lock or
    /// sleep. On unlock that old async task may never make it back through our normal defer path,
    /// leaving `badgeInFlight` or `inFlightKeys` stuck forever. The visible symptom is exactly the
    /// unacceptable one: menubar numbers disappear and the popover says "Loading …" indefinitely.
    ///
    /// Treat unlock/wake as a new refresh generation: clear stale in-flight guards, cancel
    /// outstanding work, and ignore any old fetch that eventually returns.
    func recoverFromSystemResume() {
        cancelTimeRecovery()
        RefreshTracer.shared.instant(
            name: "system_resume_recovery", category: "lifecycle", tid: .lifecycle,
            args: [
                "generation": .int(Int(refreshGeneration)),
                "active_fetch_count": .int(activeFetchCount),
                "in_flight_keys": .int(inFlightKeys.count),
            ]
        )
        refreshGeneration &+= 1
        // Keep ownership until cancelled work actually exits; old completions cannot
        // clear a new generation's guards or admit another child prematurely.
        for task in fetchTasks.values { task.cancel() }
    }

    private var inFlightKeys: Set<PayloadCacheKey> = []

    /// Refresh the currently selected (period, provider) combination. Guards against concurrent
    /// fetches for the same key so a slow initial request can't overwrite a newer one that
    /// finished first (which would show stale numbers the user has already moved past).
    func refresh(includeOptimize: Bool) async {
        let target = key(period: selectedPeriod, provider: selectedProvider, includeOptimize: includeOptimize)
        await refreshKey(target, includeOptimize: includeOptimize)
    }

    /// Badge and detail requests share same-key ownership and one global child slot.
    @discardableResult
    func refreshTodayBadge() async -> Bool {
        let target = key(period: .today, provider: .all, includeOptimize: false)
        lastBadgeRefreshAttemptAt = now()
        guard !inFlightKeys.contains(target) else { return false }
        let success = await refreshKey(target, includeOptimize: false)
        if success {
            lastBadgeRefreshSuccessAt = now()
            lastBadgeRefreshError = nil
        } else if let error = errorsByKey[target] {
            lastBadgeRefreshError = error
        }
        return success
    }

    @discardableResult
    private func refreshKey(_ key: PayloadCacheKey, includeOptimize: Bool, allowCached: Bool = false) async -> Bool {
        // All is an absolute accumulated amount. Keep it across day rollover;
        // date-relative windows still expire normally.
        for (previous, saved) in Array(cache) where previous.period == .all && !previous.includeOptimize && previous.dateAnchor != key.dateAnchor {
            let target = self.key(period: .all, provider: previous.provider, includeOptimize: false)
            if cache[target] == nil {
                var retained = saved.payload
                retained.savedHistory = retained.savedHistory ?? SavedHistoryStatus(through: previous.dateAnchor,
                    message: "Showing the saved All total from \(previous.dateAnchor). Updating newer history.")
                cache[target] = CachedPayload(payload: retained, fetchedAt: saved.fetchedAt,
                    historicalValidatedAt: saved.historicalValidatedAt)
            }
        }
        // Date-scoped data never accumulates indefinitely as the app stays open.
        cache = cache.filter { $0.key.dateAnchor == key.dateAnchor }
        errorsByKey = errorsByKey.filter { $0.key.dateAnchor == key.dateAnchor }
        retryAfter = retryAfter.filter { $0.key.dateAnchor == key.dateAnchor }
        failureCounts = failureCounts.filter { $0.key.dateAnchor == key.dateAnchor }
        guard !inFlightKeys.contains(key) else {
            // The running request already serves this key; never queue an identical scan.
            return false
        }
        // Shared by timer, filesystem, wake, prefetch and health-recovery paths.
        // A permanently failing input must not consume a full scan budget every tick.
        if let deadline = retryAfter[key], now() < deadline { return false }
        inFlightKeys.insert(key)
        let generation = refreshGeneration
        // Clear stale error on retry start so the UI shows "loading" instead of a stale error.
        errorsByKey[key] = nil
        let spanId = RefreshTracer.shared.beginSpan(
            name: "Fetch \(key.period.rawValue)/\(key.provider.rawValue)",
            category: "refresh", tid: .refresh,
            args: [
                "period": .string(key.period.rawValue),
                "provider": .string(key.provider.rawValue),
                "include_optimize": .bool(includeOptimize),
            ]
        )
        let isBadge = key.period == .today && key.provider == .all && !includeOptimize
        let admission = isBadge ? badgeAdmission : detailAdmission
        let fetcher = fetchPayload
        let task = Task<MenubarPayload, Error> {
            try await admission.acquire()
            do {
                try Task.checkCancellation()
                // Another period's scan may have populated this key while queued.
                if allowCached && self.isFresh(key) { throw CancellationError() }
                self.activeFetchCount += 1
                defer { self.activeFetchCount -= 1 }
                // Hydrate All before a potentially slow history scan. The CLI reads
                // only its small committed rollup, with no provider or price I/O.
                if key.period == .all && !includeOptimize && self.cache[key] == nil,
                   let fetchSaved = self.fetchSavedPayload,
                   let saved = try? await fetchSaved(key.period, key.provider, false),
                   generation == self.refreshGeneration, !Task.isCancelled {
                    try DataClient.validate(saved)
                    self.cache[key] = CachedPayload(payload: saved, fetchedAt: self.now())
                    self.persistPeriods()
                }
                let result = try await fetcher(key.period, key.provider, includeOptimize)
                try Task.checkCancellation()
                if generation == self.refreshGeneration && !includeOptimize {
                    try DataClient.validate(result)
                    // Populate sibling keys before admitting the next queued detail.
                    self.ingestPeriods(from: result, provider: key.provider, dateAnchor: key.dateAnchor)
                }
                await admission.release()
                return result
            } catch {
                await admission.release()
                throw error
            }
        }
        fetchTasks[key] = task
        defer {
            inFlightKeys.remove(key)
            fetchTasks.removeValue(forKey: key)
            if generation != refreshGeneration && (isBadge || key == currentBaseKey) {
                Task { @MainActor in
                    if isBadge { await self.refreshTodayBadge() }
                    else { await self.refreshVisibleSelection() }
                }
            }
        }
        do {
            var fresh = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: { task.cancel() }
            guard generation == refreshGeneration else {
                RefreshTracer.shared.endSpan(spanId, args: ["result": .string("generation_mismatch")])
                return false
            }
            try DataClient.validate(fresh)
            fresh.time = Self.newerTime(cache[key]?.payload.time, fresh.time)
            failureCounts.removeValue(forKey: key)
            retryAfter.removeValue(forKey: key)
            if fresh.savedHistory != nil, let existing = cache[key], existing.payload.current.cost > fresh.current.cost {
                var retained = existing.payload
                retained.savedHistory = fresh.savedHistory
                fresh = retained
            }
            cache[key] = CachedPayload(payload: fresh, fetchedAt: now())
            if !includeOptimize {
                ingestPeriods(from: fresh, provider: key.provider, dateAnchor: key.dateAnchor)
                persistPeriods()
            }
            if isBadge { persistBadge() }
            errorsByKey[key] = nil
            RefreshTracer.shared.endSpan(spanId, args: ["result": .string("success")])
            healthMonitor?.recordFetchResult(success: true)
            if !includeOptimize { scheduleTimeRecovery(fresh.time?.recovery) }
            if !includeOptimize { scheduleHistoryRecovery() }
            return true
        } catch {
            if error is CancellationError {
                RefreshTracer.shared.endSpan(spanId, args: ["result": .string("cancelled")])
                return false
            }
            guard generation == refreshGeneration else {
                RefreshTracer.shared.endSpan(spanId, args: ["result": .string("generation_mismatch")])
                return false
            }
            let failures = min((failureCounts[key] ?? 0) + 1, 5)
            failureCounts[key] = failures
            retryAfter[key] = now().addingTimeInterval(min(300, 30 * pow(2, Double(failures - 1))))
            errorsByKey[key] = Self.describe(error: error)
            NSLog("Exe Watcher: fetch failed for \(key.period.rawValue)/\(key.provider.rawValue): \(error)")
            RefreshTracer.shared.endSpan(spanId, args: [
                "result": .string("error"),
                "error": .string(Self.describe(error: error)),
            ])
            healthMonitor?.recordFetchResult(success: false)
            return false
        }
    }

    private func isFresh(_ key: PayloadCacheKey) -> Bool {
        cache[key]?.isFresh(now: now(), period: key.period) ?? false
    }

    /// Continue only known, advancing history work. Share the normal child gate,
    /// rest for nine times the previous work duration, and stop on any stall/error.
    private func scheduleHistoryRecovery() {
        let target = key(period: .all, provider: .all, includeOptimize: false)
        guard historyRecoveryTask == nil,
              let token = cache[target]?.payload.savedHistory?.progressToken,
              token != pausedHistoryToken else { return }
        let generation = refreshGeneration
        historyRecoveryTask = Task(priority: .utility) { [weak self] in
            guard let self else { return }
            defer { self.historyRecoveryTask = nil }
            var previous = token
            var delay: TimeInterval = 2
            do {
                while !Task.isCancelled {
                    try await self.restForTimeRecovery(delay)
                    try Task.checkCancellation()
                    guard generation == self.refreshGeneration,
                          target.dateAnchor == self.currentBaseKey.dateAnchor else { return }
                    let started = ProcessInfo.processInfo.systemUptime
                    guard await self.refreshKey(target, includeOptimize: false) else {
                        self.pausedHistoryToken = previous; return
                    }
                    guard let next = self.cache[target]?.payload.savedHistory?.progressToken else { return }
                    guard next != previous else { self.pausedHistoryToken = next; return }
                    previous = next
                    delay = max(2, (ProcessInfo.processInfo.systemUptime - started) * 9)
                }
            } catch { /* Cancellation leaves saved amounts and scan progress intact. */ }
        }
    }

    /// Refresh payload for key only when missing or stale.
    private func refreshIfNeeded(_ key: PayloadCacheKey, includeOptimize: Bool) async {
        guard !Task.isCancelled else { return }
        guard !isFresh(key) else { return }
        await refreshKey(key, includeOptimize: includeOptimize, allowCached: true)
    }

    /// Fetch only the requested aggregate. Provider detail loads when its tab is selected.
    func refreshQuietly(period: Period) async {
        let allKey = key(period: period, provider: .all, includeOptimize: false)
        await refreshIfNeeded(allKey, includeOptimize: false)
    }

    /// Silent background refresh for the user-selected state that never blocks tab switching.
    private func refreshForSelectionInBackground(period: Period, provider: ProviderFilter) async {
        // Header/provider tabs depend on the selected period's all-provider payload, so fetch it
        // first. If the user selected .all, this is the only blocking fetch.
        let allKey = key(period: period, provider: .all, includeOptimize: false)
        await refreshIfNeeded(allKey, includeOptimize: false)

        if provider != .all {
            let target = key(period: period, provider: provider, includeOptimize: false)
            await refreshIfNeeded(target, includeOptimize: false)
        }

    }

    func floatingQuota(for provider: QuotaProviderID) -> FloatingQuota {
        if provider == .claude {
            var quota = FloatingQuota(usage: subscription, state: subscriptionLoadState)
            quota.message = subscriptionConnectionMessage
            return quota
        }
        return FloatingQuota(provider: provider, state: providerQuotaStates[provider] ?? ProviderQuotaState())
    }

    func quotaRateLimitedUntil(_ provider: QuotaProviderID) -> Date {
        provider == .claude ? subscriptionRateLimitedUntil : providerQuotaStates[provider]?.rateLimitedUntil ?? .distantPast
    }

    func nextQuotaRefresh(for providers: Set<QuotaProviderID>) -> Date {
        providers.map { $0 == .claude ? subscriptionNextRefreshAt : providerQuotaStates[$0]?.nextRefreshAt ?? .distantPast }.min() ?? .distantFuture
    }

    func refreshFloatingQuotas(_ providers: Set<QuotaProviderID>) async {
        await withTaskGroup(of: Void.self) { group in
            for provider in providers {
                group.addTask { await self.refreshFloatingQuota(provider, allowKeychainPrompt: false) }
            }
        }
    }

    func refreshFloatingQuota(_ provider: QuotaProviderID, allowKeychainPrompt: Bool = true) async {
        if provider == .claude { await refreshSubscription(allowKeychainPrompt: allowKeychainPrompt); return }
        if let task = providerQuotaTasks[provider] { _ = try? await task.value; return }
        var state = providerQuotaStates[provider] ?? ProviderQuotaState()
        let current = now()
        guard current >= state.rateLimitedUntil else { return }
        if !allowKeychainPrompt { guard current >= state.nextRefreshAt else { return } }
        else if state.loadState != .noCredentials { guard current.timeIntervalSince(state.lastAttempt) >= 30 else { return } }
        state.lastAttempt = current
        state.loadState = .loading
        providerQuotaStates[provider] = state
        let fetch = fetchProviderQuota
        let task = Task { try await fetch(provider, allowKeychainPrompt) }
        providerQuotaTasks[provider] = task
        defer { providerQuotaTasks[provider] = nil }
        do {
            let snapshot = try await task.value
            guard snapshot.provider == provider else { throw ProviderQuotaFailure(kind: .invalidResponse) }
            state.snapshot = snapshot
            state.loadState = .loaded
            state.message = nil
            state.nextRefreshAt = now().addingTimeInterval(5 * 60)
            state.rateLimitedUntil = .distantPast
        } catch is CancellationError {
            state.loadState = state.snapshot == nil ? .idle : .loaded
        } catch {
            let failure = error as? ProviderQuotaFailure ?? ProviderQuotaFailure(kind: .unavailable)
            state.nextRefreshAt = now().addingTimeInterval(15 * 60)
            state.loadState = .failed
            state.message = failure.message
            switch failure.kind {
            case .missing:
                state.snapshot = nil; state.loadState = .noCredentials
            case .signIn, .unsupported:
                state.snapshot = nil
                state.message = failure.message ?? provider.signInHelp
            case .unavailable, .invalidResponse, .rateLimited:
                if state.snapshot?.identity != failure.identity { state.snapshot = nil }
                state.message = failure.message ?? "Unable to update this provider. Last known readings, when available, are marked stale."
                if failure.kind == .rateLimited {
                    let delay = max(900, failure.retryAfter ?? 900)
                    state.rateLimitedUntil = now().addingTimeInterval(delay)
                    state.nextRefreshAt = state.rateLimitedUntil
                    state.message = "This provider rate-limited the request. Watcher will retry after its cooldown."
                }
            }
        }
        providerQuotaStates[provider] = state
    }

    /// Fetch Claude subscription usage. Sets subscription = nil on missing creds (API users / unauthenticated).
    /// Shared by Plan and the optional floating display.
    func refreshSubscription(allowKeychainPrompt: Bool = true) async {
        if let task = subscriptionTask { _ = try? await task.value; return }
        let current = now()
        guard current >= subscriptionRateLimitedUntil else { return }
        if !allowKeychainPrompt {
            guard current >= subscriptionNextRefreshAt else { return }
        } else if subscriptionLoadState != .noCredentials {
            guard current.timeIntervalSince(subscriptionLastAttempt) >= 30 else { return }
        }
        subscriptionLastAttempt = current
        subscriptionLoadState = .loading
        let fetch = fetchSubscription
        let task = Task { try await fetch(allowKeychainPrompt) }
        subscriptionTask = task
        defer { subscriptionTask = nil }
        do {
            let usage = try await task.value
            subscription = usage
            subscriptionError = nil
            subscriptionConnectionMessage = nil
            subscriptionLoadState = .loaded
            subscriptionNextRefreshAt = now().addingTimeInterval(5 * 60)
            if persistSubscriptionSnapshots { await captureSnapshots(for: usage) }
        } catch SubscriptionError.noCredentials {
            subscription = nil
            subscriptionError = nil
            subscriptionConnectionMessage = nil
            subscriptionLoadState = .noCredentials
            subscriptionNextRefreshAt = now().addingTimeInterval(15 * 60)
        } catch {
            // A network failure leaves the last reading visible, explicitly stale.
            // Rejected/malformed credentials must not leave another account's reading visible.
            subscriptionConnectionMessage = nil
            switch error {
            case SubscriptionError.keychainAccessRequired:
                subscription = nil
                subscriptionConnectionMessage = "Select Refresh to allow Watcher to read your Claude Code sign-in from Keychain. You can also sign in again below."
            case SubscriptionError.credentialsInvalid,
                 SubscriptionError.usageFetchFailed(401, _),
                 SubscriptionError.usageFetchFailed(403, _),
                 SubscriptionError.refreshFailed(400, _),
                 SubscriptionError.refreshFailed(401, _),
                 SubscriptionError.refreshFailed(403, _):
                subscription = nil
                subscriptionConnectionMessage = "Your Claude sign-in needs to be renewed. Select Sign in with Claude, finish in your browser, then Refresh here."
            case SubscriptionError.usageFetchFailed(429, _), SubscriptionError.refreshFailed(429, _):
                subscriptionRateLimitedUntil = now().addingTimeInterval(15 * 60)
            default: break
            }
            subscriptionError = String(describing: error)
            if case SubscriptionError.keychainAccessRequired = error {
                // Explicit Refresh must be able to request access immediately after
                // a silent startup read; retain the passive fifteen-minute cooldown.
                subscriptionLoadState = .noCredentials
            } else {
                subscriptionLoadState = .failed
            }
            subscriptionNextRefreshAt = now().addingTimeInterval(15 * 60)
            NSLog("Exe Watcher: subscription fetch failed: \(error)")
        }
    }

    func cancelSubscriptionRefresh() {
        subscriptionTask?.cancel()
        for task in providerQuotaTasks.values { task.cancel() }
    }

    /// Persist one snapshot per window so we can answer "what did the prior cycle end at?"
    /// when the current window has just reset and projection from current data isn't meaningful.
    /// Also computes the effective_tokens consumed inside each 7-day window from local history,
    /// which the CapacityEstimator uses to derive the absolute token capacity per tier.
    private func captureSnapshots(for usage: SubscriptionUsage) async {
        let now = Date()
        let history = payload.history.daily

        let captures: [(key: String, percent: Double?, resetsAt: Date?, effective: Double?)] = [
            ("five_hour", usage.fiveHourPercent, usage.fiveHourResetsAt, nil),
            ("seven_day", usage.sevenDayPercent, usage.sevenDayResetsAt,
             effectiveTokensInLast7Days(history: history, asOf: now)),
            ("seven_day_opus", usage.sevenDayOpusPercent, usage.sevenDayOpusResetsAt, nil),
            ("seven_day_sonnet", usage.sevenDaySonnetPercent, usage.sevenDaySonnetResetsAt, nil),
        ]
        for capture in captures {
            guard let percent = capture.percent, let resetsAt = capture.resetsAt else { continue }
            await SubscriptionSnapshotStore.record(SubscriptionSnapshot(
                windowKey: capture.key,
                percent: percent,
                resetsAt: resetsAt,
                capturedAt: now,
                effectiveTokens: capture.effective
            ))
        }

        await refreshCapacityEstimates()
    }

    /// Sum effective tokens (input + 5*output + cache_creation + 0.1*cache_read) across the
    /// last 7 days of dailyHistory. Used as the "tokens consumed in 7-day window" reading paired
    /// with the API-reported percent for capacity estimation.
    private func effectiveTokensInLast7Days(history: [DailyHistoryEntry], asOf now: Date) -> Double {
        let cutoff = ISO8601DateFormatter().string(from: now.addingTimeInterval(-7 * 86400)).prefix(10)
        return history
            .filter { $0.date >= cutoff }
            .reduce(0.0) { $0 + $1.effectiveTokens }
    }

    /// Run CapacityEstimator over each window's accumulated snapshots. Only snapshots with a
    /// non-nil effectiveTokens contribute. Result lives in capacityEstimates dict for UI gating.
    private func refreshCapacityEstimates() async {
        var next: [String: CapacityEstimate] = [:]
        for key in ["seven_day", "seven_day_opus", "seven_day_sonnet"] {
            let snaps = await SubscriptionSnapshotStore.snapshots(for: key)
            let capacitySnaps = snaps.compactMap { s -> CapacitySnapshot? in
                guard let effective = s.effectiveTokens, effective > 0 else { return nil }
                return CapacitySnapshot(percent: s.percent, effectiveTokens: effective, capturedAt: s.capturedAt)
            }
            if let estimate = CapacityEstimator.estimate(capacitySnaps) {
                next[key] = estimate
            }
        }
        capacityEstimates = next
    }

    private static func describe(error: Error) -> String {
        if let localized = (error as? LocalizedError)?.errorDescription, !localized.isEmpty {
            return localized
        }
        return String(describing: error)
    }
}

enum SupportedCurrency: String, CaseIterable, Identifiable {
    case USD, GBP, EUR, AUD, CAD, NZD, JPY, CHF, INR, BRL, SEK, SGD, HKD, KRW, MXN, ZAR, DKK
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .USD: "US Dollar"
        case .GBP: "British Pound"
        case .EUR: "Euro"
        case .AUD: "Australian Dollar"
        case .CAD: "Canadian Dollar"
        case .NZD: "New Zealand Dollar"
        case .JPY: "Japanese Yen"
        case .CHF: "Swiss Franc"
        case .INR: "Indian Rupee"
        case .BRL: "Brazilian Real"
        case .SEK: "Swedish Krona"
        case .SGD: "Singapore Dollar"
        case .HKD: "Hong Kong Dollar"
        case .KRW: "South Korean Won"
        case .MXN: "Mexican Peso"
        case .ZAR: "South African Rand"
        case .DKK: "Danish Krone"
        }
    }
}

enum ProviderFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case claude = "Claude"
    case codex = "Codex"
    case cursor = "Cursor"
    case cursorAgent = "Cursor Agent"
    case copilot = "Copilot"
    case opencode = "OpenCode"
    case kimi = "Kimi"
    case omp = "OMP"
    case pi = "Pi"

    var id: String { rawValue }

    /// Maps to the CLI's `--provider` argument values.
    var cliArg: String {
        switch self {
        case .all: "all"
        case .claude: "claude"
        case .codex: "codex"
        case .cursor: "cursor"
        case .cursorAgent: "cursor-agent"
        case .copilot: "copilot"
        case .opencode: "opencode"
        case .kimi: "kimi"
        case .omp: "omp"
        case .pi: "pi"
        }
    }
}

enum SubscriptionLoadState: Sendable, Equatable {
    case idle           // never tried, awaiting user intent
    case loading        // fetch in progress
    case loaded         // success; subscription is populated
    case noCredentials  // tried; user has no Claude OAuth (API user / not logged in)
    case failed         // tried; error occurred
}

enum InsightMode: String, CaseIterable, Identifiable {
    case plan = "Usage"
    case trend = "Trend"
    case forecast = "Forecast"
    case pulse = "Pulse"
    case stats = "Stats"
    var id: String { rawValue }
}

enum Period: String, CaseIterable, Identifiable {
    case today = "Today"
    case sevenDays = "7 Days"
    case thirtyDays = "30 Days"
    case month = "Month"
    case all = "All"

    var id: String { rawValue }

    /// Maps to the CLI's `--period` argument values.
    var cliArg: String {
        switch self {
        case .today: "today"
        case .sevenDays: "week"
        case .thirtyDays: "30days"
        case .month: "month"
        case .all: "all"
        }
    }
}

/// NumberFormatter is expensive to instantiate (~microseconds each) and currency/token values
/// are formatted dozens of times per popover refresh. These shared instances avoid thousands of
/// allocations per frame while SwiftUI's Observation framework still triggers redraws when
/// CurrencyState.shared mutates.
private let groupedDecimalFormatter: NumberFormatter = {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.groupingSeparator = ","
    f.decimalSeparator = "."
    f.maximumFractionDigits = 2
    f.minimumFractionDigits = 2
    return f
}()

private let thousandsFormatter: NumberFormatter = {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.groupingSeparator = ","
    return f
}()

extension Double {
    func asCurrency() -> String {
        let state = CurrencyState.shared
        let converted = self * state.rate
        return state.symbol + (groupedDecimalFormatter.string(from: NSNumber(value: converted)) ?? "\(converted)")
    }

    func asCompactCurrency() -> String {
        let state = CurrencyState.shared
        return String(format: "\(state.symbol)%.2f", self * state.rate)
    }

    func asCompactCurrencyWhole() -> String {
        let state = CurrencyState.shared
        let whole = Int((self * state.rate).rounded())
        let formatted = thousandsFormatter.string(from: NSNumber(value: whole)) ?? "\(whole)"
        return "\(state.symbol)\(formatted)"
    }
}

extension Int {
    func asThousandsSeparated() -> String {
        thousandsFormatter.string(from: NSNumber(value: self)) ?? "\(self)"
    }
}
