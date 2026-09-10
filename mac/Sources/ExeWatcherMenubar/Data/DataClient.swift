import Foundation
import Darwin

/// Upper bound on payload + stderr bytes read from the CLI. Real payloads top out near 500 KB
/// (365 days of history with dozens of models); anything larger is pathological and truncating
/// prevents unbounded memory growth. Hard timeout guards against a hung CLI keeping Process and
/// Pipe file descriptors pinned forever.
private let maxPayloadBytes = 20 * 1024 * 1024
private let maxStderrBytes = 256 * 1024
private let spawnTimeoutSeconds: UInt64 = 60
/// Badge-only fetches must tolerate large local session corpora. If this is shorter than the
/// real `status --format menubar-json --period today --provider all --no-optimize` runtime, the
/// always-visible badge keeps showing the last cached value and the popover warns "Data may be
/// stale" until the user manually refreshes through the 60s detail path.
private let badgeTimeoutSeconds: UInt64 = spawnTimeoutSeconds

enum DataClientError: Error {
    case spawn(String)
    case nonZeroExit(code: Int32, stderr: String)
    case decode(Error)
    case timeout(seconds: UInt64 = 60)
    case outputTooLarge
    case appTooOld(required: String, current: String)
}

extension DataClientError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case let .spawn(message):
            let cleaned = message.trimmingCharacters(in: .whitespacesAndNewlines)
            if cleaned.localizedCaseInsensitiveContains("no such file or directory") {
                return "Couldn't launch exe-watcher. Reinstall the CLI or set EXE_WATCHER_BIN to a working binary."
            }
            return cleaned.isEmpty ? "Couldn't launch exe-watcher." : cleaned
        case let .nonZeroExit(code, stderr):
            let cleaned = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            if code == 127 || cleaned.localizedCaseInsensitiveContains("exe-watcher: no such file or directory") {
                return "The exe-watcher CLI was not found. Reinstall it (`npm install -g exe-watcher`) or set EXE_WATCHER_BIN."
            }
            if code == 126 {
                return "The exe-watcher CLI exists but isn't executable. Reinstall it or fix its permissions."
            }
            if cleaned.isEmpty {
                return "exe-watcher exited with status \(code)."
            }
            return cleaned
        case .decode:
            return "Watcher couldn't decode the CLI response."
        case let .timeout(seconds):
            return "exe-watcher timed out after \(seconds) seconds. Retry once the machine is idle."
        case .outputTooLarge:
            return "Watcher received an unexpectedly large CLI response and refused to render it."
        case let .appTooOld(required, current):
            return "This app (v\(current)) is too old for the installed CLI. Update to v\(required)+ via the menubar or reinstall."
        }
    }
}

/// Runs the CLI via argv (no shell interpretation). See `ExeWatcherCLI` for why we never route
/// commands through `/bin/zsh -c` anymore.
struct DataClient {
    static func fetch(period: Period, provider: ProviderFilter, includeOptimize: Bool) async throws -> MenubarPayload {
        let timeout = (period == .today && provider == .all && !includeOptimize)
            ? badgeTimeoutSeconds
            : spawnTimeoutSeconds
        let result = try await runCLI(subcommand: subcommand(
            period: period,
            provider: provider,
            includeOptimize: includeOptimize
        ), timeoutSeconds: timeout)
        guard result.exitCode == 0 else {
            throw DataClientError.nonZeroExit(code: result.exitCode, stderr: result.stderr)
        }
        let payload: MenubarPayload
        do {
            payload = try JSONDecoder().decode(MenubarPayload.self, from: result.stdout)
        } catch {
            throw DataClientError.decode(error)
        }

        // Version compatibility gate: if the CLI declares a minimum app version that's
        // newer than ours, surface an actionable error instead of rendering stale/broken data.
        if let minRequired = payload.minAppVersion {
            let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
            let normalizedRequired = minRequired.hasPrefix("v") ? String(minRequired.dropFirst()) : minRequired
            let normalizedCurrent = current.hasPrefix("v") ? String(current.dropFirst()) : current
            if !normalizedCurrent.isEmpty
                && normalizedCurrent != "dev"
                && normalizedRequired.compare(normalizedCurrent, options: .numeric) == .orderedDescending
            {
                throw DataClientError.appTooOld(required: normalizedRequired, current: normalizedCurrent)
            }
        }

        if let diag = payload.diagnostics, !diag.warnings.isEmpty {
            for warning in diag.warnings {
                NSLog("Exe Watcher CLI warning: %@", warning)
            }
        }

        return payload
    }

