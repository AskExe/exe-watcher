import Foundation
import Testing
@testable import ExeWatcherMenubar

private final class AuditClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 1_780_000_000)
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return date }
    func advance(_ seconds: TimeInterval = 21) { lock.lock(); date.addTimeInterval(seconds); lock.unlock() }
}
private actor AuditGate {
    var count = 0
    private var open = false
    private var waits: [CheckedContinuation<Void, Never>] = []
    func fetch() async -> MenubarPayload {
        count += 1
        if !open { await withCheckedContinuation { waits.append($0) } }
        return .empty
    }
    func release() { open = true; for waiter in waits { waiter.resume() }; waits.removeAll() }
}
@Suite("Resource audit safety assertions", .serialized)
struct ResourceAuditTests {
    private func payload(cost: Double, warnings: [String] = []) throws -> MenubarPayload {
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MenubarPayload.empty)) as! [String: Any]
        var current = json["current"] as! [String: Any]
        current["cost"] = cost
        json["current"] = current
        json["diagnostics"] = ["daysCount": 1, "parseTimeMs": 1, "warnings": warnings]
        return try JSONDecoder().decode(MenubarPayload.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test @MainActor
    func failedScanDisguisedAsZeroKeepsLastGoodTotalAndBacksOff() async throws {
        let good = try payload(cost: 300)
        let bad = try payload(cost: 0, warnings: ["parseAllSessions failed: Resource limit reached (30 second scan budget)"])
        actor Responses {
            var count = 0
            func next(_ good: MenubarPayload, _ bad: MenubarPayload) -> MenubarPayload {
                count += 1
                return count == 1 ? good : bad
            }
        }
        let responses = Responses()
        let clock = AuditClock()
        let store = AppStore(fetchPayload: { _, _, _ in await responses.next(good, bad) }, now: { clock.now() })
        await store.refreshTodayBadge()
        await store.refreshTodayBadge()
        #expect(store.todayPayload?.current.cost == 300)
        #expect(store.lastBadgeRefreshError != nil)
        #expect(store.dataMayBeStale)
        await store.refreshTodayBadge()
        #expect(await responses.count == 2)
    }

    @Test @MainActor
    func lastGoodBadgeSurvivesRestartButDoesNotLeakAcrossMidnight() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("badge.json")
        let clock = AuditClock()
        let good = try payload(cost: 300)
        let original = AppStore(fetchPayload: { _, _, _ in good }, now: { clock.now() }, badgeCacheURL: url)
        await original.refreshTodayBadge()
        let restart = AppStore(fetchPayload: { _, _, _ in throw DataClientError.timeout() }, now: { clock.now() }, badgeCacheURL: url)
        #expect(restart.todayPayload?.current.cost == 300)
        await restart.refreshTodayBadge()
        #expect(restart.todayPayload?.current.cost == 300)
        clock.advance(86400)
        let tomorrow = AppStore(now: { clock.now() }, badgeCacheURL: url)
        #expect(tomorrow.todayPayload == nil)
        // A completed scan with no usage is still a legitimate zero.
        let zero = try payload(cost: 0)
        let emptyDay = AppStore(fetchPayload: { _, _, _ in zero }, now: { clock.now() }, badgeCacheURL: url)
        await emptyDay.refreshTodayBadge()
        #expect(emptyDay.todayPayload?.current.cost == 0)
        #expect(emptyDay.lastBadgeRefreshError == nil)
    }

    @Test
    func scannerRunsAtLowPriority() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = ["-c", "import os,time; time.sleep(0.05); print(os.getpriority(os.PRIO_PROCESS,0))"]
        let result = try await CLIProcessRunner(process: process, timeout: 5).run()
        #expect(Int(String(data: result.0, encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines))! >= 10)
    }

    @Test @MainActor
    func repeatedFailuresBackOffAcrossRefreshPaths() async {
        let clock = AuditClock()
        actor Counter {
            var count = 0
            func fail() throws -> MenubarPayload { count += 1; throw DataClientError.timeout() }
        }
        let counter = Counter()
        let store = AppStore(fetchPayload: { _, _, _ in try await counter.fail() }, now: { clock.now() })
        await store.refreshTodayBadge()
        await store.refreshTodayBadge()
        await store.refresh(includeOptimize: false)
        #expect(await counter.count == 1)
        clock.advance(30)
        await store.refreshTodayBadge()
        #expect(await counter.count == 2)
        clock.advance(30)
        await store.refreshTodayBadge()
        #expect(await counter.count == 2)
        clock.advance(30)
        await store.refreshTodayBadge()
        #expect(await counter.count == 3)
    }
    @Test @MainActor
    func slowBadgeMustNotAllowAnotherBadgeAfterTwentySeconds() async {
        let gate = AuditGate()
        let clock = AuditClock()
        let store = AppStore(fetchPayload: { _, _, _ in await gate.fetch() }, now: { clock.now() })
        let first = Task { await store.refreshTodayBadge() }
        for _ in 0..<1000 { if await gate.count >= 1 { break }; await Task.yield() }
        clock.advance()
        let second = Task { await store.refreshTodayBadge() }
        for _ in 0..<1000 { if await gate.count >= 2 { break }; await Task.yield() }
        let concurrentFetches = await gate.count
        #expect(concurrentFetches == 1, "One unfinished badge scan must retain ownership until process exit")
        await gate.release()
        await first.value
        await second.value
    }
    @Test @MainActor
    func badgeAndDetailMustShareSameKeyOwnership() async {
        let gate = AuditGate()
        let store = AppStore(fetchPayload: { _, _, _ in await gate.fetch() })
        let badge = Task { await store.refreshTodayBadge() }
        for _ in 0..<1000 { if await gate.count >= 1 { break }; await Task.yield() }
        let detail = Task { await store.refresh(includeOptimize: false) }
        for _ in 0..<1000 { if await gate.count >= 2 { break }; await Task.yield() }
        let concurrentFetches = await gate.count
        #expect(concurrentFetches == 1, "Badge and Today/All detail must not launch duplicate scans")
        await gate.release()
        await badge.value
        await detail.value
    }
    @Test @MainActor
    func differentPeriodsMustHaveGlobalConcurrencyBudget() async {
        let gate = AuditGate()
        let store = AppStore(fetchPayload: { _, _, _ in await gate.fetch() })
        let tasks = Period.allCases.map { period in Task { await store.refreshQuietly(period: period) } }
        for _ in 0..<1000 { if await gate.count >= Period.allCases.count { break }; await Task.yield() }
        let concurrentFetches = await gate.count
        #expect(concurrentFetches <= 2, "Different cache keys must not each own an unrestricted process slot")
        await gate.release()
        for task in tasks { await task.value }
    }
    @Test
    func cancellingFetchMustStopItsSubprocessPromptly() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("watcher-audit-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let script = dir.appendingPathComponent("fake-cli")
        let marker = dir.appendingPathComponent("started")
        let code = "#!/usr/bin/python3\nimport time\nopen('" + marker.path + "', 'w').close()\ntime.sleep(2)\nprint('{}')\n"
        try code.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        let previous = ProcessInfo.processInfo.environment["EXE_WATCHER_BIN"]
        setenv("EXE_WATCHER_BIN", script.path, 1)
        defer {
            if let previous { setenv("EXE_WATCHER_BIN", previous, 1) }
            else { unsetenv("EXE_WATCHER_BIN") }
        }
        let task = Task { try await DataClient.fetch(period: .today, provider: .all, includeOptimize: false) }
        for _ in 0..<1000 {
            if FileManager.default.fileExists(atPath: marker.path) { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(FileManager.default.fileExists(atPath: marker.path))
        let start = Date()
        task.cancel()
        _ = await task.result
        let elapsed = Date().timeIntervalSince(start)
        #expect(elapsed < 0.5, "Cancelled prefetch retained its child for \(elapsed) seconds")
    }

    @Test
    func oversizedOutputStopsAndReapsChild() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = ["-c", "import sys,time; sys.stderr.buffer.write(b'x'*300000); sys.stderr.flush(); time.sleep(2)"]
        do {
            _ = try await CLIProcessRunner(process: process, timeout: 5).run()
            Issue.record("Expected output budget error")
        } catch DataClientError.outputTooLarge { }
        #expect(!process.isRunning)
    }

    @Test
    func timeoutKillsChildThatIgnoresTerminateAndReapsIt() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = ["-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(5)"]
        do {
            _ = try await CLIProcessRunner(process: process, timeout: 0.5).run()
            Issue.record("Expected timeout")
        } catch DataClientError.timeout { }
        #expect(!process.isRunning)
    }

    @Test
    func cancelledWaiterDoesNotConsumeOrLeakPermit() async throws {
        let admission = FetchAdmission(limit: 1)
        try await admission.acquire()
        let waiter = Task { try await admission.acquire() }
        try await Task.sleep(for: .milliseconds(10))
        waiter.cancel()
        do { try await waiter.value; Issue.record("Expected cancellation") }
        catch is CancellationError { }
        await admission.release()
        try await admission.acquire()
        await admission.release()
    }

}
