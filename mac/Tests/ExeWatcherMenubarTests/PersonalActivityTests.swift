import AppKit
import Testing
@testable import ExeWatcherMenubar

@Suite("Personal AI time: idle, scope and durable daily accounting")
@MainActor
struct PersonalActivityTests {
    private let base = Date(timeIntervalSince1970: 1_780_310_000)
    private func url() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("watcher-activity-\(UUID().uuidString)/personal-activity-v1.json")
    }

    @Test func idleResumeAndDelayedChecksDoNotFillUnobservedTime() {
        let rows = AppActivityTracker.activeIntervals(previous: base, previousInput: base.addingTimeInterval(-110),
            now: base.addingTimeInterval(30), input: base.addingTimeInterval(25))
        #expect(rows.map(\.duration).reduce(0, +) == 15)
        #expect(AppActivityTracker.activeIntervals(previous: base, previousInput: base,
            now: base.addingTimeInterval(61), input: base.addingTimeInterval(60)).isEmpty)
        #expect(AppActivityTracker.activeIntervals(previous: base, previousInput: base.addingTimeInterval(-300),
            now: base.addingTimeInterval(30), input: base.addingTimeInterval(-300)).isEmpty)
    }

    @Test func wakingDisplayCannotResumeALockedOrSleepingSession() {
        var state = ActivityAvailability()
        state.receive(ActivityAvailability.locked)
        state.receive(NSWorkspace.screensDidWakeNotification)
        #expect(state.suspended)
        state.receive(NSWorkspace.willSleepNotification)
        state.receive(ActivityAvailability.unlocked)
        #expect(state.suspended)
        state.receive(NSWorkspace.didWakeNotification)
        #expect(!state.suspended)
        state.receive(NSWorkspace.sessionDidResignActiveNotification)
        state.receive(NSWorkspace.didWakeNotification)
        #expect(state.suspended)
        state.receive(NSWorkspace.sessionDidBecomeActiveNotification)
        #expect(!state.suspended)
    }

    @Test func sharedAppsNeedRecentMatchingContextAndBrowsersStayUnknown() {
        let now = base.timeIntervalSince1970 * 1000
        #expect(AppActivityTracker.target(bundleID: "com.openai.codex", recentTurns: [:], now: base)?.provider == "codex")
        #expect(AppActivityTracker.target(bundleID: "com.apple.Terminal", recentTurns: [:], now: base) == nil)
        let context = ["claude": now - 30_000, "kimi": now - 60_000]
        #expect(AppActivityTracker.target(bundleID: "com.apple.Terminal", recentTurns: context, now: base) == ActivityTarget(provider: "claude", contextual: true))
        #expect(AppActivityTracker.target(bundleID: "com.apple.Terminal", recentTurns: ["codex": now - 301_000], now: base) == nil)
        #expect(AppActivityTracker.target(bundleID: "com.todesktop.230313mzl4w4u92", recentTurns: context, now: base) == nil)
        #expect(AppActivityTracker.target(bundleID: "com.google.Chrome", recentTurns: context, now: base) == nil)
        #expect(AppActivityTracker.target(bundleID: "com.apple.Terminal", recentTurns: ["codex": now + 1], now: base) == nil)
    }

    @Test func dailyTotalsSurviveRestartWithoutDuplicatesOrCostFiles() throws {
        let path = url(); defer { try? FileManager.default.removeItem(at: path.deletingLastPathComponent()) }
        let store = PersonalActivityStore(url: path)
        store.startRecording(now: base)
        store.record(start: base, end: base.addingTimeInterval(30), provider: "codex", contextual: false, now: base.addingTimeInterval(30))
        store.record(start: base, end: base.addingTimeInterval(30), provider: "codex", contextual: false, now: base.addingTimeInterval(30))
        store.record(start: base.addingTimeInterval(30), end: base.addingTimeInterval(60), provider: "claude", contextual: true, now: base.addingTimeInterval(60))
        store.stop(now: base.addingTimeInterval(60))
        let restored = PersonalActivityStore(url: path)
        #expect(restored.error == nil)
        let summary = restored.summary(period: .all, provider: .all, now: base.addingTimeInterval(60))
        #expect(summary?.totalMs == 60_000)
        #expect(restored.summary(period: .all, provider: .all, now: base.addingTimeInterval(3600))?.updatedAt == summary?.updatedAt)
        #expect(restored.summary(period: .all, provider: .codex, now: base.addingTimeInterval(60))?.activeMs == 30_000)
        let files = try FileManager.default.contentsOfDirectory(atPath: path.deletingLastPathComponent().path)
        #expect(files.sorted() == ["personal-activity-v1.json", "personal-activity-v1.json.lock"])
        let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }

    @Test func secondWriterAndCorruptDataCannotOverwriteHistory() throws {
        let path = url(); defer { try? FileManager.default.removeItem(at: path.deletingLastPathComponent()) }
        let first = PersonalActivityStore(url: path); first.startRecording(now: base)
        let second = PersonalActivityStore(url: path); second.startRecording(now: base)
        #expect(first.canRecord); #expect(!second.canRecord)
        first.stop(now: base)
        try Data("broken history".utf8).write(to: path)
        let corrupt = PersonalActivityStore(url: path); corrupt.startRecording(now: base)
        #expect(!corrupt.canRecord)
        corrupt.flush()
        #expect(try String(contentsOf: path, encoding: .utf8) == "broken history")
    }

    @Test func disablingPreservesPastTimeAndRejectsNewActivity() {
        let path = url(); defer { try? FileManager.default.removeItem(at: path.deletingLastPathComponent()) }
        let store = PersonalActivityStore(url: path); store.startRecording(now: base)
        store.record(start: base, end: base.addingTimeInterval(30), provider: "codex", contextual: false, now: base.addingTimeInterval(30))
        store.setEnabled(false, now: base.addingTimeInterval(30))
        store.record(start: base.addingTimeInterval(30), end: base.addingTimeInterval(60), provider: "codex", contextual: false, now: base.addingTimeInterval(60))
        #expect(store.summary(period: .all, provider: .all, now: base.addingTimeInterval(60))?.totalMs == 30_000)
        store.stop(now: base.addingTimeInterval(60))
        #expect(PersonalActivityStore(url: path).enabled == false)
    }

    @Test func midnightSplitsAndPeriodTotalsUseCalendarDays() throws {
        let path = url(); defer { try? FileManager.default.removeItem(at: path.deletingLastPathComponent()) }
        let midnight = Calendar.current.startOfDay(for: base)
        let start = midnight.addingTimeInterval(-15)
        let store = PersonalActivityStore(url: path); store.startRecording(now: start)
        store.record(start: start, end: midnight.addingTimeInterval(15), provider: "codex", contextual: false, now: midnight.addingTimeInterval(15))
        #expect(store.history?.days.count == 2)
        #expect(store.summary(period: .today, provider: .all, now: midnight.addingTimeInterval(15))?.totalMs == 15_000)
        #expect(store.summary(period: .sevenDays, provider: .all, now: midnight.addingTimeInterval(15))?.totalMs == 30_000)
        #expect(store.summary(period: .all, provider: .all, now: midnight.addingTimeInterval(15))?.totalMs == 30_000)
        store.stop(now: midnight.addingTimeInterval(15))
    }

    @Test func dailySchemaAcceptsDSTAndRejectsOverlappingOrOverfullDays() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "America/New_York"))
        let date = try #require(ISO8601DateFormatter().date(from: "2026-03-08T12:00:00Z"))
        let day = try #require(calendar.dateInterval(of: .day, for: date))
        #expect(day.duration == 23 * 3600)
        let row = ActivityDay(start: day.start.timeIntervalSince1970 * 1000, end: day.end.timeIntervalSince1970 * 1000,
            active: ["codex": 30_000])
        var saved = ActivityHistory(version: 1, startedAt: ActivityHistory.stamp(day.start), updatedAt: ActivityHistory.stamp(date),
            enabled: true, timeZone: calendar.timeZone.identifier, recordedThrough: date.timeIntervalSince1970 * 1000, days: [row])
        #expect(saved.validate())
        saved.days.append(row); #expect(!saved.validate())
        saved.days = [row]; saved.days[0].active = ["codex": 86_400_000.0]
        #expect(!saved.validate())
    }
}
