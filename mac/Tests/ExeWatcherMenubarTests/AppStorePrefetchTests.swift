import Foundation
import Testing
@testable import ExeWatcherMenubar

private func makePayload(
    label: String,
    cost: Double,
    providers: [String: Double]
) -> MenubarPayload {
    MenubarPayload(
        generated: "2026-05-04T00:00:00Z",
            cliVersion: nil,
            minAppVersion: nil,
        current: CurrentBlock(
            label: label,
            cost: cost,
            calls: Int(cost),
            sessions: 1,
            oneShotRate: nil,
            inputTokens: 0,
            outputTokens: 0,
            cacheHitPercent: 0,
            topActivities: [],
            topModels: [],
            providers: providers
        ),
        optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
        history: HistoryBlock(daily: []),
        diagnostics: nil,
        agentStats: nil,
        exeOsDetected: nil,
        statsFileAge: nil,
        projectSpend: nil
    )
}

private actor FetchRecorder {
    private let payloads: [PayloadCacheKey: MenubarPayload]
    private let now: @Sendable () -> Date
    private var calls: [PayloadCacheKey] = []

    init(payloads: [PayloadCacheKey: MenubarPayload], now: @escaping @Sendable () -> Date = Date.init) {
        self.payloads = payloads
        self.now = now
    }

    func fetch(period: Period, provider: ProviderFilter, includeOptimize: Bool) async throws -> MenubarPayload {
        let key = PayloadCacheKey(period: period, provider: provider, includeOptimize: includeOptimize, now: now())
        calls.append(key)
        guard let payload = payloads[key] else {
            throw NSError(domain: "FetchRecorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing payload for \(key)"])
        }
        return payload
    }

    func recordedKeys() -> [PayloadCacheKey] {
        calls
    }
}

private final class TestClock: @unchecked Sendable {
    var now: Date

    init(_ now: Date) {
        self.now = now
    }
}

private actor CallCounter {
    private var count = 0

    func next() -> Int {
        count += 1
        return count
    }

    func value() -> Int {
        count
    }
}

/// A simple gate that blocks waiters until opened.
private actor Gate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        await withCheckedContinuation { cont in
            waiters.append(cont)
        }
    }

    func open() {
        opened = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }
}

@Suite("AppStore provider prefetch")
struct AppStoreProviderPrefetchTests {
    @Test("refreshQuietly renders aggregate first and warms visible providers")
    @MainActor
    func prefetchesVisibleProvidersOnInitialLoad() async throws {
        let allKey = PayloadCacheKey(period: .today, provider: .all)
        let claudeKey = PayloadCacheKey(period: .today, provider: .claude)
        let codexKey = PayloadCacheKey(period: .today, provider: .codex)

        let recorder = FetchRecorder(payloads: [
            allKey: makePayload(label: "Today", cost: 18, providers: ["claude": 12, "codex": 6]),
            claudeKey: makePayload(label: "Today", cost: 12, providers: ["claude": 12]),
            codexKey: makePayload(label: "Today", cost: 6, providers: ["codex": 6]),
        ])

        let store = AppStore(fetchPayload: { period, provider, includeOptimize in
            try await recorder.fetch(period: period, provider: provider, includeOptimize: includeOptimize)
        })

        await store.refreshQuietly(period: .today)

        // The aggregate all-provider payload should be available immediately; provider-specific
        // payloads are now warmed asynchronously so selected-period views do not block behind
        // multiple serial CLI scans.
        #expect(store.allProviderPayloadForPeriod?.current.cost == 18)

        try await Task.sleep(nanoseconds: 50_000_000)
        let keys = await recorder.recordedKeys()
        #expect(keys.contains(allKey))
        #expect(keys.contains(claudeKey))
        #expect(keys.contains(codexKey))
    }

