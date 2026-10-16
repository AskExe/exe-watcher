import Foundation
import Testing
@testable import ExeWatcherMenubar

private func progress(_ token: String, runnable: Int = 1, waiting: Int = 0) -> TimeRecoveryProgress {
    TimeRecoveryProgress(runnableFiles: runnable, waitingFiles: waiting, pendingBytes: Double(runnable * 100), token: token)
}

@Test func queuedTimingWorkContinuesWithRestAndStopsWhenDrained() {
    var pacer = TimeRecoveryPacer()
    var again = pacer.begin(progress("first"))
    #expect(again)
    again = pacer.completed(previous: "first", progress: progress("next"), elapsed: 3)
    #expect(again)
    #expect(pacer.delay == 27)
    again = pacer.completed(previous: "next", progress: progress("done", runnable: 0), elapsed: 1)
    #expect(!again)
    again = pacer.begin(progress("partial-eof", runnable: 0, waiting: 1))
    #expect(!again)
}

@Test func unchangedOrFailedTimingWorkStopsUntilNewEvidenceOrExplicitReset() {
    var pacer = TimeRecoveryPacer()
    var again = pacer.begin(progress("stuck"))
    #expect(again)
    again = pacer.completed(previous: "stuck", progress: progress("stuck"), elapsed: 1)
    #expect(again)
    again = pacer.completed(previous: "stuck", progress: progress("stuck"), elapsed: 1)
    #expect(!again)
    again = pacer.begin(progress("stuck"))
    #expect(!again)
    again = pacer.begin(progress("appended"))
    #expect(again)
    pacer.pause("appended")
    again = pacer.begin(progress("appended"))
    #expect(!again)
    pacer.reset()
    again = pacer.begin(progress("appended"))
    #expect(again)
}

private func timeBlock(_ step: Int, runnable: Int) throws -> TimeBlock {
    let raw: [String: Any] = [
        "since": "2025-07-01T00:00:00.000Z", "through": "2026-10-16T23:59:59.999Z",
        "indexedAt": "2026-10-16T00:00:0\(step).000Z", "aiRunningMs": step * 1000,
        "elapsedBusyMs": step * 1000, "estimatedAiMs": 0, "coverage": "partial",
        "pendingFiles": runnable, "indexedFiles": 1, "providers": [], "notes": [],
        "recovery": ["runnableFiles": runnable, "waitingFiles": 0, "pendingBytes": runnable * 100, "token": "step-\(step)"],
    ]
    return try JSONDecoder().decode(TimeBlock.self, from: JSONSerialization.data(withJSONObject: raw))
}

private func spendingPayload(_ time: TimeBlock) throws -> MenubarPayload {
    var raw = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(MenubarPayload.empty)) as? [String: Any])
    var current = try #require(raw["current"] as? [String: Any])
    current["cost"] = 42
    raw["current"] = current
    raw["generated"] = ISO8601DateFormatter().string(from: Date())
    var payload = try JSONDecoder().decode(MenubarPayload.self, from: JSONSerialization.data(withJSONObject: raw))
    payload.time = time
    payload.periodSnapshots = Dictionary(uniqueKeysWithValues: Period.allCases.map {
        ($0.cliArg, PeriodSnapshot(current: payload.current, projectSpend: nil, diagnostics: nil, historyValidatedAt: 0, time: time))
    })
    return payload
}

private actor TimeSteps {
    private var replies: [TimeRecoverySnapshots]
    private var releaseRest: CheckedContinuation<Void, Never>?
    private var enabled = false
    private(set) var calls = 0
    private(set) var costs = 0
    init(_ replies: [TimeRecoverySnapshots]) { self.replies = replies }
    func cost() { costs += 1 }
    func rest(_: TimeInterval) async {
        if !enabled { await withCheckedContinuation { releaseRest = $0 } }
        await Task.yield()
    }
    func enable() { enabled = true; releaseRest?.resume(); releaseRest = nil }
    func next() throws -> TimeRecoverySnapshots {
        calls += 1
        guard !replies.isEmpty else { throw DataClientError.timeout() }
        return replies.removeFirst()
    }
}

