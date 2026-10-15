import Foundation
import CoreServices

/// Keep monitoring aligned with the CLI's standard data locations. No executables,
/// shell profiles, credentials or API keys are needed to discover saved usage.
enum UsageLogLocations {
    static func roots(home: String, environment: [String: String], additionalClaudeRoots: [String] = []) -> [String] {
        let claude = environment["CLAUDE_CONFIG_DIR"] ?? "\(home)/.claude"
        let codex = environment["CODEX_HOME"] ?? "\(home)/.codex"
        let data = environment["XDG_DATA_HOME"] ?? "\(home)/.local/share"
        let claudeRoots = [claude] + additionalClaudeRoots
        let paths = claudeRoots.flatMap { [expand($0, home: home) + "/projects", expand($0, home: home) + "/stats-cache.json"] } + [
            "\(home)/Library/Application Support/Claude/local-agent-mode-sessions",
            codex + "/sessions", codex + "/archived_sessions",
            "\(home)/.copilot/session-state",
            "\(home)/.pi/agent/sessions", "\(home)/.omp/agent/sessions",
            (environment["KIMI_CODE_HOME"] ?? "\(home)/.kimi-code") + "/sessions",
            "\(home)/.cursor/projects",
            "\(home)/Library/Application Support/Cursor/User/globalStorage",
            data + "/opencode",
        ]
        // FSEvents can report the physical path of a symlinked client profile.
        // Accept both spellings while keeping the scope confined to usage roots.
        return Array(Set(paths.flatMap { path in
            let normalized = (path as NSString).standardizingPath
            return [normalized, URL(fileURLWithPath: normalized).resolvingSymlinksInPath().path]
        })).sorted()
    }

    static func watchPaths(roots: [String], exists: (String) -> Bool) -> [String] {
        let candidates = Set(roots.compactMap { root -> String? in
            var path = root
            while !path.isEmpty && path != "/" && !exists(path) { path = (path as NSString).deletingLastPathComponent }
            return path.isEmpty || path == "/" ? nil : path
        })
        // FSEvents observes descendants too; one existing ancestor is sufficient.
        return candidates.filter { path in
            !candidates.contains { $0 != path && path.hasPrefix($0 + "/") }
        }.sorted()
    }

    static func shouldRefresh(path: String, flags: FSEventStreamEventFlags, roots: [String]) -> Bool {
        let reconcile = kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagRootChanged
        if flags & UInt32(reconcile) != 0 { return true }
        let isDirectory = flags & UInt32(kFSEventStreamEventFlagItemIsDir) != 0
        // An ancestor can be watched before a client is installed. Filter those
        // events to usage roots, including creation of a missing parent directory.
        guard roots.contains(where: {
            path == $0 || path.hasPrefix($0 + "/") || (isDirectory && $0.hasPrefix(path + "/"))
        }) else { return false }
        return UsageLogEvents.shouldRefresh(path: path, flags: flags)
    }

    private static func expand(_ path: String, home: String) -> String {
        path.hasPrefix("~/") ? home + String(path.dropFirst()) : path
    }
}