    static func subcommand(period: Period, provider: ProviderFilter, includeOptimize: Bool) -> [String] {
        var command = [
            "status",
            "--format", "menubar-json",
            "--period", period.cliArg,
            "--provider", provider.cliArg,
        ]
        if !includeOptimize {
            command.append("--no-optimize")
        }
        return command
    }

    private struct ProcessResult {
        let stdout: Data
        let stderr: String
        let exitCode: Int32
    }

    private static func runCLI(subcommand: [String], timeoutSeconds: UInt64 = spawnTimeoutSeconds) async throws -> ProcessResult {
        try await FetchAdmission.processes.acquire()
        let spanId = await MainActor.run {
            RefreshTracer.shared.beginSpan(name: "CLI Spawn", category: "cli", tid: .cli)
        }
        do {
            let runner = CLIProcessRunner(process: ExeWatcherCLI.makeProcess(subcommand: subcommand), timeout: Double(timeoutSeconds))
            let result = try await runner.run()
            await FetchAdmission.processes.release()
            await MainActor.run { RefreshTracer.shared.endSpan(spanId, args: ["result": .string("exited")]) }
            return ProcessResult(stdout: result.0, stderr: String(data: result.1, encoding: .utf8) ?? "", exitCode: result.2)
        } catch {
            await FetchAdmission.processes.release()
            await MainActor.run { RefreshTracer.shared.endSpan(spanId, args: ["result": .string("error")]) }
            throw error
        }
    }
}

/// Owns the child through exit/reap. Pipes bound output while the child is running;
/// no unbounded temporary output files and no cancelled child left consuming CPU.
final class CLIProcessRunner: @unchecked Sendable {
    private let process: Process
    private let timeout: Double
    private let lock = NSLock()
    private var cancelled = false
    init(process: Process, timeout: Double) { self.process = process; self.timeout = timeout }
    private func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    private var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    func run() async throws -> (Data, Data, Int32) {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .utility).async {
                    do { continuation.resume(returning: try self.execute()) }
                    catch { continuation.resume(throwing: error) }
                }
            }
        } onCancel: { self.cancel() }
    }

    private func execute() throws -> (Data, Data, Int32) {
        if isCancelled { throw CancellationError() }
        let stdout = Pipe(), stderr = Pipe()
        defer {
            try? stdout.fileHandleForReading.close(); try? stdout.fileHandleForWriting.close()
            try? stderr.fileHandleForReading.close(); try? stderr.fileHandleForWriting.close()
        }
        process.standardOutput = stdout
        process.standardError = stderr
        for pipe in [stdout, stderr] {
            let fd = pipe.fileHandleForReading.fileDescriptor
            _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        }
        do { try process.run() } catch { throw DataClientError.spawn(error.localizedDescription) }
        try? stdout.fileHandleForWriting.close()
        try? stderr.fileHandleForWriting.close()
        let started = ProcessInfo.processInfo.systemUptime
        var out = Data(), err = Data()
        var failure: Error?
        var stopAt: Double?
        while true {
            let now = ProcessInfo.processInfo.systemUptime
            if failure == nil {
                if isCancelled { failure = CancellationError() }
                else if now - started >= timeout { failure = DataClientError.timeout(seconds: UInt64(timeout)) }
                else {
                    do {
                        try drain(stdout.fileHandleForReading, into: &out, limit: maxPayloadBytes)
                        try drain(stderr.fileHandleForReading, into: &err, limit: maxStderrBytes)
                    } catch { failure = error }
                }
            }
            if !process.isRunning { break }
            if failure != nil {
                if stopAt == nil { process.terminate(); stopAt = now }
                else if now - stopAt! >= 0.2 { kill(process.processIdentifier, SIGKILL) }
            }
            Thread.sleep(forTimeInterval: 0.02)
        }
        process.waitUntilExit()
        if let failure { throw failure }
        try drain(stdout.fileHandleForReading, into: &out, limit: maxPayloadBytes)
        try drain(stderr.fileHandleForReading, into: &err, limit: maxStderrBytes)
        if isCancelled { throw CancellationError() }
        return (out, err, process.terminationStatus)
    }

    private func drain(_ handle: FileHandle, into data: inout Data, limit: Int) throws {
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        // Bound each pass so a continuously writing child cannot starve cancellation/timeout.
        for _ in 0..<64 {
            let count = Darwin.read(handle.fileDescriptor, &buffer, buffer.count)
            if count < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK { return }
                if errno == EINTR { continue }
                throw DataClientError.spawn("Could not read CLI output")
            }
            if count == 0 { return }
            guard data.count + count <= limit else { throw DataClientError.outputTooLarge }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
}
