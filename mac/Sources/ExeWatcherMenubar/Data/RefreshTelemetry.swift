import Foundation

// MARK: - Chrome Trace Event Format (Perfetto-compatible)

/// Thread lanes rendered as separate rows in Perfetto/chrome://tracing.
enum TraceThread: Int {
    case refresh = 1
    case cli = 2
    case health = 3
    case fsevents = 4
    case lifecycle = 5
}

/// A single Chrome Trace Event. Directly serializable to the JSON array
/// format that Perfetto and chrome://tracing consume.
struct TraceEvent: Encodable {
    let name: String
    let cat: String
    let ph: String      // B=begin, E=end, X=complete, i=instant, C=counter, M=metadata
    let ts: UInt64       // Microseconds since trace start
    let pid: Int
    let tid: Int
    var dur: UInt64?
    var args: [String: AnyTraceable]?
}

/// Lightweight type-erased wrapper so trace args can hold String/Int/Double/Bool.
enum AnyTraceable: Encodable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)

    init(_ v: String) { self = .string(v) }
    init(_ v: Int) { self = .int(v) }
    init(_ v: Double) { self = .double(v) }
    init(_ v: Bool) { self = .bool(v) }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v): try container.encode(v)
        case .int(let v):    try container.encode(v)
        case .double(let v): try container.encode(v)
        case .bool(let v):   try container.encode(v)
        }
    }
}

// MARK: - RefreshTracer

/// Perfetto-compatible trace writer. Collects Chrome Trace Events in a bounded ring buffer
/// and flushes them to `~/.cache/exe-watcher/traces/trace-current.json` on a coalesced
/// schedule. Adapted from Claude Code's perfettoTracing.ts.
@MainActor
final class RefreshTracer {
    static let shared = RefreshTracer()

    private let maxEvents = 10_000
    private var events: [TraceEvent] = []
    private var metadataEvents: [TraceEvent] = []
    private var pendingSpans: [String: PendingSpan] = [:]
    private var startTimeUs: UInt64 = 0
    private var spanCounter: UInt64 = 0
    private var writeScheduled = false
    private var evictionTimer: DispatchSourceTimer?