    @Test("period switch prefetches that period's providers so tab switch is instant from cache")
    @MainActor
    func periodSwitchWarmsProviderTabs() async throws {
        let todayAll = PayloadCacheKey(period: .today, provider: .all)
        let todayClaude = PayloadCacheKey(period: .today, provider: .claude)
        let weekAll = PayloadCacheKey(period: .sevenDays, provider: .all)
        let weekClaude = PayloadCacheKey(period: .sevenDays, provider: .claude)
        let weekCodex = PayloadCacheKey(period: .sevenDays, provider: .codex)

        let recorder = FetchRecorder(payloads: [
            todayAll: makePayload(label: "Today", cost: 18, providers: ["claude": 12]),
            todayClaude: makePayload(label: "Today", cost: 12, providers: ["claude": 12]),
            weekAll: makePayload(label: "Last 7 Days", cost: 100, providers: ["claude": 70, "codex": 30]),
            weekClaude: makePayload(label: "Last 7 Days", cost: 70, providers: ["claude": 70]),
            weekCodex: makePayload(label: "Last 7 Days", cost: 30, providers: ["codex": 30]),
        ])

        let store = AppStore(fetchPayload: { period, provider, includeOptimize in
            try await recorder.fetch(period: period, provider: provider, includeOptimize: includeOptimize)
        })

        await store.refreshQuietly(period: .today)
        await store.switchTo(period: .sevenDays)
        try await Task.sleep(nanoseconds: 50_000_000)

        let keysAfterPeriodSwitch = await recorder.recordedKeys()
        #expect(keysAfterPeriodSwitch.contains(weekAll))
        #expect(keysAfterPeriodSwitch.contains(weekClaude))
        #expect(keysAfterPeriodSwitch.contains(weekCodex))

        let callCountBeforeTabSwitch = keysAfterPeriodSwitch.count
        await store.switchTo(provider: .claude)
        #expect(store.payload.current.cost == 70)

        try await Task.sleep(nanoseconds: 50_000_000)
        let callCountAfterTabSwitch = await recorder.recordedKeys().count
        #expect(callCountAfterTabSwitch == callCountBeforeTabSwitch)
    }

    @Test("rapid period switches cancel the prior prefetch so only the latest runs")
    @MainActor
    func prefetchCancellationOnRapidSwitch() async throws {
        let todayAll = PayloadCacheKey(period: .today, provider: .all)
        let weekAll = PayloadCacheKey(period: .sevenDays, provider: .all)
        let weekClaude = PayloadCacheKey(period: .sevenDays, provider: .claude)
        let weekCodex = PayloadCacheKey(period: .sevenDays, provider: .codex)

        let providerFetchCount = CallCounter()

        let store = AppStore(
            fetchPayload: { period, provider, _ in
                if provider != .all {
                    // Provider-specific prefetch — slow to simulate CLI scan time.
                    try await Task.sleep(nanoseconds: 50_000_000)
                    guard !Task.isCancelled else { throw CancellationError() }
                    await providerFetchCount.next()
                }
                let cost: Double = period == .today ? 18 : 100
                let providers: [String: Double] = period == .today
                    ? ["claude": 12]
                    : ["claude": 70, "codex": 30]
                return makePayload(label: period.rawValue, cost: cost, providers: providers)
            }
        )

        // First refreshQuietly triggers today prefetch (1 provider: claude).
        await store.refreshQuietly(period: .today)
        // Immediately switch to 7 days — should cancel today's prefetch and start week's.
        await store.refreshQuietly(period: .sevenDays)

        // Wait for the winning (week) prefetch to complete.
        try await Task.sleep(nanoseconds: 150_000_000)

        let completedCount = await providerFetchCount.value()
        // At most the week's 2 providers should complete. Today's claude prefetch
        // should have been cancelled. Total should be <= 2 (week's claude + codex).
        #expect(completedCount <= 2)
        #expect(completedCount >= 1) // at least one week provider completed
    }

