import Foundation

/// Single entry point for spawning the `exe-watcher` CLI. All callers route through here so the
/// binary argv is validated once and no code path ever passes user-influenced strings through
/// a shell (`/bin/zsh -c`, `open --args`, AppleScript). This closes the shell-injection attack
/// surface end-to-end.
enum ExeWatcherCLI {
    private static let defaultBinaryName = "exe-watcher"
    /// Matches a plain file path / program name: alphanumerics, dot, underscore, slash, hyphen,
    /// space. Deliberately excludes shell metacharacters (`$`, `;`, `&`, `|`, quotes, backticks,
    /// newlines) so a malicious `EXE_WATCHER_BIN="exe-watcher; rm -rf ~"` can't slip through.
    private static let safeArgPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9 ._/\\-]+$")

    struct ResolverFilesystem: Sendable {
        let isExecutable: @Sendable (String) -> Bool
        let listDirectory: @Sendable (String) -> [String]

        static let live = ResolverFilesystem(
            isExecutable: { FileManager.default.isExecutableFile(atPath: $0) },
            listDirectory: { (try? FileManager.default.contentsOfDirectory(atPath: $0)) ?? [] }
        )
    }

    private static func isNewerNodeVersion(_ lhs: String, _ rhs: String) -> Bool {
        let left = lhs.split(separator: ".").map { Int($0.trimmingCharacters(in: CharacterSet(charactersIn: "v"))) ?? 0 }
        let right = rhs.split(separator: ".").map { Int($0.trimmingCharacters(in: CharacterSet(charactersIn: "v"))) ?? 0 }
        let count = max(left.count, right.count)
        for idx in 0..<count {
            let l = idx < left.count ? left[idx] : 0
            let r = idx < right.count ? right[idx] : 0
            if l != r { return l > r }
        }
        return lhs > rhs
    }

    /// Returns the argv that launches the CLI. Dev override via `EXE_WATCHER_BIN` is honoured only
    /// if every whitespace-delimited token passes `safeArgPattern`. Otherwise falls back to the
    /// plain `exe-watcher` name (resolved via PATH).
    static func baseArgv() -> [String] {
        guard let raw = ProcessInfo.processInfo.environment["EXE_WATCHER_BIN"], !raw.isEmpty else {
            return [defaultBinaryName]
        }
        let parts = raw.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard parts.allSatisfy(isSafe) else {
            NSLog("Exe Watcher: refusing unsafe EXE_WATCHER_BIN; using default 'exe-watcher'")
            return [defaultBinaryName]
        }
        return parts
    }

    /// Builds a `Process` that runs the CLI with the given subcommand args. Uses `/usr/bin/env`
    /// only when needed. Preferred path is a directly resolved executable so we can survive GUI
    /// PATH issues, broken NVM "current" pointers, or a newer Node version that doesn't own the
    /// user's globally installed exe-watcher binary. Caller sets stdout/stderr pipes and calls
    /// `run()`.
    static func makeProcess(subcommand: [String]) -> Process {
        let process = Process()
        var environment = ProcessInfo.processInfo.environment

        let overrideArgv = baseArgv()
        if overrideArgv != [defaultBinaryName] {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            environment["PATH"] = augmentedPath(environment["PATH"] ?? "", environment: environment)
            process.arguments = ["--"] + overrideArgv + subcommand
        } else if let resolvedBinary = resolveBinaryPath(environment: environment) {
            process.executableURL = URL(fileURLWithPath: resolvedBinary)
            let binDir = (resolvedBinary as NSString).deletingLastPathComponent
            environment["PATH"] = augmentedPath(
                environment["PATH"] ?? "",
                prioritizedEntries: [binDir],
                environment: environment
            )
            process.arguments = subcommand
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            environment["PATH"] = augmentedPath(environment["PATH"] ?? "", environment: environment)
            // `env --` treats everything following as argv, not VAR=val pairs -- guards against an
            // argument accidentally resembling an env assignment.
            process.arguments = ["--", defaultBinaryName] + subcommand
        }

        // Keep background scans inside a small V8 heap and collect transient JSON promptly.
        // Last option wins over an inherited larger heap setting.
        environment["NODE_OPTIONS"] = (environment["NODE_OPTIONS"] ?? "") + " --max-old-space-size=256"
        process.environment = environment
        // Use .userInitiated so macOS keeps the CLI responsive; the menubar badge depends on
        // timely results. .utility causes visible staleness because macOS freely throttles
        // accessory-app subprocesses at that QOS tier.
        process.qualityOfService = .userInitiated
        return process
    }

    static func isSafe(_ s: String) -> Bool {
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return safeArgPattern.firstMatch(in: s, range: range) != nil
    }

    static func resolveBinaryPath(
        environment: [String: String],
        homeDirectory: String = NSHomeDirectory(),
        filesystem: ResolverFilesystem = .live
    ) -> String? {
        binaryDirectoryCandidates(
            environment: environment,
            homeDirectory: homeDirectory,
            filesystem: filesystem
        )
        .map { "\($0)/\(defaultBinaryName)" }
        .first(where: filesystem.isExecutable)
    }

    private static func augmentedPath(
        _ existing: String,
        prioritizedEntries: [String] = [],
        environment: [String: String],
        homeDirectory: String = NSHomeDirectory(),
        filesystem: ResolverFilesystem = .live
    ) -> String {
        var parts: [String] = []
        for part in prioritizedEntries where !part.isEmpty && !parts.contains(part) {
            parts.append(part)
        }
        for part in existing.split(separator: ":", omittingEmptySubsequences: true).map(String.init)
            where !parts.contains(part) {
            parts.append(part)
        }
        for extra in binaryDirectoryCandidates(
            environment: environment,
            homeDirectory: homeDirectory,
            filesystem: filesystem
        ) where !parts.contains(extra) {
            parts.append(extra)
        }
        return parts.joined(separator: ":")
    }

    private static func binaryDirectoryCandidates(
        environment: [String: String],
        homeDirectory: String,
        filesystem: ResolverFilesystem
    ) -> [String] {
        var entries = pathEntries(from: environment["PATH"] ?? "")
        entries.append("/opt/homebrew/bin")
        entries.append("/usr/local/bin")
        entries.append("\(homeDirectory)/.local/bin")

        let nvmDir = environment["NVM_DIR"] ?? "\(homeDirectory)/.nvm"
        entries.append("\(nvmDir)/current/bin")

        let versionsPath = "\(nvmDir)/versions/node"
        let versions = filesystem.listDirectory(versionsPath).sorted(by: isNewerNodeVersion)
        for version in versions {
            entries.append("\(versionsPath)/\(version)/bin")
        }

        var deduped: [String] = []
        for entry in entries where !entry.isEmpty && !deduped.contains(entry) {
            deduped.append(entry)
        }
        return deduped
    }

    private static func pathEntries(from path: String) -> [String] {
        path.split(separator: ":", omittingEmptySubsequences: true).map(String.init)
    }
}
