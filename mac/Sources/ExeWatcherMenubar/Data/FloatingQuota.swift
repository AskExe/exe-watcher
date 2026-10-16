import Foundation

/// Presentation only. Quota is provider-reported capacity, never inferred from dollar spend.
struct FloatingQuota: Equatable {
    enum Horizon: String, Codable, CaseIterable {
        case fiveHour, weekly
        var label: String { self == .fiveHour ? "5-hour" : "Weekly" }
    }
    struct Window: Identifiable, Equatable {
        let id: String
        let label: String
        let percent: Double
        let resetsAt: Date?
        var fraction: Double { percent / 100 }
        func expired(at now: Date) -> Bool { resetsAt.map { $0 <= now } ?? false }
    }
    let provider: String
    let plan: String?
    let windows: [Window]
    let fetchedAt: Date?
    let isLoading: Bool
    let needsConnection: Bool
    let failed: Bool

    init(usage: SubscriptionUsage?, state: SubscriptionLoadState) {
        provider = "Claude"
        plan = usage?.tier.displayName
        fetchedAt = usage?.fetchedAt
        isLoading = state == .loading
        needsConnection = state == .noCredentials || state == .idle
        failed = state == .failed
        let inputs: [(String, String, Double?, Date?)] = [
            ("fiveHour", "5-hour window", usage?.fiveHourPercent, usage?.fiveHourResetsAt),
            ("weekly", "Weekly total", usage?.sevenDayPercent, usage?.sevenDayResetsAt),
            ("opus", "Weekly · Opus", usage?.sevenDayOpusPercent, usage?.sevenDayOpusResetsAt),
            ("sonnet", "Weekly · Sonnet", usage?.sevenDaySonnetPercent, usage?.sevenDaySonnetResetsAt),
        ]
        windows = inputs.compactMap { id, label, percent, reset in
            guard let percent, percent.isFinite else { return nil }
            return Window(id: id, label: label, percent: min(100, max(0, percent)), resetsAt: reset)
        }
    }

    func primary(_ horizon: Horizon) -> Window? {
        windows.first { $0.id == horizon.rawValue } ?? windows.first
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
        return windows.isEmpty ? "No quota data" : "Live capacity"
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
