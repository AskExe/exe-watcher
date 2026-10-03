import Foundation
import Testing
@testable import ExeWatcherMenubar

private func sampleDay(
    _ date: String,
    cost: Double,
    inputTokens: Int = 0,
    outputTokens: Int = 0
) -> DailyHistoryEntry {
    DailyHistoryEntry(
        date: date,
        cost: cost,
        calls: Int(cost),
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        topModels: []
    )
}

@Suite("Period windowing")
struct PeriodWindowingTests {
    private let now = ISO8601DateFormatter().date(from: "2026-05-06T12:00:00Z")!

    @Test("fills missing days inside the selected 7-day window")
    func sevenDayWindowBackfillsZeros() {
        let history = [
            sampleDay("2026-05-01", cost: 10),
            sampleDay("2026-05-06", cost: 4),
        ]

        let window = makePeriodHistoryWindow(period: .sevenDays, history: history, now: now)

        #expect(window.label == "Last 7 days")
        #expect(window.comparisonLabel == "prior 7d")
        #expect(window.entries.count == 7)
        #expect(window.entries.first?.date == "2026-04-30")
        #expect(window.entries.last?.date == "2026-05-06")
        #expect(window.entries.first(where: { $0.date == "2026-05-02" })?.cost == 0)
        #expect(window.entries.first(where: { $0.date == "2026-05-06" })?.cost == 4)
    }

    @Test("month window uses month-to-date day count")
    func monthWindowUsesMonthToDate() {
        let history = [
            sampleDay("2026-05-01", cost: 10),
            sampleDay("2026-05-06", cost: 4),
        ]

        let window = makePeriodHistoryWindow(period: .month, history: history, now: now)

        #expect(window.label == "Month to date")
        #expect(window.comparisonLabel == "prior MTD")
        #expect(window.entries.count == 6)
        #expect(window.entries.first?.date == "2026-05-01")
        #expect(window.entries.last?.date == "2026-05-06")
    }

    @Test("all window includes history older than one year")
    func allWindowUsesFullHistory() {
        let window = makePeriodHistoryWindow(period: .all, history: [sampleDay("2025-01-01", cost: 2), sampleDay("2026-05-06", cost: 4)], now: now)

        #expect(window.label == "All time")
        #expect(window.comparisonLabel == nil)
        #expect(window.entries.count == 491)
        #expect(window.entries.last?.date == "2026-05-06")
        #expect(window.entries.last?.cost == 4)
    }

    @Test("all-time trend bars are bucketed so the chart remains visible")
    func allTimeTrendBarsBucketForRendering() {
        let days = (0..<365).map { offset in
            sampleDay(
                String(format: "2026-01-%02d", (offset % 28) + 1),
                cost: Double(offset + 1),
                inputTokens: offset + 1,
                outputTokens: offset + 1
            )
        }
        let bars = days.map { day in
            TrendBar(
                date: day.date,
                cost: day.cost,
                inputTokens: Double(day.inputTokens),
                outputTokens: Double(day.outputTokens),
                isToday: false,
                topModels: []
            )
        }

        let renderable = buildRenderableTrendBars(bars, maxBars: 90)

        #expect(renderable.count <= 90)
        #expect(renderable.reduce(0.0) { $0 + $1.cost } == bars.reduce(0.0) { $0 + $1.cost })
        #expect(renderable.reduce(0.0) { $0 + $1.tokens } == bars.reduce(0.0) { $0 + $1.tokens })
        #expect(renderable.contains { $0.tokens > 0 })
    }

    @Test("period metric labels stay aligned with the selected period")
    func periodMetricLabels() {
        #expect(periodMetricLabel("Sessions", for: .today) == "Sessions today")
        #expect(periodMetricLabel("Calls", for: .sevenDays) == "Calls 7d")
        #expect(periodMetricLabel("Calls", for: .thirtyDays) == "Calls 30d")
        #expect(periodMetricLabel("Sessions", for: .month) == "Sessions MTD")
        #expect(periodMetricLabel("Calls", for: .all) == "Calls tracked")
    }
}
