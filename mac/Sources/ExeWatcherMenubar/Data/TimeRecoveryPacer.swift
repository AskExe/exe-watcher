import Foundation

/// Continue known queued work, then go idle. No polling when nothing can advance.
struct TimeRecoveryPacer {
    private var stalledToken: String?
    private var unchangedSteps = 0
    private(set) var delay: TimeInterval = 2

    mutating func begin(_ progress: TimeRecoveryProgress) -> Bool {
        guard progress.runnableFiles > 0, progress.token != stalledToken else { return false }
        unchangedSteps = 0
        delay = 2
        return true
    }

    mutating func completed(previous: String, progress: TimeRecoveryProgress, elapsed: TimeInterval) -> Bool {
        // At most ~10% duty cycle, including CLI startup/formatting, with one child globally.
        delay = max(2, max(0, elapsed) * 9)
        guard progress.runnableFiles > 0 else { return false }
        unchangedSteps = previous == progress.token ? unchangedSteps + 1 : 0
        if unchangedSteps >= 2 { pause(progress.token); return false }
        return true
    }

    mutating func pause(_ token: String) { stalledToken = token }
    mutating func reset() { self = TimeRecoveryPacer() }
}
