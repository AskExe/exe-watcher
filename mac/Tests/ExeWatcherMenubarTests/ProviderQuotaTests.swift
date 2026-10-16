import Foundation
import AppKit
import SQLite3
import Testing
@testable import ExeWatcherMenubar

private let providerNow = Date(timeIntervalSince1970: 1_800_000_000)
private func jsonData(_ body: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: body) }
private func jwt(_ subject: String = "user-1", expires: Double = 1_900_000_000) throws -> String {
    let claims = try jsonData(["sub": subject, "exp": expires, "padding": String(repeating: "x", count: 200)])
        .base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    return "e30." + claims + ".signature"
}
private func response(_ request: URLRequest, body: [String: Any], status: Int = 200, headers: [String: String] = [:]) throws -> (Data, HTTPURLResponse) {
    (try jsonData(body), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!)
}
private func codexBody() -> [String: Any] { ["plan_type": "pro", "rate_limit": [
    "primary_window": ["used_percent": 42, "limit_window_seconds": 18000, "reset_at": 1_800_003_600],
    "secondary_window": ["used_percent": 55, "limit_window_seconds": 604800, "reset_at": 1_800_086_400]]] }

@Suite("Provider quota response mapping")
struct ProviderQuotaDecoderTests {
    @Test func codexReportedDurationsAndMonthlyAllowance() throws {
        var body = codexBody()
        body["spend_control"] = ["individual_limit": ["limit": "1000", "used": "250", "reset_at": 1_800_086_400]]
        let result = try QuotaResponseDecoder.decode(.codex, body: body, now: providerNow)
        #expect(result.plan == "Pro")
        #expect(result.windows.map(\.id) == ["fiveHour", "weekly", "monthly"])
        #expect(result.windows.map(\.percent) == [42, 55, 25])
        let unusual = try QuotaResponseDecoder.decode(.codex, body: ["rate_limit": ["primary_window": ["used_percent": 0, "limit_window_seconds": 10800]]], now: providerNow)
        #expect(unusual.windows.first?.label == "3-hour")
        #expect(unusual.windows.first?.id == "primary")
    }
    @Test func malformedQuotaIsUnknownRatherThanZero() {
        for value: Any in ["", "bad", true, NSNull()] {
            #expect(throws: ProviderQuotaFailure.self) {
                try QuotaResponseDecoder.decode(.codex, body: ["rate_limit": ["primary_window": ["used_percent": value]]], now: providerNow)
            }
        }
        #expect(QuotaJSON.number(false) == nil)
        #expect(QuotaJSON.number(Double.infinity) == nil)
    }
    @Test func kimiRatiosAndMinuteWindows() throws {
        let result = try QuotaResponseDecoder.decode(.kimi, body: [
            "usage": ["limit": "100", "remaining": "72", "resetTime": "2027-01-16T12:00:00Z"],
            "limits": [["window": ["duration": 300, "timeUnit": "TIME_UNIT_MINUTE"], "detail": ["limit": 100, "used": 67]]]], now: providerNow)
        #expect(result.windows.map(\.id) == ["weekly", "fiveHour"])
        #expect(abs(result.windows[0].percent - 28) < 0.001 && result.windows[1].percent == 67)
        #expect(throws: ProviderQuotaFailure.self) { try QuotaResponseDecoder.decode(.kimi, body: ["usage": ["limit": 100]], now: providerNow) }
    }
    @Test func cursorUsesWorseReportedPoolAndUnlimitedIsNotZero() throws {
        let result = try QuotaResponseDecoder.decode(.cursor, body: ["individualUsage": ["plan": ["autoPercentUsed": 17, "apiPercentUsed": 81]]], now: providerNow)
        #expect(result.windows.first?.percent == 81)
        let unlimited = try QuotaResponseDecoder.decode(.cursor, body: ["isUnlimited": true], now: providerNow)
        #expect(unlimited.windows.isEmpty && !unlimited.notes.isEmpty)
    }
    @Test func copilotRemainingInvertsAndAbsentAllowancesStayAbsent() throws {
        let result = try QuotaResponseDecoder.decode(.copilot, body: ["quotaSnapshots": [
            "premiumInteractions": ["percentRemaining": 70, "entitlement": 1500],
            "chat": ["percentRemaining": 0, "entitlement": 0]]], now: providerNow)
        #expect(result.windows.count == 1 && result.windows.first?.percent == 30)
        let unlimited = try QuotaResponseDecoder.decode(.copilot, body: ["quota_snapshots": ["chat": ["unlimited": true, "percent_remaining": 0]]], now: providerNow)
        #expect(unlimited.windows.isEmpty && unlimited.notes == ["Chat: unlimited"])
    }
    @Test func geminiReportsWorstModelFirstAndKeepsUnknownOut() throws {
        let result = try QuotaResponseDecoder.decode(.gemini, body: ["buckets": [
            ["modelId": "model-a", "remainingFraction": 0.8], ["modelId": "model-b", "remainingFraction": 0.1], ["modelId": "unknown"]]], now: providerNow)
        #expect(result.windows.count == 2 && result.windows.first?.label == "model-b")
        #expect(abs((result.windows.first?.percent ?? 0) - 90) < 0.001)
    }
}

