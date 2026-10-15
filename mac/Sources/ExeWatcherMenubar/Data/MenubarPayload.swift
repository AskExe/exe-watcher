import Foundation

/// Shape of `exe-watcher status --format menubar-json --period <period>`.
/// `current` is scoped to the requested period; the whole payload reflects that slice.
struct MenubarPayload: Codable, Sendable {
    let generated: String
    let cliVersion: String?
    let minAppVersion: String?
    let current: CurrentBlock
    let optimize: OptimizeBlock
    let history: HistoryBlock
    let diagnostics: DiagnosticsBlock?
    let agentStats: AgentStatsBlock?
    let exeOsDetected: Bool?
    let statsFileAge: Double?
    let projectSpend: [ProjectSpendEntry]?
    var periodSnapshots: [String: PeriodSnapshot]? = nil
    var time: TimeBlock? = nil

    // Old same-day snapshots have no coverage fields. Their recovery warning
    // still prevents an unknown count from appearing as an exact zero or total.
    var hasIncompleteCallCounts: Bool {
        current.callsIncomplete ?? (diagnostics?.hasRecoveredUsage == true || (current.calls == 0 && current.cost > 0))
    }

    var callCount: CallCount {
        CallCount(recorded: current.calls, isIncomplete: hasIncompleteCallCounts)
    }

    func callCount(for model: ModelEntry) -> CallCount {
        CallCount(recorded: model.calls, isIncomplete: model.callsIncomplete
            ?? (hasIncompleteCallCounts || (model.calls == 0 && model.cost > 0)))
    }
}

struct PeriodSnapshot: Codable, Sendable {
    let current: CurrentBlock
    let projectSpend: [ProjectSpendEntry]?
    let diagnostics: DiagnosticsBlock?
    let historyValidatedAt: Double
    var time: TimeBlock? = nil
}

struct TimeBlock: Codable, Sendable {
    let since: String
    let through: String
    let aiRunningMs: Double?
    let elapsedBusyMs: Double?
    let userActiveMs: Double?
    let estimatedAiMs: Double
    let coverage: String
    let pendingFiles: Int
    let indexedFiles: Int
    let firstRecordedAt: String?
    let lastRecordedAt: String?
    let providers: [TimeProviderBlock]
    let notes: [String]

    static func duration(_ milliseconds: Double?) -> String {
        guard let value = milliseconds, value.isFinite, value >= 0, value < 315_576_000_000_000 else { return "Unknown" }
        if value < 60_000 { return "<1 min" }
        let minutes = Int(value / 60_000)
        return minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
    }
}

struct TimeProviderBlock: Codable, Sendable, Identifiable {
    let name: String
    let files: Int
    let timedFiles: Int
    let aiRunningMs: Double?
    let status: String
    var id: String { name }
}

struct DiagnosticsBlock: Codable, Sendable {
    let daysCount: Int
    let parseTimeMs: Int
    let warnings: [String]

    var hasUnpricedUsage: Bool {
        warnings.contains { $0.hasPrefix("No API pricing for model") || $0.contains("no token counts; its API-equivalent cost cannot be calculated") }
    }

    var hasRecoveredUsage: Bool {
        warnings.contains { $0.contains("historical Claude token counters") }
    }

    var discoveryWarning: String? {
        warnings.first { $0.hasPrefix("Provider \"") && $0.contains("discovery failed:") }
    }
}

struct ProjectSpendEntry: Codable, Sendable, Identifiable {
    let name: String
    let cost24h: Double
    let cost7d: Double
    let cost30d: Double
    let selectedPeriodCost: Double
    let sessions: Int

    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, cost24h, cost7d, cost30d, selectedPeriodCost, sessions
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        cost24h = try c.decodeIfPresent(Double.self, forKey: .cost24h) ?? 0
        cost7d = try c.decodeIfPresent(Double.self, forKey: .cost7d) ?? 0
        cost30d = try c.decodeIfPresent(Double.self, forKey: .cost30d) ?? 0
        selectedPeriodCost = try c.decodeIfPresent(Double.self, forKey: .selectedPeriodCost) ?? cost30d
        sessions = try c.decodeIfPresent(Int.self, forKey: .sessions) ?? 0
    }
}

// MARK: - Exe OS Agent Memory Stats (auto-detected)

struct AgentStatsBlock: Codable, Sendable {
    let generated: String
    let agents: [AgentStat]
    let daemon: DaemonInfo
}

struct AgentStat: Codable, Sendable, Identifiable {
    let id: String
    let total: Int
    let growth24h: Int
    let growth7d: Int
    let growth30d: Int
    let costUSD: Double
    let cost24h: Double
    let cost7d: Double
    let cost30d: Double

