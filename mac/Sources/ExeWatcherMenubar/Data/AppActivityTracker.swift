import AppKit
import CoreGraphics

struct ActivityTarget: Equatable, Sendable {
    let provider: String
    var contextual = false
}

struct ActivityAvailability {
    static let locked = Notification.Name("com.apple.screenIsLocked")
    static let unlocked = Notification.Name("com.apple.screenIsUnlocked")
    private var sleeping = false, screenSleeping = false, sessionInactive = false, screenLocked = false
    var suspended: Bool { sleeping || screenSleeping || sessionInactive || screenLocked }

    mutating func receive(_ name: Notification.Name) {
        switch name {
        case NSWorkspace.willSleepNotification: sleeping = true
        case NSWorkspace.didWakeNotification: sleeping = false
        case NSWorkspace.screensDidSleepNotification: screenSleeping = true
        case NSWorkspace.screensDidWakeNotification: screenSleeping = false
        case NSWorkspace.sessionDidResignActiveNotification: sessionInactive = true
        case NSWorkspace.sessionDidBecomeActiveNotification: sessionInactive = false
        case Self.locked: screenLocked = true
        case Self.unlocked: screenLocked = false
        default: break
        }
    }
}

/// Public foreground/idle metadata only. No event taps, accessibility access,
/// window titles, keyboard contents, browser inspection, or child processes.
@MainActor
final class AppActivityTracker {
    private let ledger: PersonalActivityStore
    private let recentTurns: () -> [String: Double]
    private var observers: [NSObjectProtocol] = []
    private var distributedObservers: [NSObjectProtocol] = []
    private var timer: Timer?
    private var lastSample: Date?
    private var lastInput: Date?
    private var target: ActivityTarget?
    private var availability = ActivityAvailability()
    private var suspended: Bool { availability.suspended }
    private var bundleID: String?
    static let idleSeconds: TimeInterval = 120

    init(ledger: PersonalActivityStore, recentTurns: @escaping () -> [String: Double]) {
        self.ledger = ledger
        self.recentTurns = recentTurns
    }

    static func target(bundleID: String?, recentTurns: [String: Double], now: Date) -> ActivityTarget? {
        guard let bundleID else { return nil }
        switch bundleID {
        case "com.openai.codex", "community.odd.hansel": return ActivityTarget(provider: "codex")
        case "com.anthropic.claudefordesktop": return ActivityTarget(provider: "claude")
        case "com.openai.chat": return ActivityTarget(provider: "chatgpt")
        default: break
        }
        let editors: [String: Set<String>] = [
            "com.todesktop.230313mzl4w4u92": ["cursor", "cursor-agent"],
            "com.exafunction.windsurf": ["windsurf"],
            "com.microsoft.VSCode": ["copilot", "claude", "codex", "opencode", "kimi", "pi", "omp"],
            "com.microsoft.VSCodeInsiders": ["copilot", "claude", "codex", "opencode", "kimi", "pi", "omp"]
        ]
        let terminals: Set<String> = ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable",
            "com.mitchellh.ghostty", "net.kovidgoyal.kitty", "com.github.wez.wezterm"]
        let allowed = editors[bundleID] ?? (terminals.contains(bundleID) ? Set(["claude", "codex", "cursor-agent", "copilot", "opencode", "kimi", "pi", "omp"]) : [])
        let nowMs = now.timeIntervalSince1970 * 1000
        guard let latest = recentTurns.filter({ allowed.contains($0.key) && $0.value <= nowMs && nowMs - $0.value <= 5 * 60_000 })
            .max(by: { $0.value < $1.value }) else { return nil }
        return ActivityTarget(provider: latest.key, contextual: true)
    }

    /// Sampling late never fills sleep, lock or overloaded-process gaps. When
    /// input resumes after idle, only the observed tail is counted.
    static func activeIntervals(previous: Date, previousInput: Date, now: Date, input: Date) -> [DateInterval] {
        guard now > previous, now.timeIntervalSince(previous) <= 60, input <= now, previousInput <= previous else { return [] }
        var rows: [DateInterval] = []
        let end = min(now, previousInput.addingTimeInterval(idleSeconds))
        if end > previous { rows.append(DateInterval(start: previous, end: end)) }
        if input > previous {
            if let first = rows.first, first.end >= input { return [DateInterval(start: first.start, end: now)] }
            rows.append(DateInterval(start: input, end: now))
        }
        return rows
    }

    func start() {
        guard observers.isEmpty else { return }
        ledger.startRecording()
        ledger.onEnabledChange = { [weak self] in self?.reset() }
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.changeApplication() }
        })
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification,
                     NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.availabilityChanged(name) }
            })
        }
        // Screen lock is distinct from Fast User Switching. These content-free
        // distributed events are also used by Hammerspoon's caffeinate watcher.
        for name in [ActivityAvailability.locked, ActivityAvailability.unlocked] {
            distributedObservers.append(DistributedNotificationCenter.default().addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.availabilityChanged(name) }
            })
        }
        reset()
    }

    func contextDidChange() {
        guard !suspended else { return }
        let fresh = Self.target(bundleID: bundleID, recentTurns: recentTurns(), now: Date())
        if fresh != target { sample(); reset() }
    }

    private func changeApplication() {
        sample(checkFrontmost: false)
        ledger.flush()
        reset()
    }

    private func reset() {
        timer?.invalidate(); timer = nil
        lastSample = nil; lastInput = nil; target = nil
        guard !suspended, ledger.canRecord else { return }
        bundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        target = Self.target(bundleID: bundleID, recentTurns: recentTurns(), now: Date())
        // Editors can become relevant after a usage notification. No idle timer
        // runs at all while an unrelated app is frontmost.
        guard target != nil else { return }
        sample()
        let timer = Timer(timeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sample() }
        }
        timer.tolerance = 10
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func sample(checkFrontmost: Bool = true) {
        guard !suspended, ledger.canRecord, let target else { return }
        if checkFrontmost && NSWorkspace.shared.frontmostApplication?.bundleIdentifier != bundleID {
            // Recover a missed activation notification without counting a
            // background AI app as foreground activity.
            reset()
            return
        }
        let now = Date()
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
        guard idle.isFinite, idle >= 0 else { lastSample = nil; lastInput = nil; return }
        let input = now.addingTimeInterval(-idle)
        if let previous = lastSample, let previousInput = lastInput {
            for row in Self.activeIntervals(previous: previous, previousInput: previousInput, now: now, input: input) {
                ledger.record(start: row.start, end: row.end, provider: target.provider, contextual: target.contextual, now: now)
            }
        }
        lastSample = now; lastInput = input
        if target.contextual && Self.target(bundleID: bundleID, recentTurns: recentTurns(), now: now) != target { reset() }
    }

    private func availabilityChanged(_ notification: Notification.Name) {
        sample()
        availability.receive(notification)
        guard suspended else { reset(); return }
        timer?.invalidate(); timer = nil
        lastSample = nil; lastInput = nil
        ledger.flush()
    }

    func stop() {
        sample()
        timer?.invalidate(); timer = nil
        for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        for observer in distributedObservers { DistributedNotificationCenter.default().removeObserver(observer) }
        observers = []
        distributedObservers = []
        ledger.onEnabledChange = nil
        ledger.stop()
    }
}