    @Test("optimize payload stays attached after a later base refresh for the same visible selection")
    @MainActor
    func optimizePayloadSurvivesBaseRefresh() async throws {
        let startOfDay = ISO8601DateFormatter().date(from: "2026-05-04T00:00:00Z")!
        let clock = TestClock(startOfDay)

        let baseKey = PayloadCacheKey(period: .today, provider: .all, includeOptimize: false, now: clock.now)
        let optimizeKey = PayloadCacheKey(period: .today, provider: .all, includeOptimize: true, now: clock.now)

        let recorder = FetchRecorder(payloads: [
            baseKey: makePayload(label: "Today", cost: 18, providers: ["claude": 12]),
            optimizeKey: MenubarPayload(
                generated: "2026-05-04T00:00:00Z",
            cliVersion: nil,
            minAppVersion: nil,
                current: CurrentBlock(
                    label: "Today",
                    cost: 18,
                    calls: 18,
                    sessions: 1,
                    oneShotRate: nil,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheHitPercent: 0,
                    topActivities: [],
                    topModels: [],
                    providers: ["claude": 12]
                ),
                optimize: OptimizeBlock(findingCount: 3, savingsUSD: 12, topFindings: []),
                history: HistoryBlock(daily: []),
                diagnostics: nil,
                agentStats: nil,
                exeOsDetected: nil,
                statsFileAge: nil,
                projectSpend: nil
            ),
        ], now: { clock.now })

        let store = AppStore(
            fetchPayload: { period, provider, includeOptimize in
                try await recorder.fetch(period: period, provider: provider, includeOptimize: includeOptimize)
            },
            now: { clock.now }
        )

        await store.refreshQuietly(period: .today)
        #expect(store.payload.optimize.findingCount == 0)

        await store.refresh(includeOptimize: true)
        #expect(store.payload.optimize.findingCount == 3)

        clock.now = startOfDay.addingTimeInterval(31)
        await store.refreshQuietly(period: .today)
        #expect(store.payload.optimize.findingCount == 3)
    }


    @Test("today badge refresh bypasses cache TTL so the menu bar cannot appear stuck")
    @MainActor
    func todayBadgeRefreshBypassesCacheTTL() async throws {
        let day = ISO8601DateFormatter().date(from: "2026-05-04T12:00:00Z")!
        let clock = TestClock(day)
        let counter = CallCounter()

        let store = AppStore(
            fetchPayload: { period, provider, includeOptimize in
                #expect(period == .today)
                #expect(provider == .all)
                #expect(includeOptimize == false)
                let value = await counter.next()
                return makePayload(label: "Today", cost: Double(value), providers: ["claude": Double(value)])
            },
            now: { clock.now }
        )

        await store.refreshTodayBadge()
        #expect(await counter.value() == 1)
        #expect(store.payload.current.cost == 1)

        // Even one second later, the badge timer must fetch fresh data instead of reusing
        // the 30s cache. The timer itself runs every 30s, so jitter around that boundary
        // previously caused skipped refreshes and a stale-looking menu bar total.
        clock.now = day.addingTimeInterval(1)
        await store.refreshTodayBadge()
        #expect(await counter.value() == 2)
        #expect(store.payload.current.cost == 2)

        // Badge refresh must not kick off provider/detail prefetches; those historical/detail
        // scans are allowed only when the popover selection asks for them.
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(await counter.value() == 2)
    }


    @Test("badge refresh records diagnostics for attempts successes and failures")
    @MainActor
    func badgeRefreshRecordsDiagnostics() async throws {
        enum TestError: Error { case failed }
        let day = ISO8601DateFormatter().date(from: "2026-05-04T12:00:00Z")!
        let clock = TestClock(day)
        let counter = CallCounter()

        let store = AppStore(
            fetchPayload: { _, _, _ in
                let value = await counter.next()
                if value == 1 {
                    return makePayload(label: "Today", cost: 1, providers: [:])
                }
                throw TestError.failed
            },
            now: { clock.now }
        )

        await store.refreshTodayBadge()
        #expect(store.lastBadgeRefreshAttemptAt == day)
        #expect(store.lastBadgeRefreshSuccessAt == day)
        #expect(store.lastBadgeRefreshError == nil)
        #expect(store.activeFetchCount == 0)

        clock.now = day.addingTimeInterval(1)
        await store.refreshTodayBadge()
        #expect(store.lastBadgeRefreshAttemptAt == clock.now)
        #expect(store.lastBadgeRefreshSuccessAt == day)
        #expect(store.lastBadgeRefreshError != nil)
        #expect(store.activeFetchCount == 0)
    }

    @Test("today cache key rolls at the day boundary so stale yesterday payloads are not reused")
    @MainActor
    func todayCacheKeyRollsAtDayBoundary() async throws {
        let dayOne = ISO8601DateFormatter().date(from: "2026-05-04T12:00:00Z")!
        let clock = TestClock(dayOne)
        let counter = CallCounter()

        let store = AppStore(
            fetchPayload: { _, _, _ in
                let value = await counter.next()
                return makePayload(label: "Today", cost: Double(value), providers: [:])
            },
            now: { clock.now }
        )

        await store.refreshQuietly(period: .today)
        #expect(await counter.value() == 1)
        #expect(store.payload.current.cost == 1)

        await store.refreshQuietly(period: .today)
        #expect(await counter.value() == 1)

        clock.now = dayOne.addingTimeInterval(24 * 60 * 60)
        await store.refreshQuietly(period: .today)
        #expect(await counter.value() == 2)
        #expect(store.payload.current.cost == 2)
    }