private func dependencies(files: [String: Data] = [:], cursor: String? = nil,
                          keychain: @escaping @Sendable (String, String, Bool) throws -> Data? = { _, _, _ in nil },
                          request: @escaping @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)) -> ProviderQuotaClient.Dependencies {
    .init(home: URL(fileURLWithPath: "/fixture"), environment: [:], now: { providerNow },
        readFile: { url, _ in files[url.path] }, readKeychain: keychain, cursorToken: { _ in cursor }, request: request)
}

@Suite("Read-only quota credentials and request boundaries")
struct ProviderQuotaClientTests {
    @Test func codexFileAndAccountHeaderKeepFullToken() async throws {
        let token = try jwt()
        let files = ["/fixture/.codex/auth.json": try jsonData(["auth_mode": "chatgpt", "tokens": ["access_token": token, "account_id": "account-1"]])]
        let result = try await ProviderQuotaClient.fetch(.codex, dependencies: dependencies(files: files) { request in
            #expect(request.url?.absoluteString == "https://chatgpt.com/backend-api/wham/usage")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer " + token)
            #expect(request.value(forHTTPHeaderField: "ChatGPT-Account-Id") == "account-1")
            #expect(request.httpMethod == "GET")
            return try response(request, body: codexBody())
        })
        #expect(result.provider == .codex && result.windows.count == 2)
    }
    @Test func codexKeyringReadStaysPassive() async throws {
        let auth = try jsonData(["auth_mode": "chatgpt", "tokens": ["access_token": jwt()]])
        let files = ["/fixture/.codex/config.toml": Data("cli_auth_credentials_store = \"keyring\"".utf8)]
        let d = dependencies(files: files, keychain: { service, account, prompt in
            #expect(service == "Codex Auth" && account.hasPrefix("cli|"))
            #expect(!prompt)
            return auth
        }) { try response($0, body: codexBody()) }
        #expect(try await ProviderQuotaClient.fetch(.codex, dependencies: d).windows.count == 2)
    }
    @Test func autoKeyringAccessFailureCannotFallBackToAnOlderFileAccount() async throws {
        let files = ["/fixture/.codex/config.toml": Data("cli_auth_credentials_store = \"auto\"".utf8),
                     "/fixture/.codex/auth.json": try jsonData(["tokens": ["access_token": jwt(), "account_id": "older-file-account"]])]
        let d = dependencies(files: files, keychain: { _, _, _ in throw ProviderQuotaFailure(kind: .signIn) }) { _ in
            Issue.record("Unexpected fallback to a different credential source"); throw CancellationError()
        }
        await #expect(throws: ProviderQuotaFailure.self) { try await ProviderQuotaClient.fetch(.codex, dependencies: d) }
    }
    @Test func apiKeysAndExpiredTokensNeverReachTheNetwork() async throws {
        for root in [["auth_mode": "apikey", "OPENAI_API_KEY": "test-only-key"],
                     ["OPENAI_API_KEY": "test-only-key", "tokens": ["access_token": try jwt()]],
                     ["auth_mode": "chatgpt", "tokens": ["access_token": try jwt(expires: 1_700_000_000)]]] as [[String: Any]] {
            let d = dependencies(files: ["/fixture/.codex/auth.json": try jsonData(root)]) { _ in
                Issue.record("Unexpected request for unusable credentials"); throw CancellationError()
            }
            await #expect(throws: ProviderQuotaFailure.self) { try await ProviderQuotaClient.fetch(.codex, dependencies: d) }
        }
    }
    @Test func malformedCredentialFileIsAnAuthenticationFailure() async {
        let d = dependencies(files: ["/fixture/.codex/auth.json": Data("{broken".utf8)]) { _ in
            Issue.record("Unexpected request for malformed credentials"); throw CancellationError()
        }
        do { _ = try await ProviderQuotaClient.fetch(.codex, dependencies: d); Issue.record("Expected authentication failure") }
        catch let error as ProviderQuotaFailure { #expect(error.kind == .signIn) }
        catch { Issue.record("Unexpected error kind") }
    }
    @Test func copilotCredentialStaysOnItsTenantAndRejectsInjectedHosts() async throws {
        let files = ["/fixture/.config/github-copilot/hosts.json": try jsonData(["example.ghe.com": ["oauth_token": "test-tenant-token"]])]
        _ = try await ProviderQuotaClient.fetch(.copilot, dependencies: dependencies(files: files) { request in
            #expect(request.url?.host == "api.example.ghe.com")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "token test-tenant-token")
            return try response(request, body: ["quota_snapshots": ["chat": ["entitlement": 100, "percent_remaining": 50]]])
        })
        for host in ["evil.com?.ghe.com", "ghe.com", "example.ghe.com@evil.com", "http://example.ghe.com", "github.company.test"] {
            #expect(ProviderQuotaClient.copilotAPIHost(host) == nil)
        }
        let unscoped = dependencies(files: ["/fixture/.config/github-copilot/apps.json": try jsonData(["Visual Studio Code": ["oauth_token": "test-unscoped-token"]])]) { _ in
            Issue.record("Hostless credentials cannot default to GitHub.com"); throw CancellationError()
        }
        await #expect(throws: ProviderQuotaFailure.self) { try await ProviderQuotaClient.fetch(.copilot, dependencies: unscoped) }

    }
    @Test func cursorCookieUsesValidatedSessionAndGeminiPostsStayReadOnly() async throws {
        let token = try jwt("auth0|user-1")
        _ = try await ProviderQuotaClient.fetch(.cursor, dependencies: dependencies(cursor: token) { request in
            #expect(request.value(forHTTPHeaderField: "Cookie") == "WorkosCursorSessionToken=user-1%3A%3A" + token)
            return try response(request, body: ["isUnlimited": true])
        })
        let gemini = dependencies(files: ["/fixture/.gemini/oauth_creds.json": try jsonData(["access_token": "test-google-session", "expiry_date": 1_900_000_000_000])]) { request in
            #expect(request.url?.host == "cloudcode-pa.googleapis.com" && request.httpMethod == "POST")
            #expect(request.url?.host != "oauth2.googleapis.com")
            if request.url?.absoluteString.hasSuffix(":loadCodeAssist") == true {
                return try response(request, body: ["cloudaicompanionProject": "test-project", "currentTier": ["name": "Workspace"]])
            }
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as? [String: String]
            #expect(body?["project"] == "test-project")
            return try response(request, body: ["buckets": [["modelId": "gemini-test", "remainingFraction": 0.8]]])
        }
        #expect(try await ProviderQuotaClient.fetch(.gemini, dependencies: gemini).plan == "Workspace")
    }
    @Test func kimiUsesItsOwnSessionAndDeviceHeader() async throws {
        let files = ["/fixture/.kimi-code/credentials/kimi-code.json": try jsonData(["access_token": "test-kimi-session", "expires_at": 1_900_000_000]),
                     "/fixture/.kimi-code/device_id": Data("test-device\n".utf8)]
        let result = try await ProviderQuotaClient.fetch(.kimi, dependencies: dependencies(files: files) { request in
            #expect(request.url?.host == "api.kimi.com")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-kimi-session")
            #expect(request.value(forHTTPHeaderField: "X-Msh-Device-Id") == "test-device")
            return try response(request, body: ["usage": ["limit": 100, "remaining": 72]])
        })
        #expect(result.provider == .kimi)
    }
    @Test func customCodexGatewaysNeverSendCredentialsToChatGPT() async throws {
        let files = ["/fixture/.codex/config.toml": Data("chatgpt_base_url = \"https://gateway.example.test\"".utf8)]
        let d = dependencies(files: files) { _ in Issue.record("Unexpected gateway credential request"); throw CancellationError() }
        await #expect(throws: ProviderQuotaFailure.self) { try await ProviderQuotaClient.fetch(.codex, dependencies: d) }
    }
    @Test func rateLimitHonorsRetryAfterAndNeverExposesResponseBody() async throws {
        let d = dependencies(files: ["/fixture/.codex/auth.json": try jsonData(["tokens": ["access_token": jwt()]])]) {
            try response($0, body: ["private": "not-for-ui"], status: 429, headers: ["Retry-After": "1800"])
        }
        do { _ = try await ProviderQuotaClient.fetch(.codex, dependencies: d); Issue.record("Expected cooldown") }
        catch let error as ProviderQuotaFailure { #expect(error.kind == .rateLimited && error.retryAfter == 1800); #expect(error.message == nil) }
        #expect(ProviderQuotaClient.retryAfter("bad", now: providerNow) == 900)
    }
    @Test func credentialFilesRejectSymlinksOversizeAndSpecialFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("auth.json"), link = root.appendingPathComponent("link"), fifo = root.appendingPathComponent("fifo")
        try Data(repeating: 1, count: 128).write(to: file)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        #expect(throws: ProviderQuotaFailure.self) { try ProviderQuotaClient.readCredential(file, limit: 64) }
        #expect(throws: ProviderQuotaFailure.self) { try ProviderQuotaClient.readCredential(link, limit: 256) }
        #expect(mkfifo(fifo.path, 0o600) == 0)
        #expect(throws: ProviderQuotaFailure.self) { try ProviderQuotaClient.readCredential(fifo, limit: 256) }
    }
    @Test func cursorDatabaseReadLeavesSourceUnchanged() throws {
        let file = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        var db: OpaquePointer?
        #expect(sqlite3_open(file.path, &db) == SQLITE_OK)
        #expect(sqlite3_exec(db, "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT); INSERT INTO ItemTable VALUES ('cursorAuth/accessToken','test-token');", nil, nil, nil) == SQLITE_OK)
        sqlite3_close(db)
        let before = try Data(contentsOf: file)
        #expect(try ProviderQuotaClient.cursorAccessToken(file) == "test-token")
        #expect(try Data(contentsOf: file) == before)
    }
}

private actor ProviderGate {
    var calls: [QuotaProviderID: Int] = [:]
    var held: CheckedContinuation<ProviderQuotaSnapshot, Error>?
    func fetch(_ provider: QuotaProviderID) async throws -> ProviderQuotaSnapshot {
        calls[provider, default: 0] += 1
        if provider == .codex { return try await withCheckedThrowingContinuation { held = $0 } }
        return providerSnapshot(provider)
    }
    func finish(_ result: Result<ProviderQuotaSnapshot, Error>) { held?.resume(with: result); held = nil }
}
private func providerSnapshot(_ provider: QuotaProviderID, identity: String = "same-account") -> ProviderQuotaSnapshot {
    .init(provider: provider, plan: "Test", windows: [.init(id: "fiveHour", label: "5-hour", percent: 42, resetsAt: providerNow.addingTimeInterval(3600))], fetchedAt: providerNow, identity: identity)
}
private final class ProviderClock: @unchecked Sendable { var now = providerNow }

@Suite("Independent provider refresh state")
struct ProviderQuotaRefreshTests {
    @Test @MainActor func coalescesSameProviderWhileOthersCanComplete() async {
        let gate = ProviderGate()
        let store = AppStore(now: { providerNow }, persistSubscriptionSnapshots: false, fetchProviderQuota: { id, prompt in
            #expect(!prompt)
            return try await gate.fetch(id)
        })
        let first = Task { await store.refreshFloatingQuota(.codex, allowKeychainPrompt: false) }
        while await gate.calls[.codex] == nil { await Task.yield() }
        let same = Task { await store.refreshFloatingQuota(.codex, allowKeychainPrompt: false) }
        await store.refreshFloatingQuota(.kimi, allowKeychainPrompt: false)
        #expect(store.floatingQuota(for: .kimi).windows.first?.percent == 42)
        first.cancel() // Changing the visible provider set cancels a poll waiter, not the shared read.
        await gate.finish(.success(providerSnapshot(.codex)))
        await first.value; await same.value
        #expect(await gate.calls[.codex] == 1)
        await store.refreshFloatingQuota(.codex, allowKeychainPrompt: false)
        #expect(await gate.calls[.codex] == 1)
        #expect(store.floatingQuota(for: .codex).provider == "Codex")
        #expect(store.floatingQuota(for: .codex).windows.first?.percent == 42)
    }
    @Test @MainActor func rateLimitsAreIsolatedAndKeepOnlySameAccountReadings() async {
        let clock = ProviderClock()
        let store = AppStore(now: { clock.now }, persistSubscriptionSnapshots: false, fetchProviderQuota: { _, _ in
            throw ProviderQuotaFailure(kind: .rateLimited, identity: "same-account", retryAfter: 1800)
        })
        store.providerQuotaStates[.codex] = ProviderQuotaState(snapshot: providerSnapshot(.codex), loadState: .loaded)
        store.providerQuotaStates[.kimi] = ProviderQuotaState(snapshot: providerSnapshot(.kimi), loadState: .loaded)
        await store.refreshFloatingQuota(.codex, allowKeychainPrompt: false)
        #expect(store.floatingQuota(for: .codex).isStale(at: providerNow))
        #expect(store.floatingQuota(for: .codex).windows.first?.percent == 42)
        #expect(store.quotaRateLimitedUntil(.codex) == providerNow.addingTimeInterval(1800))
        #expect(store.quotaRateLimitedUntil(.kimi) == .distantPast)
        clock.now = providerNow.addingTimeInterval(1000)
        await store.refreshFloatingQuota(.codex)
        #expect(store.quotaRateLimitedUntil(.codex) == providerNow.addingTimeInterval(1800))
        #expect(!store.floatingQuota(for: .kimi).failed)
    }
    @Test @MainActor func newAccountAndRejectedCredentialsClearThePreviousQuota() async {
        for kind in [ProviderQuotaFailure.Kind.unavailable, .signIn, .missing] {
            let store = AppStore(now: { providerNow }, persistSubscriptionSnapshots: false, fetchProviderQuota: { _, _ in
                throw ProviderQuotaFailure(kind: kind, identity: "different-account")
            })
            store.providerQuotaStates[.codex] = ProviderQuotaState(snapshot: providerSnapshot(.codex), loadState: .loaded)
            await store.refreshFloatingQuota(.codex, allowKeychainPrompt: false)
            #expect(store.floatingQuota(for: .codex).windows.isEmpty)
        }
    }
    @Test @MainActor func providerPreferencesPersistAndAlwaysKeepOneVisible() throws {
        let name = "watcher.multi.quota.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = FloatingQuotaPreferences(defaults: defaults)
        #expect(preferences.shownProviders == [.claude, .codex])
        preferences.showProvider(.kimi, visible: true); preferences.selectedProvider = .kimi
        preferences.showProvider(.claude, visible: false); preferences.showProvider(.codex, visible: false)
        preferences.showProvider(.kimi, visible: false)
        #expect(preferences.shownProviders == [.kimi])
        #expect(FloatingQuotaPreferences(defaults: defaults).activeProvider == .kimi)
    }
    @Test func sixProvidersFitEachEdgeAndReducedDisplays() {
        for screen in [CGRect(x: -1440, y: 250, width: 1440, height: 850), CGRect(x: 0, y: 0, width: 380, height: 400)] {
            for edge in FloatingQuotaEdge.allCases {
                let rail = FloatingQuotaPlacement.railFrame(position: .init(edge: edge), screen: screen, providerCount: 6)
                #expect(screen.contains(rail))
                let drop = FloatingQuotaPlacement.position(afterDropping: rail, screen: screen, screenID: "test", providerCount: 6)
                #expect(drop.isValid)
            }
        }
    }
}
