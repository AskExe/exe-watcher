import Foundation
import Observation

private let todayCacheTTLSeconds: TimeInterval = 30
private let historicalCacheTTLSeconds: TimeInterval = 5 * 60
typealias MenubarPayloadFetcher = @Sendable (Period, ProviderFilter, Bool) async throws -> MenubarPayload
typealias AppStoreDateProvider = @Sendable () -> Date

struct CachedPayload {
    let payload: MenubarPayload
    let fetchedAt: Date
    func isFresh(now: Date, period: Period) -> Bool {
        let ttl = period == .today ? todayCacheTTLSeconds : historicalCacheTTLSeconds
        return now.timeIntervalSince(fetchedAt) < ttl
    }
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
    var subscription: SubscriptionUsage?
    var subscriptionError: String?
    var subscriptionLoadState: SubscriptionLoadState = .idle
    var capacityEstimates: [String: CapacityEstimate] = [:]

    /// Lightweight self-diagnostics for the menubar refresh loop. These make stale-counter bugs
    /// visible instead of forcing us to infer state from screenshots or process lists.
    private(set) var activeFetchCount: Int = 0
    private(set) var lastBadgeRefreshAttemptAt: Date?
    private(set) var lastBadgeRefreshSuccessAt: Date?
    private(set) var lastBadgeRefreshError: String?

    /// Health monitor for self-healing feedback loop. Initialized by AppDelegate after launch.
    var healthMonitor: HealthMonitor?

    private let fetchPayload: MenubarPayloadFetcher
    private let now: AppStoreDateProvider
    private var cache: [PayloadCacheKey: CachedPayload] = [:]
    private var errorsByKey: [PayloadCacheKey: String] = [:]
    private var retryAfter: [PayloadCacheKey: Date] = [:]
    private var failureCounts: [PayloadCacheKey: Int] = [:]

    /// Badge has its own dedicated fetch slot so detail/prefetch fetches can never starve it.
    private let badgeAdmission = FetchAdmission(limit: 1)
    private let detailAdmission = FetchAdmission(limit: 1)
    private var fetchTasks: [PayloadCacheKey: Task<MenubarPayload, Error>] = [:]
    /// Handle to the most recent prefetch Task so we can cancel it before spawning a new one.
    private var activePrefetchTask: Task<Void, Never>?
    /// Incremented when macOS resumes/unlocks and we intentionally discard stale in-flight
    /// bookkeeping. Fetches that started before the generation changed are ignored on return so
    /// a pre-lock CLI scan cannot overwrite the fresh post-unlock payload.
    private var refreshGeneration: UInt64 = 0

