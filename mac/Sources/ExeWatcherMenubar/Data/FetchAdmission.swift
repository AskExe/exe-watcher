import Foundation

/// A permit is held until the underlying work has exited, including cancellation/reaping.
/// Queues are bounded; cancelled waiters never launch work later.
actor FetchAdmission {
    static let processes = FetchAdmission(limit: 2)
    private let limit: Int
    private var active = 0
    private var waiters: [(UUID, CheckedContinuation<Void, Error>)] = []
    init(limit: Int) { self.limit = limit }

    func acquire() async throws {
        try Task.checkCancellation()
        if active < limit { active += 1; return }
        guard waiters.count < 32 else { throw CancellationError() }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiters.append((id, continuation))
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
        if Task.isCancelled { release(); throw CancellationError() }
    }

    func release() {
        if waiters.isEmpty { active -= 1 }
        else { waiters.removeFirst().1.resume() }
    }

    private func cancel(_ id: UUID) {
        guard let index = waiters.firstIndex(where: { $0.0 == id }) else { return }
        waiters.remove(at: index).1.resume(throwing: CancellationError())
    }
}
