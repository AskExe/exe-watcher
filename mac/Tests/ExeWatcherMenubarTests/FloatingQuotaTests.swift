import AppKit
import Foundation
import Testing
@testable import ExeWatcherMenubar

private let quotaNow = Date(timeIntervalSince1970: 1_800_000_000)
private func quotaUsage(fiveHour: Double? = 64, weekly: Double? = 38, fetchedAt: Date = quotaNow, reset: Date? = quotaNow.addingTimeInterval(3600)) -> SubscriptionUsage {
    SubscriptionUsage(tier: .max20x, rawTier: nil, fiveHourPercent: fiveHour, fiveHourResetsAt: reset,
        sevenDayPercent: weekly, sevenDayResetsAt: quotaNow.addingTimeInterval(86400),
        sevenDayOpusPercent: nil, sevenDayOpusResetsAt: nil,
        sevenDaySonnetPercent: nil, sevenDaySonnetResetsAt: nil, fetchedAt: fetchedAt)
}

@Suite("Floating quota presentation and placement")
struct FloatingQuotaTests {
    @Test("missing and invalid readings never masquerade as zero or a different window")
    func unknownData() {
        let missing = FloatingQuota(usage: nil, state: .noCredentials)
        #expect(missing.windows.isEmpty)
        #expect(missing.primary(.fiveHour) == nil)
        #expect(missing.status(at: quotaNow) == "Connect")
        let invalid = FloatingQuota(usage: quotaUsage(fiveHour: .nan), state: .loaded)
        #expect(invalid.primary(.fiveHour) == nil)
        #expect(invalid.primary(.weekly)?.id == "weekly")
        #expect(invalid.windows.count == 1)
        let zero = FloatingQuota(usage: quotaUsage(fiveHour: 0), state: .loaded)
        #expect(zero.primary(.fiveHour)?.percent == 0)
        #expect(zero.primary(.fiveHour)?.remainingPercent == 100)
    }

    @Test("Claude and Codex show remaining quota for the selected window")
    func remainingCapacity() {
        let claude = FloatingQuota(usage: quotaUsage(fiveHour: 0, weekly: 80), state: .loaded)
        let codex = FloatingQuota(provider: .codex, state: .init(snapshot: .init(provider: .codex,
            windows: [.init(id: "weekly", label: "Weekly", percent: 68, resetsAt: quotaNow.addingTimeInterval(86400))],
            fetchedAt: quotaNow), loadState: .loaded))
        #expect(claude.primary(.weekly)?.remainingPercent == 20)
        #expect(claude.primary(.fiveHour)?.remainingPercent == 100)
        #expect(codex.primary(.weekly)?.remainingPercent == 32)
        #expect(codex.primary(.weekly)?.remainingFraction == 0.32)
        #expect(codex.primary(.fiveHour) == nil)
        let exhausted = FloatingQuota(usage: quotaUsage(weekly: 100), state: .loaded)
        #expect(exhausted.primary(.weekly)?.remainingPercent == 0)
    }

    @Test("providers with other quota periods retain their reported window")
    func otherProviderWindows() {
        let cursor = FloatingQuota(provider: .cursor, state: .init(snapshot: .init(provider: .cursor,
            windows: [.init(id: "monthly", label: "Monthly", percent: 74, resetsAt: nil)],
            fetchedAt: quotaNow), loadState: .loaded))
        #expect(cursor.primary(.weekly)?.id == "monthly")
        #expect(cursor.primary(.fiveHour)?.remainingPercent == 26)
    }

    @Test("staleness, clock skew and expired cycles are explicit")
    func freshness() {
        let old = FloatingQuota(usage: quotaUsage(fetchedAt: quotaNow.addingTimeInterval(-601)), state: .loaded)
        #expect(old.isStale(at: quotaNow))
        let failed = FloatingQuota(usage: quotaUsage(), state: .failed)
        #expect(failed.isStale(at: quotaNow))
        let future = FloatingQuota(usage: quotaUsage(fetchedAt: quotaNow.addingTimeInterval(120)), state: .loaded)
        #expect(future.isStale(at: quotaNow))
        let expired = FloatingQuota(usage: quotaUsage(reset: quotaNow.addingTimeInterval(-1)), state: .loaded)
        #expect(expired.primary(.fiveHour)?.expired(at: quotaNow) == true)
        #expect(expired.status(at: quotaNow) == "Reset pending")
        #expect(FloatingQuota.resetText(nil, now: quotaNow) == "Reset time unavailable")
        #expect(FloatingQuota.resetText(quotaNow, now: quotaNow) == "Waiting for reset update")
    }

