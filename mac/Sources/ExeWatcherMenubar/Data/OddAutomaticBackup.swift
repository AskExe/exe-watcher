import Foundation

/// Only operates after explicit backup enrollment. No session reads or requests when rollout/consent is off.
@MainActor
final class OddAutomaticBackup {
    private var task: Task<Void, Never>?
    func start() {
        guard task == nil else { return }
        task = Task {
            try? await Task.sleep(for: .seconds(60))
            while !Task.isCancelled {
                // The CLI serializes account operations and enforces the six-hour interval.
                _ = try? await OddAccountClient.run(.init(action: "autoBackup"))
                do { try await Task.sleep(for: .seconds(6 * 60 * 60)) }
                catch { break }
            }
        }
    }
    func stop() { task?.cancel(); task = nil }
    deinit { task?.cancel() }
}
