import Foundation
import Testing
@testable import ExeWatcherMenubar

private func makePayload(
    label: String,
    cost: Double,
    providers: [String: Double]
) -> MenubarPayload {
    MenubarPayload(
        generated: "2026-05-07T00:00:00Z",
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

@Suite("Cache isolation")
struct CacheIsolationTests {
    @Test("different (period, provider) combos have distinct cache entries")
    @MainActor
    func cacheKeyUniqueness() async throws {
        let todayAll = PayloadCacheKey(period: .today, provider: .all)
        let todayClaude = PayloadCacheKey(period: .today, provider: .claude)
        let weekAll = PayloadCacheKey(period: .sevenDays, provider: .all)
        let weekClaude = PayloadCacheKey(period: .sevenDays, provider: .claude)

        let recorder = FetchRecorder(payloads: [
            todayAll: makePayload(label: "Today", cost: 18, providers: ["claude": 12, "codex": 6]),
            todayClaude: makePayload(label: "Today", cost: 12, providers: ["claude": 12]),
            weekAll: makePayload(label: "Last 7 Days", cost: 100, providers: ["claude": 70, "codex": 30]),
            weekClaude: makePayload(label: "Last 7 Days", cost: 70, providers: ["claude": 70]),
        ])

        let store = AppStore(fetchPayload: { period, provider, includeOptimize in
            try await recorder.fetch(period: period, provider: provider, includeOptimize: includeOptimize)
        })

        // Load today
        await store.refreshQuietly(period: .today)
        #expect(store.payload.current.cost == 18)

        // Switch to 7 Days — should get the week payload, not today's
        await store.switchTo(period: .sevenDays)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(store.payload.current.cost == 100)

        // Switch provider to Claude on 7 Days
        await store.switchTo(provider: .claude)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(store.payload.current.cost == 70)

        // Switch back to today — should restore today's cost, not leak week data
        await store.switchTo(period: .today)
        await store.switchTo(provider: .all)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(store.payload.current.cost == 18)
    }

    @Test("error for (sevenDays, all) does not surface when viewing (today, all)")
    @MainActor
    func errorIsolationPerKey() async throws {
        let todayAll = PayloadCacheKey(period: .today, provider: .all)
        let todayClaude = PayloadCacheKey(period: .today, provider: .claude)
        let todayCodex = PayloadCacheKey(period: .today, provider: .codex)

        // Only today payloads exist; sevenDays will fail
        let recorder = FetchRecorder(payloads: [
            todayAll: makePayload(label: "Today", cost: 18, providers: ["claude": 12, "codex": 6]),
            todayClaude: makePayload(label: "Today", cost: 12, providers: ["claude": 12]),
            todayCodex: makePayload(label: "Today", cost: 6, providers: ["codex": 6]),
        ])

        let store = AppStore(fetchPayload: { period, provider, includeOptimize in
            try await recorder.fetch(period: period, provider: provider, includeOptimize: includeOptimize)
        })

        // Load today successfully
        await store.refreshQuietly(period: .today)
        #expect(store.lastError == nil)

        // Switch to 7 Days — fetch will fail
        await store.switchTo(period: .sevenDays)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(store.lastError != nil)

        // Switch back to today — error should NOT carry over
        await store.switchTo(period: .today)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(store.lastError == nil)
        #expect(store.payload.current.cost == 18)
    }

    @Test("provider payload from today does not leak into 7 Days view")
    @MainActor
    func providerPayloadDoesNotLeakAcrossPeriods() async throws {
        let todayAll = PayloadCacheKey(period: .today, provider: .all)
        let todayClaude = PayloadCacheKey(period: .today, provider: .claude)
        let todayCodex = PayloadCacheKey(period: .today, provider: .codex)

        // Only today payloads exist; sevenDays has no data
        let recorder = FetchRecorder(payloads: [
            todayAll: makePayload(label: "Today", cost: 18, providers: ["claude": 12, "codex": 6]),
            todayClaude: makePayload(label: "Today", cost: 12, providers: ["claude": 12]),
            todayCodex: makePayload(label: "Today", cost: 6, providers: ["codex": 6]),
        ])

        let store = AppStore(fetchPayload: { period, provider, includeOptimize in
            try await recorder.fetch(period: period, provider: provider, includeOptimize: includeOptimize)
        })

        // Load today — should have provider tabs
        await store.refreshQuietly(period: .today)
        #expect(store.showProviderTabs)
        #expect(store.allProviderPayloadForPeriod?.current.providers.count == 2)

        // Switch to 7 Days — should NOT show today's provider tabs
        await store.switchTo(period: .sevenDays)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(store.providerTabsPayload == nil)
        #expect(!store.showProviderTabs)
    }

    @Test("stale cache entry is re-fetched after 30+ seconds")
    @MainActor
    func staleCacheEviction() async throws {
        let startOfDay = ISO8601DateFormatter().date(from: "2026-05-07T00:00:00Z")!
        let clock = TestClock(startOfDay)
        let counter = CallCounter()

        let store = AppStore(
            fetchPayload: { _, _, _ in
                let value = await counter.next()
                return makePayload(label: "Today", cost: Double(value), providers: [:])
            },
            now: { clock.now }
        )

        // First fetch
        await store.refreshQuietly(period: .today)
        #expect(await counter.value() == 1)
        #expect(store.payload.current.cost == 1)

        // Still fresh at +29 seconds — no re-fetch
        clock.now = startOfDay.addingTimeInterval(29)
        await store.refreshQuietly(period: .today)
        #expect(await counter.value() == 1)

        // Stale at +31 seconds — triggers re-fetch
        clock.now = startOfDay.addingTimeInterval(31)
        await store.refreshQuietly(period: .today)
        #expect(await counter.value() == 2)
        #expect(store.payload.current.cost == 2)
    }

    @Test("concurrent requests for the same key produce only one fetch call")
    @MainActor
    func concurrentFetchGuard() async throws {
        let counter = CallCounter()

        let store = AppStore(
            fetchPayload: { _, _, _ in
                // Simulate a slow network call
                try await Task.sleep(nanoseconds: 100_000_000)
                let value = await counter.next()
                return makePayload(label: "Today", cost: Double(value), providers: [:])
            }
        )

        // Fire two refreshes concurrently for the same key
        async let r1: () = store.refresh(includeOptimize: false)
        async let r2: () = store.refresh(includeOptimize: false)
        _ = await (r1, r2)

        // The inFlightKeys guard should collapse the two into a single fetch
        #expect(await counter.value() == 1)
    }

    @Test("stale error is cleared when a retry starts so the UI shows loading")
    @MainActor
    func errorClearedOnRetryStart() async throws {
        let startOfDay = ISO8601DateFormatter().date(from: "2026-05-07T00:00:00Z")!
        let clock = TestClock(startOfDay)
        let counter = CallCounter()
        let gate = Gate()

        let store = AppStore(
            fetchPayload: { _, _, _ in
                let value = await counter.next()
                if value == 1 {
                    throw NSError(domain: "Test", code: 1, userInfo: [NSLocalizedDescriptionKey: "first fetch fails"])
                }
                // Second fetch blocks on gate so we can inspect mid-flight state.
                await gate.wait()
                return makePayload(label: "Today", cost: 2, providers: [:])
            },
            now: { clock.now }
        )

        // First fetch fails — error should be set.
        await store.refreshQuietly(period: .today)
        #expect(store.lastError != nil)

        // Expire cache so a retry is triggered.
        clock.now = startOfDay.addingTimeInterval(31)

        // Start retry — it blocks on gate so we can observe intermediate state.
        let retryTask = Task { @MainActor in
            await store.refreshQuietly(period: .today)
        }
        try await Task.sleep(nanoseconds: 10_000_000)

        // Error should be cleared while the retry is in-flight.
        #expect(store.lastError == nil)

        // Release the gate — retry succeeds.
        await gate.open()
        _ = await retryTask.value
        #expect(store.lastError == nil)
        #expect(store.payload.current.cost == 2)
    }

    @Test("colliding fetches share the current scan without a redundant follow-up")
    @MainActor
    func pendingKeyDoesNotRefire() async throws {
        let counter = CallCounter()
        let gate = Gate()

        let store = AppStore(
            fetchPayload: { _, _, _ in
                await gate.wait()
                let value = await counter.next()
                return makePayload(label: "Today", cost: Double(value), providers: [:])
            }
        )

        // First fetch blocks on gate.
        let firstFetch = Task { @MainActor in
            await store.refresh(includeOptimize: false)
        }
        try await Task.sleep(nanoseconds: 10_000_000)

        // Additional same-key requests are served by the current fetch.
        await store.refresh(includeOptimize: false)

        // Repeated demand must not create an immediate rescan.
        await store.refresh(includeOptimize: false)

        // Release the one fetch.
        await gate.open()
        _ = await firstFetch.value

        // Ensure no delayed duplicate was enqueued.
        try await Task.sleep(nanoseconds: 50_000_000)

        // Exactly one fetch, including after the collision window.
        #expect(await counter.value() == 1)
        #expect(store.payload.current.cost == 1)
    }
}
