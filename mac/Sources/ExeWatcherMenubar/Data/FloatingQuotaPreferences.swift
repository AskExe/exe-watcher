import Foundation
import Observation

enum FloatingQuotaEdge: String, Codable, CaseIterable {
    case left, right, top, bottom
    var horizontal: Bool { self == .top || self == .bottom }
}

enum FloatingTimePeriod: String, CaseIterable {
    case today, week, month, all
    var label: String {
        switch self { case .today: "Today"; case .week: "Week"; case .month: "Month"; case .all: "All Time" }
    }
    var period: Period {
        switch self { case .today: .today; case .week: .sevenDays; case .month: .month; case .all: .all }
    }
}

struct FloatingQuotaPosition: Codable, Equatable {
    var edge: FloatingQuotaEdge? = .right
    var horizontal = false
    var x: Double = 1
    var y: Double = 0.72
    var screenID: String?

    var isValid: Bool { x.isFinite && y.isFinite && (0...1).contains(x) && (0...1).contains(y) }
}

@MainActor @Observable
final class FloatingQuotaPreferences {
    static let enabledKey = "exe-watcher.floatingQuota.enabled"
    private static let positionKey = "exe-watcher.floatingQuota.position"
    private static let horizonKey = "exe-watcher.floatingQuota.horizon"
    private static let providersKey = "exe-watcher.floatingQuota.providers"
    private static let selectedProviderKey = "exe-watcher.floatingQuota.selectedProvider"
    private static let timePeriodKey = "exe-watcher.floatingQuota.timePeriod"
    private let defaults: UserDefaults

    var shownProviders: Set<QuotaProviderID> { didSet { defaults.set(shownProviders.map(\.rawValue).sorted(), forKey: Self.providersKey) } }
    var selectedProvider: QuotaProviderID { didSet { defaults.set(selectedProvider.rawValue, forKey: Self.selectedProviderKey) } }
    var orderedProviders: [QuotaProviderID] { QuotaProviderID.allCases.filter { shownProviders.contains($0) } }
    var activeProvider: QuotaProviderID { shownProviders.contains(selectedProvider) ? selectedProvider : orderedProviders.first ?? .claude }
    func showProvider(_ provider: QuotaProviderID, visible: Bool) {
        if visible { shownProviders.insert(provider) }
        else if shownProviders.count > 1 { shownProviders.remove(provider) }
        selectedProvider = activeProvider
    }

    var isEnabled: Bool { didSet { defaults.set(isEnabled, forKey: Self.enabledKey) } }
    var horizon: FloatingQuota.Horizon { didSet { defaults.set(horizon.rawValue, forKey: Self.horizonKey) } }
    var timePeriod: FloatingTimePeriod { didSet { defaults.set(timePeriod.rawValue, forKey: Self.timePeriodKey) } }
    var position: FloatingQuotaPosition {
        didSet {
            guard position.isValid, let data = try? JSONEncoder().encode(position) else { return }
            defaults.set(data, forKey: Self.positionKey)
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let savedProviders = Set((defaults.stringArray(forKey: Self.providersKey) ?? []).compactMap(QuotaProviderID.init(rawValue:)))
        shownProviders = savedProviders.isEmpty ? [.claude, .codex] : savedProviders
        selectedProvider = defaults.string(forKey: Self.selectedProviderKey).flatMap(QuotaProviderID.init(rawValue:)) ?? .claude
        isEnabled = defaults.bool(forKey: Self.enabledKey)
        horizon = defaults.string(forKey: Self.horizonKey).flatMap(FloatingQuota.Horizon.init(rawValue:)) ?? .fiveHour
        timePeriod = defaults.string(forKey: Self.timePeriodKey).flatMap(FloatingTimePeriod.init(rawValue:)) ?? .today
        if let data = defaults.data(forKey: Self.positionKey),
           let saved = try? JSONDecoder().decode(FloatingQuotaPosition.self, from: data), saved.isValid {
            position = saved
        } else { position = FloatingQuotaPosition() }
    }

    func resetPosition() { position = FloatingQuotaPosition() }
}
