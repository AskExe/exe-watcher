import AppKit
import Foundation
import Observation

/// Content-free counters and handled error categories through Odd's restricted collector.
@MainActor @Observable
final class WatcherTelemetry {
    static let shared = WatcherTelemetry()
    static let collector = URL(string: "https://data.odd.community")!
    static let alias = "public-watcher-mac-v1"
    static let features: Set<String> = ["mac_menu", "mac_report", "mac_period", "mac_provider"]
    private(set) var usageEnabled = false
    private(set) var diagnosticsEnabled = false
    private var timer: Timer?
    private var visible = false
    private var previous: (TimeInterval, Bool)?
    private var pending = 0
    private var activeDay = ""
    private var usageEpoch = "initial"
    private var diagnosticsEpoch = "initial"
    private var tasks: [String: Task<Void, Never>] = [:]
    private var generation = 0
    private let root: URL
    private let environment: [String: String]

    struct Diagnostic: Codable { let event: String; let category: String; let error_class: String; let version: String; let frames: [String] }
    struct Properties: Codable { var distinct_id: String; var app = "watcher"; var feature: String?; var active_ms: Int?; var outcome: String?; var app_version: String?; var app_platform: String? }
    struct Entry: Codable { let uuid: String; let timestamp: Date; var event: String?; var properties: Properties?; var diagnostic: Diagnostic? }
    private var queues: [String: [Entry]] = [:]
    private let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }()
    private let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()
    private var configURL: URL { root.appendingPathComponent("config.json") }
    private var suppressed: Bool { environment["EXE_WATCHER_TELEMETRY"] == "0" || environment["DO_NOT_TRACK"] == "1" }

    init(root: URL? = nil, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.environment = environment
        self.root = root ?? (environment["XDG_CONFIG_HOME"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config"))
            .appendingPathComponent("exe-watcher")
    }
    private func settings() -> [String: Any]? {
        if !FileManager.default.fileExists(atPath: configURL.path) { return [:] }
        guard let data = try? Data(contentsOf: configURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object
    }
    static func policy(_ values: [String: Any], suppressed: Bool = false) -> (usage: Bool, errors: Bool) {
        let blocked = suppressed || values["enabled"] as? Bool == false
        return (!blocked && (values["usageEnabled"] == nil || values["usageEnabled"] as? Bool == true),
                !blocked && values["diagnosticsEnabled"] as? Bool == true)
    }
    private var usageDisclosed: Bool {
        let values = settings()?["telemetry"] as? [String: Any] ?? [:]
        return values["basicNoticeVersion"] as? Int == 1 || values["usageEnabled"] as? Bool == true
    }
    private func presentBasicNoticeIfNeeded() {
        let values = settings()?["telemetry"] as? [String: Any] ?? [:]
        guard usageEnabled, values["basicNoticeVersion"] as? Int != 1 else { return }
        let alert = NSAlert()
        alert.messageText = "Help improve Watcher"
        alert.informativeText = "Share basic app activity with Odd’s own servers: daily activity, foreground menu time, feature outcomes, app version and platform. A random installation ID measures returning installations. Your content stays private. Our collector receives your connection IP. You can turn this off anytime in Settings. Error diagnostics are a separate choice."
        let choice = NSButton(checkboxWithTitle: "Share basic usage statistics", target: nil, action: nil)
        choice.state = .on
        alert.accessoryView = choice
        alert.addButton(withTitle: "Continue")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        setConsent(usage: true, enabled: choice.state == .on, approved: true, disclosedBasicNotice: true)
    }
    private func refreshConsent() {
        let config = settings()
        let valid = config != nil && (config?["telemetry"] == nil || config?["telemetry"] is [String: Any])
        let values = config?["telemetry"] as? [String: Any] ?? [:]
        let newUsageEpoch = values["usageEpoch"] as? String ?? "initial"
        let newDiagnosticsEpoch = values["diagnosticsEpoch"] as? String ?? "initial"
        if newUsageEpoch != usageEpoch { queues["usage"] = []; try? FileManager.default.removeItem(at: queueURL("usage")) }
        if newDiagnosticsEpoch != diagnosticsEpoch { queues["errors"] = []; try? FileManager.default.removeItem(at: queueURL("errors")) }
        let changedEpoch = newUsageEpoch != usageEpoch || newDiagnosticsEpoch != diagnosticsEpoch
        usageEpoch = newUsageEpoch; diagnosticsEpoch = newDiagnosticsEpoch
        let resolved = Self.policy(values, suppressed: suppressed || !valid)
        let usage = resolved.usage
        let errors = resolved.errors
        if usage != usageEnabled || errors != diagnosticsEnabled || changedEpoch {
            generation += 1
            for task in tasks.values { task.cancel() }; tasks = [:]
            previous = nil; pending = 0; activeDay = ""
        }
        usageEnabled = usage; diagnosticsEnabled = errors
        if !usage { queues["usage"] = []; try? FileManager.default.removeItem(at: queueURL("usage")) }
        if !errors { queues["errors"] = []; try? FileManager.default.removeItem(at: queueURL("errors")) }
        if !usage { try? FileManager.default.removeItem(at: root.appendingPathComponent("telemetry-id")) }
        if changedEpoch { try? save(JSONSerialization.data(withJSONObject: ["usage": usageEpoch, "diagnostics": diagnosticsEpoch]), to: root.appendingPathComponent("telemetry-mac-consent.json")) }
    }
    /// Basic usage has a disclosed default; detailed diagnostics require a native opt-in.
    func setConsent(usage: Bool, enabled: Bool, approved: Bool = false, disclosedBasicNotice: Bool = false) {
        if enabled && !usage && !approved {
            let alert = NSAlert()
            alert.messageText = usage ? "Share basic usage statistics?" : "Share error diagnostics?"
            alert.informativeText = usage
                ? "Send a random installation ID, foreground menu time and feature names to our self-hosted PostHog. No prompts, paths, usage logs, project names or spend. Our collector receives your connection IP. Turning this off clears unsent counters and the local ID; received counters remain."
                : "Send only error category, error class and app version to our self-hosted Sentry. No error messages, paths, account/device IDs, memory dumps or screenshots. Our collector receives your connection IP. Turning this off clears unsent reports; received reports remain."
            alert.addButton(withTitle: "Keep Off"); alert.addButton(withTitle: "Enable")
            guard alert.runModal() == .alertSecondButtonReturn else { return }
        }
        do {
            // Refuse to overwrite an unreadable or malformed existing configuration.
            guard var config = settings() else { return }
            var values = config["telemetry"] as? [String: Any] ?? [:]
            if values["enabled"] as? Bool == false {
                values["usageEnabled"] = false; values["diagnosticsEnabled"] = false
                values.removeValue(forKey: "enabled")
            }
            let key = usage ? "usageEnabled" : "diagnosticsEnabled"
            if values[key] as? Bool != enabled { values[usage ? "usageEpoch" : "diagnosticsEpoch"] = UUID().uuidString }
            values[key] = enabled
            if disclosedBasicNotice { values["basicNoticeVersion"] = 1 }
            config["telemetry"] = values
            try save(JSONSerialization.data(withJSONObject: config, options: [.sortedKeys, .prettyPrinted]), to: configURL)
            refreshConsent()
        } catch { /* Failed consent persistence leaves collection disabled. */ }
    }
    private func save(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    private func queueURL(_ lane: String) -> URL { root.appendingPathComponent("telemetry-mac-\(lane).json") }
    private func persist(_ lane: String) { try? save(encoder.encode(queues[lane] ?? []), to: queueURL(lane)) }
    private func id() -> String? {
        let url = root.appendingPathComponent("telemetry-id")
        if let value = try? String(contentsOf: url, encoding: .utf8), UUID(uuidString: value.trimmingCharacters(in: .whitespacesAndNewlines)) != nil { return value.trimmingCharacters(in: .whitespacesAndNewlines) }
        let value = UUID().uuidString.lowercased()
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try Data(value.utf8).write(to: url, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            return value
        } catch { return (try? String(contentsOf: url, encoding: .utf8)).flatMap { UUID(uuidString: $0) == nil ? nil : $0 } }
    }
    func sanitized(_ row: Entry, lane: String) -> Entry? {
        guard UUID(uuidString: row.uuid) != nil, row.timestamp <= Date(), Date().timeIntervalSince(row.timestamp) < 7 * 86400 else { return nil }
        if lane == "errors", let d = row.diagnostic, d.event == "error", d.category == "ipc_error" {
            return Entry(uuid: row.uuid, timestamp: row.timestamp, diagnostic: Self.diagnostic(version: d.version))
        }
        guard lane == "usage", var properties = row.properties, UUID(uuidString: properties.distinct_id) != nil else { return nil }
        properties.app = "watcher"
        properties.app_platform = "macos"
        if properties.app_version?.range(of: "^\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}$", options: .regularExpression) == nil { properties.app_version = nil }
        if row.event != "app_result" { properties.outcome = nil }
        switch row.event {
        case "app_result":
            guard Self.features.contains(properties.feature ?? ""), ["success", "failure"].contains(properties.outcome ?? "") else { return nil }
            properties.active_ms = nil
        case "app_active": properties.feature = nil; properties.active_ms = nil
        case "app_feature": guard Self.features.contains(properties.feature ?? "") else { return nil }; properties.active_ms = nil
        case "app_usage": guard let ms = properties.active_ms, ms > 0, ms <= 60000 else { return nil }; properties.feature = nil
        default: return nil
        }
        return Entry(uuid: row.uuid, timestamp: row.timestamp, event: row.event, properties: properties)
    }
    static func diagnostic(version: String) -> Diagnostic {
        Diagnostic(event: "error", category: "ipc_error", error_class: "Error",
                   version: version.range(of: "^\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}$", options: .regularExpression) != nil ? version : "0.0.0", frames: [])
    }
    private func track(_ event: String, feature: String? = nil, ms: Int? = nil, outcome: String? = nil) {
        refreshConsent()
        guard usageEnabled, usageDisclosed, let identity = id() else { return }
        append(Entry(uuid: UUID().uuidString.lowercased(), timestamp: Date(), event: event,
                     properties: Properties(distinct_id: identity, feature: feature, active_ms: ms, outcome: outcome, app_version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String, app_platform: "macos")), lane: "usage")
    }
    private func append(_ row: Entry, lane: String) {
        guard let safe = sanitized(row, lane: lane) else { return }
        queues[lane] = Array((queues[lane] ?? []).compactMap { sanitized($0, lane: lane) }.suffix(99)) + [safe]
        persist(lane)
    }
    private func flush(_ lane: String) {
        refreshConsent()
        guard tasks[lane] == nil, (lane == "usage" ? usageEnabled && usageDisclosed : diagnosticsEnabled), !(queues[lane] ?? []).isEmpty else { return }
        let batch = Array((queues[lane] ?? []).prefix(lane == "usage" ? 50 : 10))
        let epoch = generation
        tasks[lane] = Task {
            defer { if epoch == generation { tasks[lane] = nil } }
            do {
                var request = URLRequest(url: Self.collector.appendingPathComponent(lane == "usage" ? "batch/" : "errors/"))
                request.httpMethod = "POST"; request.timeoutInterval = 5
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                let rows = try JSONSerialization.jsonObject(with: encoder.encode(batch))
                request.httpBody = try JSONSerialization.data(withJSONObject: ["api_key": Self.alias, "batch": rows])
                let configuration = URLSessionConfiguration.ephemeral
                configuration.httpCookieStorage = nil; configuration.urlCache = nil
                let session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
                defer { session.invalidateAndCancel() }
                let (_, response) = try await session.data(for: request)
                refreshConsent()
                if !Task.isCancelled, epoch == generation, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                    let sent = Set(batch.map(\.uuid)); queues[lane]?.removeAll { sent.contains($0.uuid) }; persist(lane)
                }
            } catch { /* Bounded retry on the next 30-second flush, UUID unchanged. */ }
        }
    }
    static func activeMilliseconds(from: TimeInterval, to: TimeInterval, wasActive: Bool, isActive: Bool) -> Int {
        let delta = to - from
        return wasActive && isActive && delta > 0 && delta <= 15 ? Int(delta * 1000) : 0
    }
    private func sample() {
        refreshConsent()
        let now = ProcessInfo.processInfo.systemUptime
        let active = visible && usageEnabled && NSApp.isActive &&
            CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!) < 60 &&
            (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool != true
        let old = previous; previous = (now, active)
        if active {
            let day = ISO8601DateFormatter().string(from: Date()).prefix(10).description
            if day != activeDay { track("app_active"); activeDay = day }
        }
        if let old { pending += Self.activeMilliseconds(from: old.0, to: now, wasActive: old.1, isActive: active) }
        if pending >= 30000 { track("app_usage", ms: min(pending, 60000)); pending = 0 }
    }
    static func start() {
        let s = shared
        if let data = try? Data(contentsOf: s.root.appendingPathComponent("telemetry-mac-consent.json")),
           let epochs = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            s.usageEpoch = epochs["usage"] ?? "initial"; s.diagnosticsEpoch = epochs["diagnostics"] ?? "initial"
        }
        for lane in ["usage", "errors"] {
            if let data = try? Data(contentsOf: s.queueURL(lane)), data.count <= 262144,
               let entries = try? s.decoder.decode([Entry].self, from: data) {
                s.queues[lane] = entries.suffix(100).compactMap { s.sanitized($0, lane: lane) }
            }
        }
        s.refreshConsent()
        s.presentBasicNoticeIfNeeded()
        var ticks = 0
        s.timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            Task { @MainActor in
                s.sample(); ticks += 1
                if ticks % 6 == 0 { s.flush("usage"); s.flush("errors") }
            }
        }
    }
    static func capture(_ event: String) {
        let s = shared
        if event == "menu_opened" { s.visible = true; s.previous = nil; s.sample(); s.track("app_feature", feature: "mac_menu") }
        else if features.contains(event) { s.track("app_feature", feature: event) }
    }
    static func menuClosed() {
        let s = shared; s.sample(); s.visible = false; s.previous = nil
        if s.pending > 0 { s.track("app_usage", ms: min(s.pending, 60000)); s.pending = 0 }
        s.flush("usage"); s.flush("errors")
    }
    static func refreshResult(success: Bool) {
        let s = shared
        guard s.visible, NSApp.isActive,
              CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!) < 60 else { return }
        s.track("app_result", feature: "mac_menu", outcome: success ? "success" : "failure")
    }
    static func fetchFailed() {
        let s = shared; s.refreshConsent(); guard s.diagnosticsEnabled else { return }
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        s.append(Entry(uuid: UUID().uuidString.lowercased(), timestamp: Date(), diagnostic: diagnostic(version: version)), lane: "errors")
    }
    static func testDiagnostic() {
        do { throw NSError(domain: "Watcher handled test", code: 1) }
        catch { fetchFailed(); shared.flush("errors") }
    }
    static func stop() { menuClosed(); shared.timer?.invalidate(); for task in shared.tasks.values { task.cancel() } }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
