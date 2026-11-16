import Foundation
import Testing
@testable import ExeWatcherMenubar

@Suite("ExeWatcherCLI resolution")
struct ExeWatcherCLIResolutionTests {
    @Test("bundled CLI preserves app-path spaces and works without a global install")
    func bundledLauncher() {
        let app = URL(fileURLWithPath: "/Applications/Watcher by EXE.app")
        let fs = ExeWatcherCLI.ResolverFilesystem(
            isExecutable: { $0 == app.path + "/Contents/Resources/cli/exe-watcher" || $0 == app.path + "/Contents/Helpers/node" },
            listDirectory: { _ in [] }
        )
        #expect(ExeWatcherCLI.bundledArgv(bundleURL: app, filesystem: fs) == [app.path + "/Contents/Resources/cli/exe-watcher"])
    }

    @Test("incomplete runtime or development binary falls back to external CLI resolution")
    func incompleteBundle() {
        let fs = ExeWatcherCLI.ResolverFilesystem(isExecutable: { _ in false }, listDirectory: { _ in [] })
        #expect(ExeWatcherCLI.bundledArgv(bundleURL: URL(fileURLWithPath: "/Applications/Watcher.app"), filesystem: fs) == nil)
        #expect(ExeWatcherCLI.bundledArgv(bundleURL: URL(fileURLWithPath: "/tmp/ExeWatcherMenubar"), filesystem: fs) == nil)
    }

    @Test("terminal argv keeps spaces, apostrophes and shell metacharacters literal")
    func terminalArgumentQuoting() {
        #expect(TerminalLauncher.shellCommand(["/Applications/Henry's $Watcher.app/cli", "report"]) == "'/Applications/Henry'\\''s $Watcher.app/cli' 'report'")
    }

    @Test("private report file runs literal arguments and deletes itself without Apple Events")
    func commandFileExecutesSafely() throws {
        let literal = "Henry's $HOME; $(echo should-not-run) \"report\""
        let url = try TerminalLauncher.createCommandFile(argv: ["/usr/bin/printf", "%s", literal])
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        for path in [url, url.deletingLastPathComponent()] {
            let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
            #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        }
        let output = Pipe()
        let process = Process()
        process.executableURL = url
        process.standardOutput = output
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        #expect(String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) == literal)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test("bundled CLI ignores inherited Node loader and heap overrides")
    func inheritedNodeOptionsAreNotTrusted() {
        let previous = ProcessInfo.processInfo.environment["NODE_OPTIONS"]
        setenv("NODE_OPTIONS", "--require /tmp/untrusted.js --max-old-space-size=4096", 1)
        defer {
            if let previous { setenv("NODE_OPTIONS", previous, 1) }
            else { unsetenv("NODE_OPTIONS") }
        }
        let process = ExeWatcherCLI.makeProcess(subcommand: ["status"])
        #expect(process.environment?["NODE_OPTIONS"] == "--max-old-space-size=256")
    }

    @Test("skips broken latest NVM bins and falls back to the newest working install")
    func resolvesNewestWorkingNvmBinary() {
        let fs = ExeWatcherCLI.ResolverFilesystem(
            isExecutable: { path in
                path == "/Users/test/.nvm/versions/node/v22.19.0/bin/exe-watcher"
            },
            listDirectory: { path in
                if path == "/Users/test/.nvm/versions/node" {
                    return ["v22.20.0", "v22.19.0", "v20.18.0"]
                }
                return []
            }
        )

        let resolved = ExeWatcherCLI.resolveBinaryPath(
            environment: [:],
            homeDirectory: "/Users/test",
            filesystem: fs
        )

        #expect(resolved == "/Users/test/.nvm/versions/node/v22.19.0/bin/exe-watcher")
    }

    @Test("prefers an existing PATH entry before scanning fallback directories")
    func prefersExistingPathEntry() {
        let fs = ExeWatcherCLI.ResolverFilesystem(
            isExecutable: { path in
                path == "/custom/bin/exe-watcher" || path == "/Users/test/.nvm/versions/node/v22.20.0/bin/exe-watcher"
            },
            listDirectory: { path in
                if path == "/Users/test/.nvm/versions/node" {
                    return ["v22.20.0"]
                }
                return []
            }
        )

        let resolved = ExeWatcherCLI.resolveBinaryPath(
            environment: ["PATH": "/custom/bin:/usr/bin"],
            homeDirectory: "/Users/test",
            filesystem: fs
        )

        #expect(resolved == "/custom/bin/exe-watcher")
    }
}
