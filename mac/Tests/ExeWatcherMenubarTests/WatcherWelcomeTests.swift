import Foundation
import Testing
@testable import ExeWatcherMenubar

@Suite("First-open welcome and usage checks")
struct WatcherWelcomeTests {
    @Test @MainActor func firstInstallAndUpgradeShowUntilCompleted() throws {
        let name = "watcher-welcome-test-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        #expect(WatcherWelcomeModel.needsWelcome(defaults: defaults))
        // Existing installations have telemetry preferences but no welcome marker.
        defaults.set(true, forKey: "SUHasLaunchedBefore")
        #expect(WatcherWelcomeModel.needsWelcome(defaults: defaults))
        WatcherWelcomeModel.complete(defaults: defaults)
        #expect(!WatcherWelcomeModel.needsWelcome(defaults: defaults))
    }

    @Test @MainActor func reportsActualSourceStateAndIncludesItInSafeAgentPrompt() async {
        let model = WatcherWelcomeModel(check: {
            UsageCheckReply(version: 1, providers: [
                UsageSourceCheck(id: "codex", name: "Codex", sources: 2, state: "found"),
                UsageSourceCheck(id: "claude", name: "Claude", sources: 0, state: "not-found"),
            ])
        })
        await model.scan()
        #expect(!model.checking)
        #expect(model.sources.count == 2)
        #expect(model.agentPrompt.contains("Codex: 2 local sources found"))
        #expect(model.agentPrompt.contains("Claude: No compatible sources discovered"))
        #expect(model.agentPrompt.contains("doctor --json"))
        #expect(model.agentPrompt.contains("Do not print or upload conversation text"))
        #expect(model.agentPrompt.contains("Do not invent missing token counts or delete caches"))
    }

    @Test @MainActor func failedRescanClearsEarlierSuccessAndRetainsRecoveryInstructions() async {
        var attempts = 0
        let model = WatcherWelcomeModel(check: {
            attempts += 1
            if attempts == 1 {
                return UsageCheckReply(version: 1, providers: [UsageSourceCheck(id: "codex", name: "Codex", sources: 2, state: "found")])
            }
            throw DataClientError.timeout()
        })
        await model.scan()
        #expect(model.sources.count == 1)
        await model.scan()
        #expect(model.sources.isEmpty)
        #expect(model.message.contains("Your saved totals are kept"))
        #expect(model.agentPrompt.contains("did not finish"))
        #expect(!model.checking)
    }
}
