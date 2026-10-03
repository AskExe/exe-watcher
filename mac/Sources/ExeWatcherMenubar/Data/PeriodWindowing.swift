import Foundation

struct PeriodHistoryWindow: Sendable {
    let label: String
    let comparisonLabel: String?
    let entries: [DailyHistoryEntry]
    let comparisonEntries: [DailyHistoryEntry]
}

func makePeriodHistoryWindow(
    period: Period,
    history: [DailyHistoryEntry],
    now: Date = Date()
) -> PeriodHistoryWindow {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    let formatter = periodHistoryFormatter()
    let today = calendar.startOfDay(for: now)

    let entryByDate = Dictionary(history.map { ($0.date, $0) }, uniquingKeysWith: { _, newer in newer })

    func entries(start: Date, end: Date) -> [DailyHistoryEntry] {
        var rows: [DailyHistoryEntry] = []
        var cursor = calendar.startOfDay(for: start)
        let endDay = calendar.startOfDay(for: end)
        while cursor <= endDay {
            let key = formatter.string(from: cursor)
            rows.append(entryByDate[key] ?? emptyHistoryEntry(date: key))
            guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
            cursor = next
        }
        return rows
    }

    switch period {
    case .today:
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today) ?? today
        return PeriodHistoryWindow(
            label: "Today",
            comparisonLabel: "yesterday",
            entries: entries(start: today, end: today),
            comparisonEntries: entries(start: yesterday, end: yesterday)
        )
    case .sevenDays:
        let start = calendar.date(byAdding: .day, value: -6, to: today) ?? today
        let priorEnd = calendar.date(byAdding: .day, value: -7, to: today) ?? today
        let priorStart = calendar.date(byAdding: .day, value: -13, to: today) ?? priorEnd
        return PeriodHistoryWindow(
            label: "Last 7 days",
            comparisonLabel: "prior 7d",
            entries: entries(start: start, end: today),
            comparisonEntries: entries(start: priorStart, end: priorEnd)
        )
    case .thirtyDays:
        let start = calendar.date(byAdding: .day, value: -29, to: today) ?? today
        let priorEnd = calendar.date(byAdding: .day, value: -30, to: today) ?? today
        let priorStart = calendar.date(byAdding: .day, value: -59, to: today) ?? priorEnd
        return PeriodHistoryWindow(
            label: "Last 30 days",
            comparisonLabel: "prior 30d",
            entries: entries(start: start, end: today),
            comparisonEntries: entries(start: priorStart, end: priorEnd)
        )
    case .month:
        let comps = calendar.dateComponents([.year, .month, .day], from: today)
        let start = calendar.date(from: DateComponents(year: comps.year, month: comps.month, day: 1)) ?? today
        let elapsedDays = max(comps.day ?? 1, 1)
        let priorEnd = calendar.date(byAdding: .day, value: -1, to: start) ?? start
        let priorStart = calendar.date(byAdding: .day, value: -(elapsedDays - 1), to: priorEnd) ?? priorEnd
        return PeriodHistoryWindow(
            label: "Month to date",
            comparisonLabel: "prior MTD",
            entries: entries(start: start, end: today),
            comparisonEntries: entries(start: priorStart, end: priorEnd)
        )
    case .all:
        let start = history.compactMap { formatter.date(from: $0.date) }.min() ?? today
        return PeriodHistoryWindow(
            label: "All time",
            comparisonLabel: nil,
            entries: entries(start: start, end: today),
            comparisonEntries: []
        )
    }
}

func periodMetricLabel(_ noun: String, for period: Period) -> String {
    switch period {
    case .today:
        return "\(noun) today"
    case .sevenDays:
        return "\(noun) 7d"
    case .thirtyDays:
        return "\(noun) 30d"
    case .month:
        return "\(noun) MTD"
    case .all:
        return "\(noun) tracked"
    }
}

func selectedProjectSpendValue(_ project: ProjectSpendEntry, period: Period) -> Double {
    switch period {
    case .today:
        return project.cost24h
    case .sevenDays:
        return project.cost7d
    case .thirtyDays:
        return project.cost30d
    case .month, .all:
        return project.selectedPeriodCost > 0 ? project.selectedPeriodCost : project.cost30d
    }
}

func selectedAgentSpendValue(_ agent: AgentStat, period: Period) -> Double {
    switch period {
    case .today:
        return agent.cost24h
    case .sevenDays:
        return agent.cost7d
    case .thirtyDays, .month, .all:
        return agent.cost30d
    }
}

func periodHistoryFormatter() -> DateFormatter {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.timeZone = .current
    return formatter
}

private func emptyHistoryEntry(date: String) -> DailyHistoryEntry {
    DailyHistoryEntry(
        date: date,
        cost: 0,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        topModels: []
    )
}
