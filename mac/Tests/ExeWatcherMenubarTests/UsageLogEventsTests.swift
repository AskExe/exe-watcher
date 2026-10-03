import Foundation
import CoreServices
import Testing
@testable import ExeWatcherMenubar

@Test func onlyUsageWritesTriggerRefresh() {
    for path in ["/sessions/new.jsonl", "/opencode/opencode.db-wal", "/Cursor/state.vscdb", "/.claude/stats-cache.json", "/opencode/storage/message/new.json"] {
        #expect(UsageLogEvents.shouldRefresh(path: path, flags: 0))
    }
    for path in ["/plans/plan.md", "/worktrees/main.ts", "/Cursor/state.vscdb-shm", "/opencode/opencode.db-shm", "/.claude/settings.json"] {
        #expect(!UsageLogEvents.shouldRefresh(path: path, flags: 0))
    }
    #expect(UsageLogEvents.shouldRefresh(path: "/sessions/new", flags: UInt32(kFSEventStreamEventFlagItemIsDir | kFSEventStreamEventFlagItemCreated)))
    #expect(UsageLogEvents.shouldRefresh(path: "/sessions", flags: UInt32(kFSEventStreamEventFlagMustScanSubDirs)))
}

@Test func noEventsMeansNoScansEvenAfterADay() {
    let coalescer = RefreshCoalescer(config: .init(minIntervalSeconds: 120, scanRestMultiplier: 9))
    let now = Date()
    #expect(coalescer.evaluate(now: now) == .idle)
    #expect(coalescer.evaluate(now: now.addingTimeInterval(86400)) == .idle)
}