    enum CodingKeys: String, CodingKey {
        case id, total, growth24h, growth7d, growth30d, costUSD, cost24h, cost7d, cost30d
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        total = try c.decode(Int.self, forKey: .total)
        growth24h = try c.decodeIfPresent(Int.self, forKey: .growth24h) ?? 0
        growth7d = try c.decode(Int.self, forKey: .growth7d)
        growth30d = try c.decodeIfPresent(Int.self, forKey: .growth30d) ?? 0
        costUSD = try c.decodeIfPresent(Double.self, forKey: .costUSD) ?? 0
        cost24h = try c.decodeIfPresent(Double.self, forKey: .cost24h) ?? 0
        cost7d = try c.decodeIfPresent(Double.self, forKey: .cost7d) ?? 0
        cost30d = try c.decodeIfPresent(Double.self, forKey: .cost30d) ?? 0
    }
}

struct DaemonInfo: Codable, Sendable {
    let uptime: Double
    let pid: Int
}

struct HistoryBlock: Codable, Sendable {
    let daily: [DailyHistoryEntry]
}

struct DailyModelBreakdown: Codable, Sendable {
    let name: String
    let cost: Double
    let calls: Int
    let inputTokens: Int
    let outputTokens: Int

    var totalTokens: Int { inputTokens + outputTokens }
}

struct DailyHistoryEntry: Codable, Sendable {
    let date: String
    let cost: Double
    let calls: Int
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let topModels: [DailyModelBreakdown]

    /// Pricing-ratio prior: input + 5x output + cache_creation + 0.1x cache_read.
    /// Matches Anthropic's published per-token pricing on Sonnet/Opus closely enough to be a useful proxy.
    var effectiveTokens: Double {
        Double(inputTokens) + 5.0 * Double(outputTokens) + Double(cacheWriteTokens) + 0.1 * Double(cacheReadTokens)
    }
}

extension DailyHistoryEntry {
    /// Required for legacy payloads (no topModels emitted yet).
    enum CodingKeys: String, CodingKey {
        case date, cost, calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, topModels
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.decode(String.self, forKey: .date)
        cost = try c.decode(Double.self, forKey: .cost)
        calls = try c.decode(Int.self, forKey: .calls)
        inputTokens = try c.decode(Int.self, forKey: .inputTokens)
        outputTokens = try c.decode(Int.self, forKey: .outputTokens)
        cacheReadTokens = try c.decode(Int.self, forKey: .cacheReadTokens)
        cacheWriteTokens = try c.decode(Int.self, forKey: .cacheWriteTokens)
        topModels = try c.decodeIfPresent([DailyModelBreakdown].self, forKey: .topModels) ?? []
    }
}

struct CurrentBlock: Codable, Sendable {
    let label: String
    let cost: Double
    let calls: Int
    let sessions: Int
    let oneShotRate: Double?
    let inputTokens: Int
    let outputTokens: Int
    let cacheHitPercent: Double
    let topActivities: [ActivityEntry]
    let topModels: [ModelEntry]
    let providers: [String: Double]
    var callsIncomplete: Bool? = nil
}

struct ActivityEntry: Codable, Sendable {
    let name: String
    let cost: Double
    let turns: Int
    let oneShotRate: Double?
}

struct ModelEntry: Codable, Sendable {
    let name: String
    let cost: Double
    let calls: Int
    var callsIncomplete: Bool? = nil
}

struct CallCount {
    let recorded: Int
    let isIncomplete: Bool

    var displayValue: String {
        if isIncomplete && recorded == 0 { return "—" }
        return recorded.asThousandsSeparated() + (isIncomplete ? "+" : "")
    }

    var explanation: String {
        if isIncomplete {
            return "\(recorded.asThousandsSeparated()) calls are recorded in retained logs. Recovered historical token totals have no call counts, so the full count is unknown."
        }
        return "\(recorded.asThousandsSeparated()) calls recorded in local usage logs."
    }
}

struct OptimizeBlock: Codable, Sendable {
    let findingCount: Int
    let savingsUSD: Double
    let topFindings: [FindingEntry]
}

struct FindingEntry: Codable, Sendable {
    let title: String
    let impact: String
    let savingsUSD: Double
}

// MARK: - Empty fallback

extension MenubarPayload {
    /// Strictly-empty payload. Used as the fallback before real data arrives, so no
    /// plausible-looking fake numbers leak into the UI.
    static let empty = MenubarPayload(
        generated: "",
        cliVersion: nil,
        minAppVersion: nil,
        current: CurrentBlock(
            label: "",
            cost: 0,
            calls: 0,
            sessions: 0,
            oneShotRate: nil,
            inputTokens: 0,
            outputTokens: 0,
            cacheHitPercent: 0,
            topActivities: [],
            topModels: [],
            providers: [:]
        ),
        optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
        history: HistoryBlock(daily: []),
        diagnostics: nil,
        agentStats: nil,
        exeOsDetected: nil,
        statsFileAge: nil,
        projectSpend: nil
    )
}