    private let traceDir: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".cache/exe-watcher/traces")

    private var traceFile: URL {
        traceDir.appendingPathComponent("trace-current.json")
    }

    private struct PendingSpan {
        let name: String
        let category: String
        let startTs: UInt64
        let tid: Int
        var args: [String: AnyTraceable]
    }

    func initialize() {
        startTimeUs = UInt64(Date().timeIntervalSince1970 * 1_000_000)
        try? FileManager.default.createDirectory(at: traceDir, withIntermediateDirectories: true)

        metadataEvents.append(TraceEvent(
            name: "process_name", cat: "__metadata", ph: "M",
            ts: 0, pid: 1, tid: 0,
            args: ["name": .string("exe-watcher-menubar")]
        ))

        let threadNames: [(Int, String)] = [
            (1, "Refresh"), (2, "CLI"), (3, "Health"), (4, "FSEvents"), (5, "Lifecycle")
        ]
        for (tid, label) in threadNames {
            metadataEvents.append(TraceEvent(
                name: "thread_name", cat: "__metadata", ph: "M",
                ts: 0, pid: 1, tid: tid,
                args: ["name": .string(label)]
            ))
        }

        startEvictionTimer()
    }

    // MARK: - Span API

    /// Begin a span. Returns a span ID to pass to `endSpan()`.
    func beginSpan(
        name: String,
        category: String,
        tid: TraceThread,
        args: [String: AnyTraceable] = [:]
    ) -> String {
        spanCounter += 1
        let spanId = "s_\(spanCounter)"
        let ts = timestamp()

        pendingSpans[spanId] = PendingSpan(
            name: name, category: category, startTs: ts, tid: tid.rawValue, args: args
        )
        pushEvent(TraceEvent(
            name: name, cat: category, ph: "B",
            ts: ts, pid: 1, tid: tid.rawValue,
            args: args.isEmpty ? nil : args
        ))
        return spanId
    }

    /// End a previously started span. Merges additional args (e.g. result, duration).
    func endSpan(_ spanId: String, args: [String: AnyTraceable] = [:]) {
        guard let span = pendingSpans.removeValue(forKey: spanId) else { return }
        let ts = timestamp()
        var merged = span.args
        for (k, v) in args { merged[k] = v }
        let durationMs = Double(ts - span.startTs) / 1000.0
        merged["duration_ms"] = .double(durationMs)
        pushEvent(TraceEvent(
            name: span.name, cat: span.category, ph: "E",
            ts: ts, pid: 1, tid: span.tid,
            args: merged
        ))
    }

    /// Emit a point-in-time event (no duration).
    func instant(
        name: String,
        category: String,
        tid: TraceThread,
        args: [String: AnyTraceable] = [:]
    ) {
        pushEvent(TraceEvent(
            name: name, cat: category, ph: "i",
            ts: timestamp(), pid: 1, tid: tid.rawValue,
            args: args.isEmpty ? nil : args
        ))
    }

    /// Emit counter values — renders as a line chart in Perfetto.
    func counter(name: String, values: [String: Int]) {
        let args = values.mapValues { AnyTraceable.int($0) }
        pushEvent(TraceEvent(
            name: name, cat: "counter", ph: "C",
            ts: timestamp(), pid: 1, tid: TraceThread.health.rawValue,
            args: args
        ))
    }

    // MARK: - Internals

    private func timestamp() -> UInt64 {
        let nowUs = UInt64(Date().timeIntervalSince1970 * 1_000_000)
        return nowUs - startTimeUs
    }

    private func pushEvent(_ event: TraceEvent) {
        events.append(event)
        if events.count >= maxEvents {
            let dropped = events.count / 2
            events.removeFirst(dropped)
            events.insert(TraceEvent(
                name: "trace_truncated", cat: "__metadata", ph: "i",
                ts: events.first?.ts ?? 0, pid: 1, tid: 0,
                args: ["dropped_events": .int(dropped)]
            ), at: 0)
        }
        scheduleWrite()
    }

    // MARK: - Coalesced File Writes

    private func scheduleWrite() {
        guard !writeScheduled else { return }
        writeScheduled = true
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 10) { [weak self] in
            Task { @MainActor in
                self?.writeScheduled = false
                self?.writeToDisk()
            }
        }
    }

    /// Write trace to disk. Called on coalesced schedule and on app termination.
    func writeToDisk() {
        let allEvents = metadataEvents + events
        DispatchQueue.global(qos: .utility).async { [traceFile = self.traceFile] in
            guard let payload = try? JSONEncoder().encode(allEvents) else { return }
            var data = Data("{\"traceEvents\":".utf8)
            data.append(payload)
            data.append(Data("}".utf8))
            try? data.write(to: traceFile, options: .atomic)
        }
    }

    // MARK: - Stale Span Eviction

    private static let spanTTLUs: UInt64 = 5 * 60 * 1_000_000 // 5 minutes

    private func startEvictionTimer() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 60, repeating: 60, leeway: .seconds(5))
        timer.setEventHandler { [weak self] in self?.evictStaleSpans() }
        timer.resume()
        evictionTimer = timer
    }

    private func evictStaleSpans() {
        let now = timestamp()
        for (spanId, span) in pendingSpans where (now - span.startTs) > Self.spanTTLUs {
            pushEvent(TraceEvent(
                name: span.name, cat: span.category, ph: "E",
                ts: now, pid: 1, tid: span.tid,
                args: [
                    "evicted": .bool(true),
                    "duration_ms": .double(Double(now - span.startTs) / 1000.0),
                ]
            ))
            pendingSpans.removeValue(forKey: spanId)
        }
    }
}

// MARK: - Health Monitor

/// Self-healing feedback loop. Checks health every 30s, detects stuck/stale/degraded
/// states, and auto-recovers with a 2-minute cooldown between recovery attempts.
@MainActor
final class HealthMonitor {
    private weak var store: AppStore?
    private var checkTimer: DispatchSourceTimer?
    private(set) var consecutiveFailures: Int = 0
    private var lastHealthState: HealthState = .healthy
    private var lastRecoveryAt: Date = .distantPast
    private var stuckDetectionStart: Date?

