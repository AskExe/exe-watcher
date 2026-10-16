import Foundation
import Testing
@testable import ExeWatcherMenubar

@Suite("Claude credential source isolation")
struct SubscriptionCredentialTests {
    private func credential(_ token: String, expiresAt: Double) -> Data {
        Data("{\"claudeAiOauth\":{\"accessToken\":\"\(token)\",\"expiresAt\":\(expiresAt)}}".utf8)
    }

    @Test("macOS Keychain login takes precedence over a stale file")
    func currentKeychainBeatsStaleFile() throws {
        let result = try SubscriptionClient.loadCredentials(allowKeychainPrompt: false,
            readKeychain: { prompt in
                #expect(!prompt)
                return credential("current-fixture", expiresAt: 4_000_000_000_000)
            }, readFile: {
                Issue.record("Must not select an older fallback account")
                return credential("expired-fixture", expiresAt: 1)
            })
        #expect(result.accessToken == "current-fixture")
    }

    @Test("a genuinely absent Keychain item permits file fallback")
    func missingKeychainUsesFile() throws {
        let result = try SubscriptionClient.loadCredentials(allowKeychainPrompt: true,
            readKeychain: { prompt in #expect(prompt); return nil },
            readFile: { credential("file-fixture", expiresAt: 4_000_000_000_000) })
        #expect(result.accessToken == "file-fixture")
    }

    @Test("denied Keychain access never selects a different file account")
    func inaccessibleKeychainDoesNotFallBack() {
        #expect(throws: SubscriptionError.self) {
            try SubscriptionClient.loadCredentials(allowKeychainPrompt: false,
                readKeychain: { _ in throw SubscriptionError.keychainAccessRequired },
                readFile: { Issue.record("Must not fall back after access denial"); return nil })
        }
    }

    @Test("malformed Keychain data never selects a different file account")
    func malformedKeychainDoesNotFallBack() {
        #expect(throws: SubscriptionError.self) {
            try SubscriptionClient.loadCredentials(allowKeychainPrompt: false,
                readKeychain: { _ in Data("invalid fixture".utf8) },
                readFile: { Issue.record("Must not fall back after malformed data"); return nil })
        }
    }

    @Test("silent Keychain denial allows immediate explicit refresh")
    @MainActor func explicitAccessAfterSilentRead() async {
        let store = AppStore(fetchSubscription: { prompt in
            if !prompt { throw SubscriptionError.keychainAccessRequired }
            throw SubscriptionError.noCredentials
        }, persistSubscriptionSnapshots: false)
        await store.refreshSubscription(allowKeychainPrompt: false)
        #expect(store.subscriptionLoadState == .noCredentials)
        #expect(store.floatingQuota(for: .claude).message?.contains("Keychain") == true)
        await store.refreshSubscription(allowKeychainPrompt: true)
        #expect(store.floatingQuota(for: .claude).message == nil)
    }
}
