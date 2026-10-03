import Foundation

/// Coalesces a stream of filesystem-change events into a bounded sequence of refreshes.
///
/// Replaces the previous "throttle" whose cooldown was stamped when a refresh STARTED,
/// with a window shorter than the refresh itself and no in-flight guard — that produced
/// back-to-back full refreshes under sustained write load. This machine instead:
///   * never starts a refresh while one is in flight (in-flight guard), and
///   * measures the cooldown from refresh COMPLETION, so a busy directory yields at most
///     one refresh per (minInterval + refresh duration) rather than continuous refreshes.
///
/// Pure and clock-injected: `evaluate(now:)` is the only decision point, so behaviour is
/// deterministic and unit-testable without real timers. Not Sendable; intended to be used
/// on a single (main) actor only.
final class RefreshCoalescer {
    struct Config: Equatable {
        /// Minimum quiet gap between one refresh FINISHING and the next STARTING.
        var minIntervalSeconds: TimeInterval
        /// Short delay to batch a burst of events into one refresh (throttle, not debounce:
        /// anchored to the FIRST event of a batch so it cannot be pushed out indefinitely).
        var batchDelaySeconds: TimeInterval
        var scanRestMultiplier: TimeInterval
        var maxEventRetries: Int
        init(minIntervalSeconds: TimeInterval = 15, batchDelaySeconds: TimeInterval = 2, scanRestMultiplier: TimeInterval = 0, maxEventRetries: Int = 0) {
            self.minIntervalSeconds = minIntervalSeconds
            self.batchDelaySeconds = batchDelaySeconds
            self.scanRestMultiplier = max(0, scanRestMultiplier)
            self.maxEventRetries = max(0, maxEventRetries)
        }
    }

    enum Decision: Equatable {
        case idle
        case fireNow
        case wait(until: Date)
    }

    private let config: Config
    private var pendingSince: Date?
    private var refreshing = false
    private var lastFinishedAt: Date
    private var startedAt: Date?
    private var adaptiveInterval: TimeInterval = 0
    private var eventRetries = 0

    init(config: Config = .init(), startClock: Date = .distantPast) {
        self.config = config
        self.lastFinishedAt = startClock
    }

    /// Record filesystem activity. Cheap; call on every FSEvents callback. Anchors the batch
    /// window to the first unserviced event.
    func noteEvent(now: Date) {
        eventRetries = 0
        if pendingSince == nil { pendingSince = now }
    }

    /// Decide what to do at `now`. On `.fireNow` the machine transitions to in-flight and the
    /// caller MUST run the refresh and call `refreshDidFinish` when done. On `.wait(until:)`,
    /// re-invoke `evaluate` at or after the returned deadline. `.idle` means nothing to do
    /// (no pending events, or a refresh is already in flight).
    func evaluate(now: Date) -> Decision {
        if refreshing { return .idle }
        guard let pendingSince else { return .idle }
        let batchReadyAt = pendingSince.addingTimeInterval(config.batchDelaySeconds)
        let cooldownClearedAt = lastFinishedAt.addingTimeInterval(max(config.minIntervalSeconds, adaptiveInterval))
        let readyAt = max(batchReadyAt, cooldownClearedAt)
        if now >= readyAt {
            self.pendingSince = nil
            refreshing = true
            startedAt = now
            return .fireNow
        }
        return .wait(until: readyAt)
    }

    /// Mark the current refresh complete; anchors the cooldown at COMPLETION time.
    func refreshDidFinish(now: Date, success: Bool = true) {
        refreshing = false
        // Automatic scans occupy at most ~10% of elapsed time under sustained
        // writes. A slow scan buys a longer rest instead of immediate retries.
        adaptiveInterval = max(0, now.timeIntervalSince(startedAt ?? now)) * config.scanRestMultiplier
        startedAt = nil
        lastFinishedAt = now
        if success { eventRetries = 0 }
        else if eventRetries < config.maxEventRetries {
            // A notification received during an in-flight scan/backoff must not
            // be lost. Retry that event a bounded number of times, never forever.
            eventRetries += 1
            if pendingSince == nil { pendingSince = now }
        }
    }

    var isRefreshing: Bool { refreshing }
    var hasPending: Bool { pendingSince != nil }
}