    private static let staleThresholdSeconds: TimeInterval = 600
    private static let stuckThresholdSeconds: TimeInterval = 90
    private static let recoveryCooldownSeconds: TimeInterval = 120
    private static let checkIntervalSeconds: Double = 30

    enum HealthState: String {
        case healthy
        case degraded
        case stale
        case stuck
    }

    enum RecoveryAction: String {
        case resetInFlight
        case forceRefresh
    }

    init(store: AppStore) {
        self.store = store
    }

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(
            deadline: .now() + Self.checkIntervalSeconds,
            repeating: Self.checkIntervalSeconds,
            leeway: .seconds(5)
        )
        timer.setEventHandler { [weak self] in self?.performHealthCheck() }
        timer.resume()
        checkTimer = timer
    }

    func stop() {
        checkTimer?.cancel()
        checkTimer = nil
    }

    /// Called by AppStore after each fetch completes.
    func recordFetchResult(success: Bool) {
        if success {
            consecutiveFailures = 0
            stuckDetectionStart = nil
        } else {
            consecutiveFailures += 1
        }

        RefreshTracer.shared.counter(name: "fetch_health", values: [
            "consecutive_failures": consecutiveFailures,
            "active_fetches": store?.activeFetchCount ?? 0,
        ])
    }

    private func performHealthCheck() {
        guard let store else { return }
        let now = Date()
        let state = diagnose(store: store, now: now)

        RefreshTracer.shared.instant(
            name: "health_check", category: "health", tid: .health,
            args: [
                "state": .string(state.rawValue),
                "active_fetches": .int(store.activeFetchCount),
                "consecutive_failures": .int(consecutiveFailures),
                "last_success_age_s": .double(
                    store.lastBadgeRefreshSuccessAt.map { now.timeIntervalSince($0) } ?? -1
                ),
            ]
        )

        if state != lastHealthState {
            watcherLog("HEALTH: \(lastHealthState.rawValue) → \(state.rawValue)")
            RefreshTracer.shared.instant(
                name: "health_transition", category: "health", tid: .health,
                args: [
                    "from": .string(lastHealthState.rawValue),
                    "to": .string(state.rawValue),
                ]
            )
            lastHealthState = state
        }

        // File notifications drive freshness. An idle/old payload must never
        // turn this diagnostics timer into a periodic usage scanner.
        if state == .stuck {
            let cooldownElapsed = now.timeIntervalSince(lastRecoveryAt) > Self.recoveryCooldownSeconds
            if cooldownElapsed {
                selfHeal(state: state, store: store)
            }
        }
    }

    private func diagnose(store: AppStore, now: Date) -> HealthState {
        if store.activeFetchCount > 0 {
            if let start = stuckDetectionStart {
                if now.timeIntervalSince(start) > Self.stuckThresholdSeconds {
                    return .stuck
                }
            } else {
                stuckDetectionStart = now
            }
        } else {
            stuckDetectionStart = nil
        }

        if let lastSuccess = store.lastBadgeRefreshSuccessAt,
           let changed = store.lastUsageChangeAt, changed > lastSuccess {
            if now.timeIntervalSince(changed) > Self.staleThresholdSeconds {
                return .stale
            }
        } else if store.lastBadgeRefreshAttemptAt != nil {
            return .degraded
        }

        if consecutiveFailures >= 3 {
            return .degraded
        }

        return .healthy
    }

    private func selfHeal(state: HealthState, store: AppStore) {
        lastRecoveryAt = Date()

        let action: RecoveryAction
        switch state {
        case .stuck:
            action = .resetInFlight
            store.recoverFromSystemResume()
        case .stale:
            return
        default:
            action = .resetInFlight
            store.recoverFromSystemResume()
        }

        watcherLog("HEALTH: self-heal action=\(action.rawValue) for state=\(state.rawValue)")
        RefreshTracer.shared.instant(
            name: "self_heal", category: "health", tid: .health,
            args: [
                "action": .string(action.rawValue),
                "trigger_state": .string(state.rawValue),
                "consecutive_failures": .int(consecutiveFailures),
            ]
        )
    }
}