    @Test("diagnostic warnings alone do not mark fresh data as stale")
    @MainActor
    func diagnosticWarningsDoNotMarkFreshDataStale() async throws {
        let startOfDay = ISO8601DateFormatter().date(from: "2026-05-04T00:00:00Z")!
        let clock = TestClock(startOfDay)
        let payload = MenubarPayload(
            generated: "2026-05-04T00:00:00Z",
            cliVersion: nil,
            minAppVersion: nil,
            current: CurrentBlock(
                label: "Today",
                cost: 12,
                calls: 1,
                sessions: 1,
                oneShotRate: nil,
                inputTokens: 0,
                outputTokens: 0,
                cacheHitPercent: 0,
                topActivities: [],
                topModels: [],
                providers: [:]
            ),
            optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
            history: HistoryBlock(daily: []),
            diagnostics: DiagnosticsBlock(daysCount: 1, parseTimeMs: 10, warnings: ["Codex session file format may have changed"]),
            agentStats: nil,
            exeOsDetected: nil,
            statsFileAge: 39,
            projectSpend: nil
        )
        let recorder = FetchRecorder(payloads: [
            PayloadCacheKey(period: .today, provider: .all, includeOptimize: false, now: clock.now): payload,
        ], now: { clock.now })
        let store = AppStore(
            fetchPayload: { period, provider, includeOptimize in
                try await recorder.fetch(period: period, provider: provider, includeOptimize: includeOptimize)
            },
            now: { clock.now }
        )

        await store.refreshQuietly(period: .today)

        #expect(store.payload.diagnostics?.warnings.isEmpty == false)
        #expect(store.dataMayBeStale == false)
    }

    @Test("header stays anchored to the all-provider total when a provider tab is selected")
    @MainActor
    func headerUsesSelectedPeriodSummary() async throws {
        let weekAll = PayloadCacheKey(period: .sevenDays, provider: .all)
        let weekClaude = PayloadCacheKey(period: .sevenDays, provider: .claude)
        let weekCodex = PayloadCacheKey(period: .sevenDays, provider: .codex)

        let recorder = FetchRecorder(payloads: [
            weekAll: makePayload(label: "Last 7 Days", cost: 100, providers: ["claude": 70, "codex": 30]),
            weekClaude: makePayload(label: "Last 7 Days", cost: 70, providers: ["claude": 70]),
            weekCodex: makePayload(label: "Last 7 Days", cost: 30, providers: ["codex": 30]),
        ])

        let store = AppStore(fetchPayload: { period, provider, includeOptimize in
            try await recorder.fetch(period: period, provider: provider, includeOptimize: includeOptimize)
        })

        await store.refreshQuietly(period: .sevenDays)
        await store.switchTo(period: .sevenDays)
        await store.switchTo(provider: .claude)
        try await Task.sleep(nanoseconds: 50_000_000)

        #expect(store.payload.current.cost == 70)
        #expect(store.headerPayload.current.cost == 100)
        #expect(store.allProviderPayloadForPeriod?.current.cost == 100)
        #expect(store.showProviderTabs)
    }

    @Test("failed historical periods do not reuse today's provider tabs")
    @MainActor
    func failedHistoricalPeriodDoesNotShowTodayTabs() async throws {
        let todayAll = PayloadCacheKey(period: .today, provider: .all)
        let todayClaude = PayloadCacheKey(period: .today, provider: .claude)
        let todayCodex = PayloadCacheKey(period: .today, provider: .codex)

        let recorder = FetchRecorder(payloads: [
            todayAll: makePayload(label: "Today", cost: 18, providers: ["claude": 12, "codex": 6]),
            todayClaude: makePayload(label: "Today", cost: 12, providers: ["claude": 12]),
            todayCodex: makePayload(label: "Today", cost: 6, providers: ["codex": 6]),
        ])

        let store = AppStore(fetchPayload: { period, provider, includeOptimize in
            try await recorder.fetch(period: period, provider: provider, includeOptimize: includeOptimize)
        })

        await store.refreshQuietly(period: .today)
        #expect(store.showProviderTabs)

        await store.switchTo(period: .sevenDays)
        try await Task.sleep(nanoseconds: 50_000_000)

        #expect(store.providerTabsPayload == nil)
        #expect(!store.showProviderTabs)
        #expect(store.lastError != nil)
    }

