import Foundation
import Testing
@testable import ExeWatcherMenubar

@Suite("Update checker")
@MainActor
struct UpdateCheckerTests {
    @Test("debug override does not surface update button when no update exists")
    func debugOverrideDoesNotShowButton() {
        UserDefaults.standard.removeObject(forKey: "UpdateChecker.forceUpdateButton")
        let checker = UpdateChecker()
        checker.latestVersion = nil
        #expect(checker.updateAvailable == false)
        #expect(checker.shouldShowUpdateButton == false)

        // Debug override alone must NOT surface the button in production
        UserDefaults.standard.set(true, forKey: "UpdateChecker.forceUpdateButton")
        defer { UserDefaults.standard.removeObject(forKey: "UpdateChecker.forceUpdateButton") }

        #expect(checker.shouldShowUpdateButton == false,
                "Debug override should not show the button when no update exists")
    }

    @Test("same version is not an update")
    func sameVersionNotUpdate() {
        let checker = UpdateChecker()
        checker.latestVersion = checker.currentVersion
        #expect(checker.updateAvailable == false)
        #expect(checker.shouldShowUpdateButton == false)
    }

    @Test("detached updater keeps secrets out of argv and preserves only required environment")
    func updaterEnvironmentStaysOutOfShell() {
        let secret = "fixture-only-secret-value"
        let environment = UpdateChecker.installerEnvironment(from: [
            "HOME": "/tmp/watcher-home", "PATH": "/usr/bin:/bin", "NODE_OPTIONS": "--max-old-space-size=256",
            "EXE_WATCHER_KEYCHAIN_HELPER": "/tmp/Watcher Helper", "NPM_TOKEN": secret,
            "AWS_SECRET_ACCESS_KEY": secret, "SUPABASE_SERVICE_ROLE_KEY": secret,
        ])
        #expect(environment["HOME"] == "/tmp/watcher-home")
        #expect(environment["EXE_WATCHER_KEYCHAIN_HELPER"] == "/tmp/Watcher Helper")
        #expect(!environment.values.contains(secret))
        let script = UpdateChecker().detachedInstallerScript(
            executable: "/tmp/Watcher by EXE.app/Contents/Resources/cli/exe-watcher",
            args: ["menubar", "--force"], logPath: "/tmp/watcher update.log")
        #expect(!script.contains(secret))
        #expect(!script.contains("export"))
        #expect(script.contains("menubar"))
    }
}
