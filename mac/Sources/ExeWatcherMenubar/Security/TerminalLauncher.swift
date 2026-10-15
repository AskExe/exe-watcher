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

    /// Launches `claude login` in Terminal.app so the user can complete the OAuth flow
    /// without leaving Exe Watcher. The command is a hardcoded literal -- no user input is
    /// interpolated, so there's no injection surface.
    static func openClaudeLogin() -> Bool {
        guard terminalPaths.contains(where: FileManager.default.fileExists(atPath:)) else {
            NSLog("Exe Watcher: Terminal.app not present; user must run `claude login` manually")
            return false
        }
        runInTerminal(command: "claude login", preValidated: true)
        return true
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
