import Foundation

/// Presentation only. Quota is provider-reported capacity, never inferred from dollar spend.
struct FloatingQuota: Equatable {
    enum Horizon: String, Codable, CaseIterable {
        case weekly, fiveHour
        var label: String { self == .fiveHour ? "5-hour" : "Weekly" }
    }
    struct Window: Identifiable, Equatable, Sendable {
        let id: String
        let label: String
        let percent: Double // Provider-reported percentage used. UI presents remaining capacity.
        let resetsAt: Date?
        var remainingPercent: Double { 100 - percent }
        var remainingFraction: Double { remainingPercent / 100 }
        func expired(at now: Date) -> Bool { resetsAt.map { $0 <= now } ?? false }
    }
    let providerID: QuotaProviderID
    let provider: String
    var notes: [String] = []
    var message: String? = nil
    var isConnected = false
    let plan: String?
    let windows: [Window]
    let fetchedAt: Date?
    let isLoading: Bool
    let needsConnection: Bool
    let failed: Bool

    init(usage: SubscriptionUsage?, state: SubscriptionLoadState) {
        providerID = .claude
        provider = "Claude"
        isConnected = usage != nil
        plan = usage?.tier.displayName
        fetchedAt = usage?.fetchedAt
        isLoading = state == .loading
        needsConnection = state == .noCredentials || state == .idle
        failed = state == .failed
        let inputs: [(String, String, Double?, Date?)] = [
            ("fiveHour", "5-hour window", usage?.fiveHourPercent, usage?.fiveHourResetsAt),
            ("weekly", "Weekly", usage?.sevenDayPercent, usage?.sevenDayResetsAt),
            ("opus", "Weekly · Opus", usage?.sevenDayOpusPercent, usage?.sevenDayOpusResetsAt),
            ("sonnet", "Weekly · Sonnet", usage?.sevenDaySonnetPercent, usage?.sevenDaySonnetResetsAt),
        ]
        windows = inputs.compactMap { id, label, percent, reset in
            guard let percent, percent.isFinite else { return nil }
            return Window(id: id, label: label, percent: min(100, max(0, percent)), resetsAt: reset)
        }
    }

    init(provider: QuotaProviderID, state: ProviderQuotaState) {
        providerID = provider
        self.provider = provider.name
        plan = state.snapshot?.plan
        windows = state.snapshot?.windows.filter { $0.percent.isFinite }.map {
            Window(id: $0.id, label: $0.label, percent: min(100, max(0, $0.percent)), resetsAt: $0.resetsAt)
        } ?? []
        fetchedAt = state.snapshot?.fetchedAt
        isLoading = state.loadState == .loading
        needsConnection = state.loadState == .idle || state.loadState == .noCredentials
        failed = state.loadState == .failed
        notes = state.snapshot?.notes ?? []
        message = state.message
        isConnected = state.snapshot != nil
    }

    func primary(_ horizon: Horizon) -> Window? {
        if let window = windows.first(where: { $0.id == horizon.rawValue }) { return window }
        // A missing 5-hour limit must not masquerade as the requested window.
        if providerID == .claude || providerID == .codex { return nil }
        return windows.first
    }
    func isStale(at now: Date) -> Bool {
        guard let fetchedAt else { return false }
        return failed || now.timeIntervalSince(fetchedAt) > 10 * 60 || fetchedAt > now.addingTimeInterval(60)
    }
    func status(at now: Date) -> String {
        if isLoading { return "Updating" }
        if needsConnection && windows.isEmpty { return "Connect" }
        if isStale(at: now) { return "Stale reading" }
        if windows.contains(where: { $0.expired(at: now) }) { return "Reset pending" }
        if failed { return "Unavailable" }
        return windows.isEmpty ? (isConnected ? "No percentage reported" : "No quota data") : "Live capacity"
    }
    static func resetText(_ date: Date?, now: Date) -> String {
        guard let date else { return "Reset time unavailable" }
        let seconds = date.timeIntervalSince(now)
        guard seconds > 0 else { return "Waiting for reset update" }
        let minutes = max(1, Int(ceil(seconds / 60)))
        if minutes < 60 { return "Resets in \(minutes)m" }
        if minutes < 24 * 60 { return "Resets in \(minutes / 60)h \(minutes % 60)m" }
        return "Resets in \(minutes / (24 * 60))d \((minutes / 60) % 24)h"
    }
}
