import AppKit
import Foundation

/// Runs commands in the user's Terminal. Every string that reaches AppleScript `do script`
/// is individually shell-quoted argv, OR a hardcoded literal defined here. The private
/// `runInTerminal` re-validates any non-literal input defensively so a future caller can't
/// bypass the invariant.
/// Falls back to a detached headless spawn on machines without Terminal.app (iTerm/Ghostty/Warp
/// users) so the subcommand still runs.
enum TerminalLauncher {
    private static let terminalPaths = [
        "/System/Applications/Utilities/Terminal.app",
        "/Applications/Utilities/Terminal.app",
    ]

    static func open(subcommand: [String]) {
        let argv = ExeWatcherCLI.baseArgv() + subcommand
        guard subcommand.allSatisfy(ExeWatcherCLI.isSafe) else {
            NSLog("Exe Watcher: refusing to open terminal with unsafe argv")
            return
        }
        let command = shellCommand(argv)

        if terminalPaths.contains(where: FileManager.default.fileExists(atPath:)) {
            runInTerminal(command: command, preValidated: true)
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

    private static func runInTerminal(command: String, preValidated: Bool) {
        if !preValidated {
            let tokens = command.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard tokens.allSatisfy(ExeWatcherCLI.isSafe) else {
                NSLog("Exe Watcher: refusing to run unvalidated command in Terminal")
                return
            }
        }
        // `activate` first asks a cold Terminal to create its default window; a
        // subsequent untargeted `do script` creates a second one. Open our report
        // before activating, without reusing a user's existing shell.
        let script = """
        on run argv
        tell application "Terminal"
            do script (item 1 of argv)
            activate
        end tell
        end run
        """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script, command]
        try? process.run()
    }
}