    @Test("badge refresh succeeds even when detail fetches saturate inFlightKeys")
    @MainActor
    func badgeRefreshNotBlockedByDetailFetches() async throws {
        let day = ISO8601DateFormatter().date(from: "2026-05-04T12:00:00Z")!
        let clock = TestClock(day)
        let badgeCounter = CallCounter()
        let gate = Gate()

        let store = AppStore(
            fetchPayload: { period, provider, includeOptimize in
                if period == .today && provider == .all && !includeOptimize {
                    // Badge path — completes immediately.
                    let value = await badgeCounter.next()
                    return makePayload(label: "Today", cost: Double(value), providers: [:])
                }
                // Detail path — blocks until gate is opened.
                await gate.wait()
                return makePayload(label: "Detail", cost: 99, providers: ["claude": 99])
            },
            now: { clock.now }
        )

        // Switch to a non-today period so the detail fetch uses a different inFlightKeys slot.
        await store.switchTo(period: .sevenDays)
        // Give the background refresh time to enter inFlightKeys.
        try await Task.sleep(nanoseconds: 10_000_000)

        // Badge must still succeed despite detail fetch being in-flight.
        await store.refreshTodayBadge()
        #expect(await badgeCounter.value() == 1)
        #expect(store.todayPayload?.current.cost == 1)

        // Clean up: release the detail gate and cancel the task.
        await gate.open()
    }

    @Test("system resume holds admission until old work exits and then refreshes")
    @MainActor
    func systemResumeRecoversFromStuckLoading() async throws {
        let gate = Gate()
        let weekFetchCount = CallCounter()

        let store = AppStore(
            fetchPayload: { period, provider, includeOptimize in
                if period == .sevenDays && provider == .all && !includeOptimize {
                    let value = await weekFetchCount.next()
                    if value == 1 {
                        // Simulate a CLI scan that was in progress when the Mac locked/slept.
                        await gate.wait()
                        return makePayload(label: "Stale Week", cost: 99, providers: ["claude": 99])
                    }
                    return makePayload(label: "Fresh Week", cost: 42, providers: ["claude": 42])
                }
                return makePayload(label: period.rawValue, cost: 1, providers: [:])
            }
        )

        await store.switchTo(period: .sevenDays)
        try await Task.sleep(nanoseconds: 10_000_000)
        #expect(store.isCurrentSelectionLoading)

        store.recoverFromSystemResume()
        #expect(store.isCurrentSelectionLoading)
        #expect(store.activeFetchCount == 1)
        await store.refreshVisibleSelection()
        #expect(await weekFetchCount.value() == 1)
        // The cancelled, deliberately non-cooperative fake must leave before re-admission.
        await gate.open()
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(await weekFetchCount.value() == 2)
        #expect(store.payload.current.cost == 42)
    }

    @Test("a failed historical fetch does not contaminate the cached today view")
    @MainActor
    func historicalFailureDoesNotLeakIntoToday() async throws {
        let todayAll = PayloadCacheKey(period: .today, provider: .all)
        let todayClaude = PayloadCacheKey(period: .today, provider: .claude)

        let recorder = FetchRecorder(payloads: [
            todayAll: makePayload(label: "Today", cost: 18, providers: ["claude": 12]),
            todayClaude: makePayload(label: "Today", cost: 12, providers: ["claude": 12]),
        ])

        let store = AppStore(fetchPayload: { period, provider, includeOptimize in
            try await recorder.fetch(period: period, provider: provider, includeOptimize: includeOptimize)
        })

        await store.refreshQuietly(period: .today)
        await store.switchTo(period: .sevenDays)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(store.lastError != nil)

        await store.switchTo(period: .today)
        try await Task.sleep(nanoseconds: 50_000_000)

        #expect(store.lastError == nil)
        #expect(store.headerPayload.current.cost == 18)
        #expect(store.showProviderTabs)
    }
}
