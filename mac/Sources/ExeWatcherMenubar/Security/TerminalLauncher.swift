import AppKit
import Foundation

/// Opens a private command file with Terminal, without controlling the app through
/// Apple Events. Each argument is shell-quoted independently.
/// Falls back to a detached headless spawn on machines without Terminal.app (iTerm/Ghostty/Warp
/// users) so the subcommand still runs.
enum TerminalLauncher {
    private static let terminalPaths = [
        "/System/Applications/Utilities/Terminal.app",
        "/Applications/Utilities/Terminal.app",
    ]

    @MainActor private static var openingReport = false

    @MainActor static func open(subcommand: [String]) {
        let argv = ExeWatcherCLI.baseArgv() + subcommand
        guard subcommand.allSatisfy(ExeWatcherCLI.isSafe) else {
            NSLog("Exe Watcher: refusing to open terminal with unsafe argv")
            return
        }
        if let terminal = terminalPaths.first(where: FileManager.default.fileExists(atPath:)) {
            guard !openingReport else { return }
            openingReport = true
            Task {
                defer { openingReport = false }
                var scriptURL: URL?
                do {
                    let url = try createCommandFile(argv: argv)
                    scriptURL = url
                    let configuration = NSWorkspace.OpenConfiguration()
                    configuration.activates = true
                    _ = try await NSWorkspace.shared.open([url], withApplicationAt: URL(fileURLWithPath: terminal), configuration: configuration)
                    Task {
                        try? await Task.sleep(for: .seconds(1800))
                        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
                    }
                } catch {
                    if let scriptURL { try? FileManager.default.removeItem(at: scriptURL.deletingLastPathComponent()) }
                    NSLog("Watcher: could not open report: \(error)")
                }
            }
            return
        }

        let headless = ExeWatcherCLI.makeProcess(subcommand: subcommand)
        headless.standardOutput = FileHandle.nullDevice
        headless.standardError = FileHandle.nullDevice
        do {
            try headless.run()
        } catch {
            NSLog("Exe Watcher: headless report launch failed: \(error)")
        }
    }

    /// Each argument is quoted independently, including an app name containing spaces or quotes.
    static func shellCommand(_ argv: [String]) -> String {
        argv.map { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }.joined(separator: " ")
    }

    static func createCommandFile(argv: [String]) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("watcher-report-" + UUID().uuidString)
        let url = directory.appendingPathComponent("Watcher Report.command")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        do {
            let script = "#!/bin/zsh\n/bin/rm -f -- \"$0\"\nexec " + shellCommand(argv) + "\n"
            try Data(script.utf8).write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
            return url
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    /// Let Claude Code own its browser login and credential writes. Opening a private
    /// command file avoids asking for permission to automate the user's Terminal.
    @MainActor static func openClaudeLogin() async -> Bool {
        guard let terminal = terminalPaths.first(where: FileManager.default.fileExists(atPath:)) else { return false }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("watcher-claude-login-" + UUID().uuidString)
        let scriptURL = directory.appendingPathComponent("Sign in with Claude.command")
        let script = """
        #!/bin/zsh
        export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
        if ! command -v claude >/dev/null 2>&1; then
            printf '%s\\n' 'Install Claude Code first, then select Sign in with Claude in Watcher.'
            /usr/bin/open 'https://code.claude.com/docs/en/setup'
            exit 1
        fi
        claude auth login --claudeai
        printf '%s\\n' '' 'Return to Watcher and select Refresh after signing in.'
        """
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try Data(script.utf8).write(to: scriptURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scriptURL.path)
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            _ = try await NSWorkspace.shared.open([scriptURL], withApplicationAt: URL(fileURLWithPath: terminal), configuration: configuration)
            Task {
                try? await Task.sleep(for: .seconds(1800))
                try? FileManager.default.removeItem(at: directory)
            }
            return true
        } catch {
            try? FileManager.default.removeItem(at: directory)
            return false
        }
    }

}