    @Test("all edge orientations stay visible on offset and reduced-size displays")
    func allEdges() {
        for screen in [CGRect(x: -1440, y: 250, width: 1440, height: 850), CGRect(x: 0, y: 0, width: 380, height: 400)] {
            for edge in FloatingQuotaEdge.allCases {
                let position = FloatingQuotaPosition(edge: edge, x: 0.8, y: 0.9)
                let rail = FloatingQuotaPlacement.railFrame(position: position, screen: screen)
                #expect(screen.contains(rail))
                #expect((rail.width > rail.height) == edge.horizontal)
                let detail = FloatingQuotaPlacement.detailFrame(rail: rail, size: CGSize(width: 310, height: 350), screen: screen, edge: edge)
                #expect(screen.contains(detail))
            }
        }
    }

    @Test("dragging away detaches; snapping and restored placement use normalized coordinates")
    func dragAndRestore() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let free = FloatingQuotaPlacement.position(afterDropping: CGRect(x: 500, y: 300, width: 82, height: 126), screen: screen, screenID: "display")
        #expect(free.edge == nil)
        #expect(free.screenID == "display")
        let top = FloatingQuotaPlacement.position(afterDropping: CGRect(x: 500, y: 900 - 126 - 10, width: 82, height: 126), screen: screen, screenID: "display")
        #expect(top.edge == .top)
        #expect(top.horizontal)
        let smaller = CGRect(x: -800, y: 0, width: 800, height: 600)
        #expect(smaller.contains(FloatingQuotaPlacement.railFrame(position: free, screen: smaller)))
    }

    @Test("preferences are opt-in and survive relaunch; malformed positions are discarded")
    @MainActor func persistedPreferences() throws {
        let name = "watcher.quota.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = FloatingQuotaPreferences(defaults: defaults)
        #expect(!preferences.isEnabled)
        #expect(preferences.horizon == .weekly)
        #expect(preferences.timePeriod == .today)
        preferences.isEnabled = true
        preferences.horizon = .fiveHour
        preferences.timePeriod = .month
        preferences.position = FloatingQuotaPosition(edge: nil, x: 0.4, y: 0.6, screenID: "test")
        let restored = FloatingQuotaPreferences(defaults: defaults)
        #expect(restored.isEnabled)
        #expect(restored.horizon == .fiveHour)
        #expect(restored.timePeriod == .month)
        #expect(restored.position == preferences.position)
        defaults.set(Data("{\"x\":null}".utf8), forKey: "exe-watcher.floatingQuota.position")
        #expect(FloatingQuotaPreferences(defaults: defaults).position == FloatingQuotaPosition())
    }

    @Test("panels do not take keyboard focus or cover system notification levels")
    @MainActor func panelContract() {
        let panel = FloatingQuotaPanel()
        defer { panel.close() }
        #expect(!panel.canBecomeKey)
        #expect(!panel.canBecomeMain)
        #expect(panel.level == .floating)
        #expect(panel.collectionBehavior.contains(.fullScreenAuxiliary))
        #expect(panel.collectionBehavior.contains(.canJoinAllSpaces))
    }
}