private func snapshots(_ block: TimeBlock) -> TimeRecoverySnapshots {
    TimeRecoverySnapshots(generated: "2026-10-16T00:00:00.000Z", provider: "all",
        periods: Dictionary(uniqueKeysWithValues: Period.allCases.map { ($0.cliArg, block) }),
        allPeriods: nil, recovery: block.recovery!)
}

@Test @MainActor func quietBacklogDrainsWithoutExtraCostFetchesOrRefreshingCostTimestamps() async throws {
    let initial = try timeBlock(1, runnable: 1), middle = try timeBlock(2, runnable: 1), done = try timeBlock(3, runnable: 0)
    let good = try spendingPayload(initial)
    let steps = TimeSteps([snapshots(middle), snapshots(done)])
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: folder) }
    let badge = folder.appendingPathComponent("badge.json")
    let store = AppStore(fetchPayload: { _, _, _ in await steps.cost(); return good }, badgeCacheURL: badge,
        fetchTimeSnapshots: { _ in try await steps.next() }, restForTimeRecovery: { await steps.rest($0) })
    #expect(await store.refreshTodayBadge())
    let before = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: badge)) as? [String: Any])
    await steps.enable()
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while store.payload.time?.aiRunningMs != 3000 && ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(store.payload.time?.aiRunningMs == 3000)
    #expect(store.payload.current.cost == 42)
    #expect(await steps.calls == 2)
    #expect(await steps.costs == 1)
    let after = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: badge)) as? [String: Any])
    #expect((before["fetchedAt"] as? Double) == (after["fetchedAt"] as? Double))
    // Old cost/Optimize responses must not overwrite the newer timing snapshot.
    await store.refresh(includeOptimize: true)
    #expect(store.payload.time?.aiRunningMs == 3000)
    store.cancelTimeRecovery()
}

@Test @MainActor func cancellationDuringTimingRestDoesNotLaunchAnotherReader() async throws {
    let good = try spendingPayload(timeBlock(1, runnable: 1)), steps = TimeSteps([])
    let store = AppStore(fetchPayload: { _, _, _ in good }, fetchTimeSnapshots: { _ in try await steps.next() },
        restForTimeRecovery: { _ in try await Task.sleep(for: .seconds(3600)) })
    #expect(await store.refreshTodayBadge())
    store.cancelTimeRecovery()
    try await Task.sleep(for: .milliseconds(10))
    #expect(await steps.calls == 0)
    #expect(store.payload.current.cost == 42)
}

@Test @MainActor func failedTimingWorkStaysPausedUntilUserRetriesOrDataChanges() async throws {
    let good = try spendingPayload(timeBlock(1, runnable: 1)), steps = TimeSteps([])
    await steps.enable()
    let store = AppStore(fetchPayload: { _, _, _ in good }, fetchTimeSnapshots: { _ in try await steps.next() },
        restForTimeRecovery: { await steps.rest($0) })
    #expect(await store.refreshTodayBadge())
    var deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while store.timeRecoveryMessage == nil && ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(store.timeRecoveryMessage != nil)
    #expect(await steps.calls == 1)
    #expect(await store.refreshTodayBadge())
    #expect(await steps.calls == 1)
    store.retryTimeRecovery()
    deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while await steps.calls < 2 && ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(await steps.calls == 2)
    #expect(store.payload.current.cost == 42)
    let anchor = PayloadCacheKey(period: .today, provider: .all, now: Date()).dateAnchor
    store.applyTimeSnapshots(snapshots(try timeBlock(3, runnable: 0)), dateAnchor: anchor)
    #expect(store.timeRecoveryMessage == nil)
    store.cancelTimeRecovery()
}
