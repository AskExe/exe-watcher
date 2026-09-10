import Foundation
import Testing
@testable import ExeWatcherMenubar

/// Behaviour tests for the FSEvents refresh coalescer. These pin the fix for the
/// "back-to-back 7s full refreshes under sustained agent write load" defect: the old throttle
/// stamped its cooldown at refresh START (5s window < ~7s refresh, no in-flight guard) and so
/// fired continuously. The coalescer measures the cooldown from COMPLETION and never starts a
/// refresh while one is in flight.
private let base = Date(timeIntervalSince1970: 1_700_000_000)

@Test
func burstCoalescesToOneRefresh() {
    // Cooldown already clear so only the batch window gates the first fire.
    let c = RefreshCoalescer(startClock: base.addingTimeInterval(-1000))

    // A tight burst: 50 events at the same instant.
    for _ in 0..<50 { c.noteEvent(now: base) }

    // Before the batch delay elapses, we wait — not fire.
    #expect(c.evaluate(now: base) == .wait(until: base.addingTimeInterval(2)))

    // After the 2s batch window, exactly ONE fire.
    #expect(c.evaluate(now: base.addingTimeInterval(2)) == .fireNow)

    // The machine is now in flight — further evaluation is idle (the 49 other events did
    // NOT each schedule their own refresh).
    #expect(c.evaluate(now: base.addingTimeInterval(2)) == .idle)
}

@Test
func inFlightGuardBlocksConcurrentRefresh() {
    let c = RefreshCoalescer(startClock: base.addingTimeInterval(-1000))
    c.noteEvent(now: base)
    #expect(c.evaluate(now: base.addingTimeInterval(2)) == .fireNow)
    #expect(c.isRefreshing)

    // New events arrive while the refresh is running. No matter how much later we evaluate,
    // the in-flight guard keeps it idle — a second refresh cannot start concurrently.
    c.noteEvent(now: base.addingTimeInterval(3))
    #expect(c.evaluate(now: base.addingTimeInterval(1000)) == .idle)

    // Once the refresh finishes, the pending event can fire again (respecting cooldown).
    let finishedAt = base.addingTimeInterval(9)
    c.refreshDidFinish(now: finishedAt)
    #expect(!c.isRefreshing)
    #expect(c.hasPending)
    // Default minInterval is 15s measured from completion.
    #expect(c.evaluate(now: finishedAt.addingTimeInterval(15)) == .fireNow)
}

@Test
func cooldownMeasuredFromCompletion() {
    let cfg = RefreshCoalescer.Config(minIntervalSeconds: 15, batchDelaySeconds: 2)
    let c = RefreshCoalescer(config: cfg, startClock: base.addingTimeInterval(-1000))

    // First refresh fires and completes at T.
    c.noteEvent(now: base)
    #expect(c.evaluate(now: base.addingTimeInterval(2)) == .fireNow)
    let t = base.addingTimeInterval(9)
    c.refreshDidFinish(now: t)

    // An event arrives right after completion.
    c.noteEvent(now: t)
    // Batch window (2s) has elapsed but the cooldown (15s from COMPLETION) has NOT — wait.
    // This is the core fix: the previous throttle measured from start and would have fired here.
    #expect(c.evaluate(now: t.addingTimeInterval(2)) == .wait(until: t.addingTimeInterval(15)))
    // At completion + 15s the next refresh may start.
    #expect(c.evaluate(now: t.addingTimeInterval(15)) == .fireNow)
}

/// THE REGRESSION TEST. Under sustained streaming (an event every second for 120s) with each
/// refresh taking 7s, the OLD throttle produced ~17 back-to-back refreshes (one per ~7s). The
/// coalescer caps this: the next start is prevFinish (= prevStart + 7) + 15 = prevStart + 22s,
/// so at most ~5-6 refreshes across 120s and NEVER back-to-back.
@Test
func sustainedLoadIsRateCappedNotBackToBack() {
    let refreshDuration: TimeInterval = 7
    let cfg = RefreshCoalescer.Config(minIntervalSeconds: 15, batchDelaySeconds: 2)
    // Start with cooldown already clear so the first fire is only gated by the batch window.
    let c = RefreshCoalescer(config: cfg, startClock: base.addingTimeInterval(-1000))

    let horizon = base.addingTimeInterval(120)
    var clock = base
    var starts: [Date] = []
    var iterations = 0

    while clock <= horizon {
        iterations += 1
        #expect(iterations < 10_000, "timeline loop must terminate")

        // Sustained streaming: an event on every tick.
        c.noteEvent(now: clock)

        switch c.evaluate(now: clock) {
        case .fireNow:
            starts.append(clock)
            // Simulate the 7s refresh running to completion, then report completion.
            clock = clock.addingTimeInterval(refreshDuration)
            c.refreshDidFinish(now: clock)
        case .wait(let deadline):
            // Jump to the deadline (but keep ticking at least 1s so the loop always advances).
            let next = max(deadline, clock.addingTimeInterval(1))
            clock = next
        case .idle:
            clock = clock.addingTimeInterval(1)
        }
    }

    // (a) No back-to-back: every consecutive start is >= minInterval + refreshDuration apart.
    let minGap = cfg.minIntervalSeconds + refreshDuration // 22s
    for i in 1..<starts.count {
        let gap = starts[i].timeIntervalSince(starts[i - 1])
        #expect(gap >= minGap - 0.001,
                "consecutive refresh starts \(gap)s apart — must be >= \(minGap)s (no back-to-back)")
    }

    // (b) Rate cap: far fewer than the back-to-back count (120/7 ≈ 17). Expect ~5-6.
    #expect(starts.count <= 7, "expected <= 7 refreshes over 120s, got \(starts.count)")
    #expect(starts.count >= 4, "expected the timer to still fire periodically, got \(starts.count)")
    #expect(starts.count < 17, "must be strictly fewer than the back-to-back count")
}

@Test
func timerAndFilesystemEventsShareThirtySecondCompletionBudget() {
    let c = RefreshCoalescer(config: .init(minIntervalSeconds: 30), startClock: base.addingTimeInterval(-1000))
    var finish: Date?
    var starts: [Date] = []
    // A timer every 30 seconds plus continuous filesystem activity. Include a slow
    // 40-second refresh to prove timers cannot overlap it or bypass its cooldown.
    for second in 0...180 {
        let now = base.addingTimeInterval(Double(second))
        if let end = finish, now >= end {
            c.refreshDidFinish(now: now)
            finish = nil
        }
        c.noteEvent(now: now)
        if second % 30 == 0 { c.noteEvent(now: now) }
        if c.evaluate(now: now) == .fireNow {
            #expect(finish == nil)
            starts.append(now)
            finish = now.addingTimeInterval(40)
        }
    }
    #expect(starts.count == 3)
    for i in 1..<starts.count {
        #expect(starts[i].timeIntervalSince(starts[i - 1]) >= 70)
    }
}
