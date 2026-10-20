import Foundation
import Observation

struct ActivityDay: Codable, Sendable {
    let start: Double
    let end: Double
    var active: [String: Double] = [:]
    var contextual: [String: Double] = [:]
}

struct ActivityHistory: Codable, Sendable {
    let version: Int
    let startedAt: String
    var updatedAt: String
    var enabled: Bool
    let timeZone: String
    var recordedThrough: Double
    var days: [ActivityDay]

    func validate() -> Bool {
        guard version == 1, Self.date(startedAt) != nil, Self.date(updatedAt) != nil,
              recordedThrough.isFinite, days.count <= 36_600, TimeZone(identifier: timeZone) != nil else { return false }
        var previousEnd = 0.0
        for day in days {
            guard day.start.isFinite, day.end.isFinite, day.start >= previousEnd,
                  day.end > day.start, day.end - day.start <= 26 * 3_600_000,
                  day.active.count <= 32, day.contextual.count <= 32 else { return false }
            let values = Array(day.active.values) + Array(day.contextual.values)
            guard values.allSatisfy({ $0.isFinite && $0 >= 0 }), values.reduce(0, +) <= day.end - day.start else { return false }
            previousEnd = day.end
        }
        return true
    }

    static func date(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    static func stamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

/// One writer, one small daily ledger; independent of token scans and cost caches.
@MainActor @Observable
final class PersonalActivityStore {
    static let byteLimit = 4 * 1024 * 1024
    private(set) var history: ActivityHistory?
    private(set) var error: String?
    @ObservationIgnored private let url: URL?
    @ObservationIgnored private var lockFD: Int32 = -1
    @ObservationIgnored private var dirty = false
    @ObservationIgnored private var lastSave = Date.distantPast
    @ObservationIgnored var onEnabledChange: (() -> Void)?

    init(url: URL?) {
        self.url = url
        load()
    }

    var enabled: Bool { history?.enabled ?? true }
    var canRecord: Bool { lockFD >= 0 && error == nil && enabled }

    private func load() {
        guard let url, FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            let data = try SafeFile.read(from: url.path, maxBytes: Self.byteLimit)
            let saved = try JSONDecoder().decode(ActivityHistory.self, from: data)
            guard saved.validate() else { throw CocoaError(.fileReadCorruptFile) }
            history = saved
        } catch {
            self.error = "App activity is paused because its saved history could not be read. Your existing file is preserved."
        }
    }

    func startRecording(now: Date = Date()) {
        guard lockFD < 0, error == nil, let url else { return }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            let fd = Darwin.open(url.path + ".lock", O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw CocoaError(.fileWriteNoPermission) }
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
                Darwin.close(fd)
                error = "Another Watcher is recording app activity. This copy will not count it again."
                return
            }
            lockFD = fd
            // Refresh under ownership: another copy may have saved since init.
            load()
            guard error == nil else { return }
            if history == nil {
                let stamp = ActivityHistory.stamp(now)
                history = ActivityHistory(version: 1, startedAt: stamp, updatedAt: stamp, enabled: true,
                    timeZone: TimeZone.current.identifier, recordedThrough: now.timeIntervalSince1970 * 1000, days: [])
                dirty = true
                flush(now: now)
            }
        } catch { self.error = "App activity could not save on this Mac. Tracking is paused." }
    }

    func setEnabled(_ value: Bool, now: Date = Date()) {
        guard lockFD >= 0, history != nil, error == nil else { return }
        history?.enabled = value
        dirty = true
        flush(now: now)
        onEnabledChange?()
    }

    func record(start: Date, end: Date, provider: String, contextual: Bool, now: Date = Date()) {
        guard canRecord, var saved = history, !provider.isEmpty,
              end > start, end.timeIntervalSince(start) <= 60 else { return }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: saved.timeZone) ?? .current
        var cursor = max(start, Date(timeIntervalSince1970: saved.recordedThrough / 1000))
        let stop = min(end, now)
        while cursor < stop {
            guard let day = calendar.dateInterval(of: .day, for: cursor) else { break }
            let finish = min(stop, day.end)
            let ms = finish.timeIntervalSince(cursor) * 1000
            let dayStart = day.start.timeIntervalSince1970 * 1000
            if saved.days.last?.start != dayStart {
                guard saved.days.count < 36_600, (saved.days.last?.end ?? 0) <= dayStart else { break }
                saved.days.append(ActivityDay(start: dayStart, end: day.end.timeIntervalSince1970 * 1000))
            }
            let index = saved.days.count - 1
            if contextual { saved.days[index].contextual[provider, default: 0] += ms }
            else { saved.days[index].active[provider, default: 0] += ms }
            saved.recordedThrough = finish.timeIntervalSince1970 * 1000
            cursor = finish
        }
        guard saved.recordedThrough > history!.recordedThrough else { return }
        saved.updatedAt = ActivityHistory.stamp(now)
        history = saved
        dirty = true
        if now.timeIntervalSince(lastSave) >= 300 { flush(now: now) }
    }

    func flush(now: Date = Date()) {
        guard dirty, lockFD >= 0, error == nil, let url, var saved = history else { return }
        saved.updatedAt = ActivityHistory.stamp(now)
        do {
            let data = try JSONEncoder().encode(saved)
            guard data.count <= Self.byteLimit, saved.validate() else { throw CocoaError(.fileWriteOutOfSpace) }
            try SafeFile.write(data, to: url.path)
            history = saved
            lastSave = now
            dirty = false
        } catch { self.error = "App activity could not save on this Mac. Tracking is paused; saved totals are preserved." }
    }

    func stop(now: Date = Date()) {
        flush(now: now)
        if lockFD >= 0 { Darwin.close(lockFD); lockFD = -1 }
    }

    func summary(period: Period, provider: ProviderFilter, now: Date = Date()) -> AppActivityBlock? {
        guard let saved = history else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: saved.timeZone) ?? .current
        let today = calendar.startOfDay(for: now)
        let start: Date
        switch period {
        case .today: start = today
        case .sevenDays: start = calendar.date(byAdding: .day, value: -6, to: today) ?? today
        case .thirtyDays: start = calendar.date(byAdding: .day, value: -29, to: today) ?? today
        case .month: start = calendar.dateInterval(of: .month, for: now)?.start ?? today
        case .all: start = .distantPast
        }
        let rows = saved.days.filter { $0.start >= start.timeIntervalSince1970 * 1000 && $0.start <= now.timeIntervalSince1970 * 1000 }
        func total(_ map: [String: Double]) -> Double {
            provider == .all ? map.values.reduce(0, +) : map[provider.cliArg, default: 0]
        }
        return AppActivityBlock(activeMs: rows.reduce(0) { $0 + total($1.active) },
            contextualMs: rows.reduce(0) { $0 + total($1.contextual) }, startedAt: saved.startedAt,
            updatedAt: saved.updatedAt, enabled: saved.enabled)
    }
}
