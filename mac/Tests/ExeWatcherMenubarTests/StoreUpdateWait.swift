import Foundation

/// Tab switches deliberately return before their background refresh completes.
/// Wait for the observable result instead of assuming a loaded CI runner finishes in 50 ms.
/// The original test assertions still fail if the result never arrives.
@MainActor
func waitForStoreUpdate(_ ready: () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while !ready(), ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(10))
    }
}