    init(
        fetchPayload: @escaping MenubarPayloadFetcher = DataClient.fetch,
        now: @escaping AppStoreDateProvider = Date.init
    ) {
        self.fetchPayload = fetchPayload
        self.now = now
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
                projectSpend: body.projectSpend
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

    /// True when the visible data may be unreliable — either because the last refresh failed
    /// (error-based) or because no successful refresh has landed recently (age-based). The
    /// age-based check catches silent hangs that produce no error: the old Task.sleep bug would
    /// leave fetchPayload suspended forever with no error logged, so stale data looked healthy.
    /// Threshold: 2x the idle timer interval (10 min) gives enough margin for slow CLI scans
    /// while still surfacing genuine staleness within a reasonable window.
    private static let staleAgeLimitSeconds: TimeInterval = 600
    var dataMayBeStale: Bool {
        if baseLastError != nil { return true }
        guard let lastSuccess = lastBadgeRefreshSuccessAt else { return false }
        return now().timeIntervalSince(lastSuccess) > Self.staleAgeLimitSeconds
    }

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

    /// Pre-fetch all periods so tab switching is instant from cache.
    func prefetchAllPeriods() async {
        for period in Period.allCases where period != .today {
            await refreshQuietly(period: period)
        }
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
    /// speculative prefetch, and ignore any old fetch that eventually returns.
    func recoverFromSystemResume() {
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
        activePrefetchTask?.cancel()
        activePrefetchTask = nil
    }

    private var inFlightKeys: Set<PayloadCacheKey> = []

    /// Refresh the currently selected (period, provider) combination. Guards against concurrent
    /// fetches for the same key so a slow initial request can't overwrite a newer one that
    /// finished first (which would show stale numbers the user has already moved past).
    func refresh(includeOptimize: Bool) async {
        let target = key(period: selectedPeriod, provider: selectedProvider, includeOptimize: includeOptimize)
        await refreshKey(target, includeOptimize: includeOptimize)
    }

    /// Badge and detail requests share same-key ownership. The reserved badge lane
    /// remains within the total two-fetch budget instead of bypassing accounting.
    func refreshTodayBadge() async {
        let target = key(period: .today, provider: .all, includeOptimize: false)
        lastBadgeRefreshAttemptAt = now()
        guard !inFlightKeys.contains(target) else { return }
        let success = await refreshKey(target, includeOptimize: false)
        if success {
            lastBadgeRefreshSuccessAt = now()
            lastBadgeRefreshError = nil
        } else if let error = errorsByKey[target] {
            lastBadgeRefreshError = error
        }
    }

    @discardableResult
    private func refreshKey(_ key: PayloadCacheKey, includeOptimize: Bool) async -> Bool {
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
                self.activeFetchCount += 1
                defer { self.activeFetchCount -= 1 }
                let result = try await fetcher(key.period, key.provider, includeOptimize)
                try Task.checkCancellation()
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
            let fresh = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: { task.cancel() }
            guard generation == refreshGeneration else {
                RefreshTracer.shared.endSpan(spanId, args: ["result": .string("generation_mismatch")])
                return false
            }
            failureCounts.removeValue(forKey: key)
            retryAfter.removeValue(forKey: key)
            cache[key] = CachedPayload(payload: fresh, fetchedAt: now())
            errorsByKey[key] = nil
            RefreshTracer.shared.endSpan(spanId, args: ["result": .string("success")])
            healthMonitor?.recordFetchResult(success: true)
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

    /// Refresh payload for key only when missing or stale.
    private func refreshIfNeeded(_ key: PayloadCacheKey, includeOptimize: Bool) async {
        guard !Task.isCancelled else { return }
        guard !isFresh(key) else { return }
        await refreshKey(key, includeOptimize: includeOptimize)
    }

    /// Silent background refresh — does NOT toggle isLoading, so the popover loading overlay
    /// never flashes. Used by the timer loop and launch prefetch.
    /// Refreshes the .all-provider payload first and returns as soon as that visible aggregate
    /// is ready. Provider-specific payloads warm in the background so period switches don't sit
    /// behind N serial CLI scans (the 30-day view was doing all + Claude + Codex + ... before
    /// rendering).
    func refreshQuietly(period: Period) async {
        let allKey = key(period: period, provider: .all, includeOptimize: false)
        await refreshIfNeeded(allKey, includeOptimize: false)
        scheduleVisibleProviderPrefetch(for: period)
    }

    private func visibleProviderKeys(for period: Period) -> [PayloadCacheKey] {
        guard let payload = mergedPayload(period: period, provider: .all) else { return [] }

        return ProviderFilter.allCases
            .filter { $0 != .all }
            .compactMap { filter in
                let hasSpend = payload.current.providers.contains { key, cost in
                    cost > 0 && key.lowercased() == filter.rawValue.lowercased()
                }
                return hasSpend ? key(period: period, provider: filter, includeOptimize: false) : nil
            }
    }

    /// Fire-and-forget provider prefetch. This is deliberately not awaited by selected-period
    /// loads; it is an optimization for future tab switches, not a prerequisite for showing the
    /// selected period's aggregate dashboard.
    private func scheduleVisibleProviderPrefetch(for period: Period) {
        let keys = visibleProviderKeys(for: period)
        guard !keys.isEmpty else { return }
        // Cancel any previously spawned prefetch to prevent accumulation.
        activePrefetchTask?.cancel()
        activePrefetchTask = Task { @MainActor in
            await withTaskGroup(of: Void.self) { group in
                for key in keys {
                    guard !Task.isCancelled else { break }
                    group.addTask { await self.refreshIfNeeded(key, includeOptimize: false) }
                }
            }
        }
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

        scheduleVisibleProviderPrefetch(for: period)
    }

    /// Fetch Claude subscription usage. Sets subscription = nil on missing creds (API users / unauthenticated).
    /// Triggered lazily when the user opens the Usage tab.
    func refreshSubscription() async {
        subscriptionLoadState = .loading
        do {
            let usage = try await SubscriptionClient.fetch()
            subscription = usage
            subscriptionError = nil
            subscriptionLoadState = .loaded
            await captureSnapshots(for: usage)
        } catch SubscriptionError.noCredentials {
            subscription = nil
            subscriptionError = nil
            subscriptionLoadState = .noCredentials
        } catch {
            subscription = nil
            subscriptionError = String(describing: error)
            subscriptionLoadState = .failed
            NSLog("Exe Watcher: subscription fetch failed: \(error)")
        }
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
