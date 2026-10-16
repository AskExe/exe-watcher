import Foundation

/// Live quota adapters are independent of the clients whose local spend Watcher parses.
enum QuotaProviderID: String, CaseIterable, Codable, Sendable, Identifiable {
    case claude, codex, kimi, cursor, copilot, gemini
    var id: String { rawValue }
    var name: String {
        switch self {
        case .claude: "Claude"; case .codex: "Codex"; case .kimi: "Kimi"
        case .cursor: "Cursor"; case .copilot: "Copilot"; case .gemini: "Gemini"
        }
    }
    var signInHelp: String {
        switch self {
        case .claude: "Sign in to Claude Code, then refresh. macOS may ask for Keychain access on an explicit refresh."
        case .codex: "Sign in to Codex with ChatGPT, run it once to refresh its session, then refresh here. API-key accounts do not expose a subscription allowance."
        case .kimi: "Sign in to Kimi Code and run it once to refresh its session, then refresh here."
        case .cursor: "Sign in to the Cursor app, then refresh here."
        case .copilot: "Sign in to a GitHub Copilot editor plugin, then refresh here."
        case .gemini: "Sign in to Gemini CLI and run it once to refresh its session, then refresh here. Some account tiers no longer expose Gemini CLI quota."
        }
    }
}

struct ProviderQuotaSnapshot: Sendable, Equatable {
    let provider: QuotaProviderID
    var plan: String?
    var windows: [FloatingQuota.Window]
    let fetchedAt: Date
    var notes: [String] = []
    /// Opaque in-memory identity. Never displayed, logged or persisted.
    var identity: String? = nil
}

struct ProviderQuotaState: Sendable {
    var snapshot: ProviderQuotaSnapshot?
    var loadState: SubscriptionLoadState = .idle
    var message: String?
    var nextRefreshAt: Date = .distantPast
    var rateLimitedUntil: Date = .distantPast
    var lastAttempt: Date = .distantPast
}

struct ProviderQuotaFailure: Error, Sendable {
    enum Kind: Sendable { case missing, signIn, unsupported, rateLimited, unavailable, invalidResponse }
    let kind: Kind
    var identity: String? = nil
    var retryAfter: TimeInterval? = nil
    var message: String? = nil
}

typealias ProviderQuotaFetcher = @Sendable (QuotaProviderID, Bool) async throws -> ProviderQuotaSnapshot