private actor QuotaFetchGate {
    var prompts: [Bool] = []
    var continuation: CheckedContinuation<SubscriptionUsage, Error>?
    func fetch(_ prompt: Bool) async throws -> SubscriptionUsage {
        prompts.append(prompt)
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func resolve(_ result: Result<SubscriptionUsage, Error>) { continuation?.resume(with: result); continuation = nil }
}
private final class QuotaClock: @unchecked Sendable {
    var now = quotaNow
}

@Suite("Shared subscription refresh admission")
struct FloatingQuotaRefreshTests {
    @Test("dock and Plan share one request; passive reads cannot ask for credentials")
    @MainActor func coalescesAndStaysPassive() async throws {
        let gate = QuotaFetchGate()
        let store = AppStore(now: { quotaNow }, fetchSubscription: { try await gate.fetch($0) }, persistSubscriptionSnapshots: false)
        let passive = Task { await store.refreshSubscription(allowKeychainPrompt: false) }
        while await gate.prompts.isEmpty { await Task.yield() }
        let plan = Task { await store.refreshSubscription() }
        await Task.yield()
        await gate.resolve(.success(quotaUsage()))
        await passive.value
        await plan.value
        #expect(await gate.prompts == [false])
        #expect(store.subscription?.fiveHourPercent == 64)
        #expect(store.subscriptionLoadState == .loaded)
        await store.refreshSubscription(allowKeychainPrompt: false)
        #expect(await gate.prompts.count == 1)
    }

    @Test("429 preserves the last reading and backs off even for explicit retries")
    @MainActor func rateLimitBackoff() async throws {
        let gate = QuotaFetchGate()
        let clock = QuotaClock()
        let store = AppStore(now: { clock.now }, fetchSubscription: { try await gate.fetch($0) }, persistSubscriptionSnapshots: false)
        store.subscription = quotaUsage()
        let request = Task { await store.refreshSubscription(allowKeychainPrompt: false) }
        while await gate.prompts.isEmpty { await Task.yield() }
        await gate.resolve(.failure(SubscriptionError.usageFetchFailed(429, nil)))
        await request.value
        #expect(store.subscription?.fiveHourPercent == 64)
        #expect(store.subscriptionLoadState == .failed)
        clock.now = quotaNow.addingTimeInterval(5 * 60)
        await store.refreshSubscription()
        #expect(await gate.prompts.count == 1)
        #expect(store.subscriptionNextRefreshAt == quotaNow.addingTimeInterval(15 * 60))
    }

    @Test("rejected credentials clear the prior account's quota")
    @MainActor func authenticationFailure() async throws {
        let store = AppStore(now: { quotaNow }, fetchSubscription: { _ in throw SubscriptionError.usageFetchFailed(401, nil) }, persistSubscriptionSnapshots: false)
        store.subscription = quotaUsage()
        await store.refreshSubscription(allowKeychainPrompt: false)
        #expect(store.subscription == nil)
        #expect(store.subscriptionLoadState == .failed)
    }
}

private actor FloatingTimeReads {
    var providers: [ProviderFilter] = []
    var fail = false
    func fetch(_ provider: ProviderFilter) throws -> TimeRecoverySnapshots {
        providers.append(provider)
        if fail { throw DataClientError.timeout() }
        let block = TimeBlock(indexedAt: "2027-01-15T08:00:00Z", since: "2026-04-24T00:00:00Z",
            through: "2027-01-15T08:00:00Z", aiRunningMs: 9_000_000, elapsedBusyMs: 3_600_000,
            userActiveMs: 1_800_000, estimatedAiMs: 0, coverage: "partial", pendingFiles: 0,
            indexedFiles: 2, firstRecordedAt: nil, lastRecordedAt: nil, providers: [], notes: [])
        return TimeRecoverySnapshots(generated: "2027-01-15T08:00:00Z", provider: "all",
            periods: Dictionary(uniqueKeysWithValues: Period.allCases.map { ($0.cliArg, block) }), allPeriods: nil,
            recovery: TimeRecoveryProgress(runnableFiles: 0, waitingFiles: 0, pendingBytes: 0, token: "done"))
    }
    func setFailure() { fail = true }
}

@Suite("Floating time across all agents")
struct FloatingTimeTests {
    @Test("timing loads without financial caches and stays independent of the main selection")
    @MainActor func independentTime() async throws {
        let reads = FloatingTimeReads()
        let clock = QuotaClock()
        let store = AppStore(now: { clock.now }, fetchTimeSnapshots: { try await reads.fetch($0) }, persistSubscriptionSnapshots: false)
        store.selectedProvider = .claude
        store.selectedPeriod = .thirtyDays
        await store.loadFloatingTimeIfNeeded(for: .today)
        #expect(await reads.providers == [.all])
        #expect(store.floatingTime(for: .today)?.userActiveMs == 1_800_000)
        #expect(store.floatingTime(for: .all)?.aiRunningMs == 9_000_000)
        #expect(store.selectedProvider == .claude && store.selectedPeriod == .thirtyDays)
        await store.loadFloatingTimeIfNeeded(for: .month)
        #expect(await reads.providers.count == 1)
        clock.now = quotaNow.addingTimeInterval(86_400)
        #expect(store.floatingTime(for: .today) == nil)
        #expect(store.floatingTime(for: .all)?.aiRunningMs == 9_000_000)
    }

    @Test("All Time survives relaunch and day rollover without financial history")
    @MainActor func durableAllTime() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let badge = directory.appendingPathComponent("native-badge.json")
        let reads = FloatingTimeReads()
        let clock = QuotaClock()
        let store = AppStore(now: { clock.now }, badgeCacheURL: badge,
            fetchTimeSnapshots: { try await reads.fetch($0) }, persistSubscriptionSnapshots: false)
        await store.loadFloatingTimeIfNeeded(for: .today)
        let restored = AppStore(now: { clock.now }, badgeCacheURL: badge,
            fetchTimeSnapshots: { try await reads.fetch($0) }, persistSubscriptionSnapshots: false)
        #expect(restored.floatingTime(for: .all)?.userActiveMs == 1_800_000)
        #expect(restored.floatingTime(for: .all)?.aiRunningMs == 9_000_000)
        await restored.loadFloatingTimeIfNeeded(for: .all)
        #expect(await reads.providers.count == 1)
        clock.now = quotaNow.addingTimeInterval(86_400)
        let nextDay = AppStore(now: { clock.now }, badgeCacheURL: badge,
            fetchTimeSnapshots: { try await reads.fetch($0) }, persistSubscriptionSnapshots: false)
        #expect(nextDay.floatingTime(for: .today) == nil)
        #expect(nextDay.floatingTime(for: .all)?.aiRunningMs == 9_000_000)
        await nextDay.loadFloatingTimeIfNeeded(for: .today)
        #expect(await reads.providers.count == 2)
        #expect(nextDay.floatingTime(for: .today)?.aiRunningMs == 9_000_000)
    }

    @Test("a Today-only timing cache does not block loading All Time")
    @MainActor func incompleteTimingCache() async throws {
        let reads = FloatingTimeReads()
        let store = AppStore(now: { quotaNow }, fetchTimeSnapshots: { try await reads.fetch($0) }, persistSubscriptionSnapshots: false)
        var snapshots = try await reads.fetch(.all)
        snapshots = TimeRecoverySnapshots(generated: snapshots.generated, provider: snapshots.provider,
            periods: ["today": try #require(snapshots.periods["today"])], allPeriods: nil, recovery: snapshots.recovery)
        let anchor = PayloadCacheKey(period: .today, provider: .all, now: quotaNow).dateAnchor
        store.applyTimeSnapshots(snapshots, dateAnchor: anchor)
        #expect(store.floatingTime(for: .today) != nil)
        #expect(store.floatingTime(for: .all) == nil)
        await store.loadFloatingTimeIfNeeded(for: .today)
        #expect(store.floatingTime(for: .all)?.aiRunningMs == 9_000_000)
    }

    @Test("an offline refresh retains cached real All Time totals")
    @MainActor func staleTotalsSurviveFailure() async {
        let reads = FloatingTimeReads()
        let clock = QuotaClock()
        let store = AppStore(now: { clock.now }, fetchTimeSnapshots: { try await reads.fetch($0) }, persistSubscriptionSnapshots: false)
        await store.loadFloatingTimeIfNeeded(for: .all)
        clock.now = quotaNow.addingTimeInterval(301)
        await reads.setFailure()
        await store.loadFloatingTimeIfNeeded(for: .all)
        #expect(store.floatingTimeError != nil)
        #expect(store.floatingTime(for: .all)?.aiRunningMs == 9_000_000)
        #expect(!store.isLoadingFloatingTime)
    }

    @Test("failed reads back off; unknown time remains unknown")
    @MainActor func failedTimeBackoff() async {
        let reads = FloatingTimeReads()
        await reads.setFailure()
        let clock = QuotaClock()
        let store = AppStore(now: { clock.now }, fetchTimeSnapshots: { try await reads.fetch($0) }, persistSubscriptionSnapshots: false)
        await store.loadFloatingTimeIfNeeded(for: .today)
        await store.loadFloatingTimeIfNeeded(for: .month)
        #expect(await reads.providers.count == 1)
        #expect(store.floatingTime(for: .today) == nil)
        #expect(store.floatingTimeError != nil)
        clock.now = quotaNow.addingTimeInterval(301)
        await store.loadFloatingTimeIfNeeded(for: .today)
        #expect(await reads.providers.count == 2)
    }
}
