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
