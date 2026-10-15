import Foundation
import CoreServices
import Testing
@testable import ExeWatcherMenubar

@Suite("Automatic local usage discovery")
struct UsageLogLocationsTests {
    private let home = "/Users/new-user"
    private let createdDirectory = UInt32(kFSEventStreamEventFlagItemIsDir | kFSEventStreamEventFlagItemCreated)

    @Test func findsFirstClientInstalledAfterWatcher() {
        let roots = UsageLogLocations.roots(home: home, environment: [:])
        #expect(UsageLogLocations.watchPaths(roots: roots, exists: { $0 == home }) == [home])
        for path in [".claude", ".codex", ".kimi-code", ".copilot", ".pi", ".omp", ".local", ".cursor", "Library"] {
            #expect(UsageLogLocations.shouldRefresh(path: home + "/" + path, flags: createdDirectory, roots: roots))
        }
        for path in [".claude/projects/new/session.jsonl", ".codex/sessions/new.jsonl", ".copilot/session-state/new/events.jsonl", ".kimi-code/sessions/new/agents/main/wire.jsonl", ".local/share/opencode/opencode.db-wal", "Library/Application Support/Cursor/User/globalStorage/state.vscdb"] {
            #expect(UsageLogLocations.shouldRefresh(path: home + "/" + path, flags: 0, roots: roots))
        }
    }

    @Test func ignoresUnrelatedHomeActivity() {
        let roots = UsageLogLocations.roots(home: home, environment: [:])
        for path in ["Documents/new.jsonl", ".claude/settings.json", ".copilot/config.json", ".kimi-code/credentials.json", ".codex-other/sessions/new.jsonl", ".local/share/other/new.db"] {
            #expect(!UsageLogLocations.shouldRefresh(path: home + "/" + path, flags: 0, roots: roots))
        }
        #expect(!UsageLogLocations.shouldRefresh(path: home + "/Downloads", flags: createdDirectory, roots: roots))
    }

    @Test func honorsCustomLocationsAndProfiles() {
        let roots = UsageLogLocations.roots(home: home, environment: ["CLAUDE_CONFIG_DIR": "/data/claude", "CODEX_HOME": "/data/codex", "KIMI_CODE_HOME": "/data/kimi", "XDG_DATA_HOME": "/data/xdg"], additionalClaudeRoots: ["~/.claude-work"])
        for path in ["/data/claude/projects", "/data/codex/archived_sessions", "/data/kimi/sessions", "/data/xdg/opencode", home + "/.claude-work/projects"] { #expect(roots.contains(path)) }
        #expect(!roots.contains(home + "/.codex/sessions"))
        #expect(UsageLogLocations.watchPaths(roots: roots, exists: { $0 == "/data" || $0 == home }) == ["/data", home].sorted())
    }

    @Test func doesNotWatchTheWholeFilesystem() {
        #expect(UsageLogLocations.watchPaths(roots: ["/missing/client/sessions"], exists: { $0 == "/" }).isEmpty)
        #expect(UsageLogLocations.watchPaths(roots: ["relative/missing", ""], exists: { _ in false }).isEmpty)
    }

    @Test func recognizesPhysicalEventsForSymlinkedProfiles() throws {
        let fm = FileManager.default
        let fixture = fm.temporaryDirectory.appendingPathComponent("watcher-locations-" + UUID().uuidString)
        defer { try? fm.removeItem(at: fixture) }
        let physical = fixture.appendingPathComponent("data/sessions")
        try fm.createDirectory(at: physical, withIntermediateDirectories: true)
        let alias = fixture.appendingPathComponent("codex-link")
        try fm.createSymbolicLink(at: alias, withDestinationURL: physical.deletingLastPathComponent())
        let roots = UsageLogLocations.roots(home: home, environment: ["CODEX_HOME": alias.path])
        #expect(roots.contains(alias.path + "/sessions"))
        #expect(roots.contains(physical.resolvingSymlinksInPath().path))
        #expect(UsageLogLocations.shouldRefresh(path: physical.resolvingSymlinksInPath().path + "/new.jsonl", flags: 0, roots: roots))
    }

    @Test func surfacesMissingCostAndSourceCoverage() {
        let warnings = DiagnosticsBlock(daysCount: 1, parseTimeMs: 0, warnings: ["No API pricing for model \"custom\"; its tokens are counted but its cost is excluded.", "Provider \"opencode\" discovery failed: permission denied"])
        #expect(warnings.hasUnpricedUsage)
        #expect(warnings.discoveryWarning?.contains("opencode") == true)
        let good = DiagnosticsBlock(daysCount: 1, parseTimeMs: 0, warnings: [])
        #expect(!good.hasUnpricedUsage)
        #expect(good.discoveryWarning == nil)
    }
}
