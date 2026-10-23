import Foundation
import Testing
@testable import ExeWatcherMenubar

@Suite("Watcher telemetry privacy") @MainActor
struct WatcherTelemetryTests {
    @Test func defaultPolicyHonorsEveryExplicitOptOut() {
        #expect(WatcherTelemetry.policy([:]).usage)
        #expect(!WatcherTelemetry.policy([:]).errors)
        #expect(!WatcherTelemetry.policy(["usageEnabled": false]).usage)
        #expect(!WatcherTelemetry.policy(["enabled": false, "diagnosticsEnabled": true]).errors)
        #expect(!WatcherTelemetry.policy(["usageEnabled": "invalid"]).usage)
        #expect(!WatcherTelemetry.policy([:], suppressed: true).usage)
        #expect(WatcherTelemetry.policy(["diagnosticsEnabled": true]).errors)
    }
    @Test func disclosureChoicePersistsAndDoesNotEnableDiagnostics() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let adapter = WatcherTelemetry(root: root, environment: [:])
        adapter.setConsent(usage: true, enabled: false, approved: true, disclosedBasicNotice: true)
        #expect(!adapter.usageEnabled && !adapter.diagnosticsEnabled)
        let data = try Data(contentsOf: root.appendingPathComponent("config.json"))
        let config = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let settings = config["telemetry"] as! [String: Any]
        #expect(settings["basicNoticeVersion"] as? Int == 1)
        #expect(settings["usageEnabled"] as? Bool == false)
        #expect(settings["diagnosticsEnabled"] == nil)
    }
    @Test func explicitReenableDoesNotUndoTheOtherLegacyOptOut() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("{\"telemetry\":{\"enabled\":false,\"diagnosticsEnabled\":true}}".utf8).write(to: root.appendingPathComponent("config.json"))
        let adapter = WatcherTelemetry(root: root, environment: [:])
        adapter.setConsent(usage: true, enabled: true, approved: true)
        #expect(adapter.usageEnabled && !adapter.diagnosticsEnabled)
    }
    @Test func independentConsentAndRevocationPreserveSettings() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("config.json")
        try Data("{\"currency\":{\"code\":\"EUR\"}}".utf8).write(to: file)
        let adapter = WatcherTelemetry(root: root, environment: [:])
        #expect(!adapter.usageEnabled && !adapter.diagnosticsEnabled)
        adapter.setConsent(usage: true, enabled: true, approved: true)
        #expect(adapter.usageEnabled && !adapter.diagnosticsEnabled)
        adapter.setConsent(usage: false, enabled: true, approved: true)
        #expect(adapter.usageEnabled && adapter.diagnosticsEnabled)
        try Data("[]".utf8).write(to: root.appendingPathComponent("telemetry-mac-usage.json"))
        try Data(UUID().uuidString.utf8).write(to: root.appendingPathComponent("telemetry-id"))
        adapter.setConsent(usage: true, enabled: false)
        #expect(!adapter.usageEnabled && adapter.diagnosticsEnabled)
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("telemetry-id").path))
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("telemetry-mac-usage.json").path))
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        #expect((saved["currency"] as? [String: String])?["code"] == "EUR")
        let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as! NSNumber
        #expect(mode.intValue == 0o600)
    }
    @Test func optOutEnvironmentAndMalformedConfigFailClosed() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let adapter = WatcherTelemetry(root: root, environment: ["DO_NOT_TRACK": "1"])
        adapter.setConsent(usage: true, enabled: true, approved: true)
        #expect(!adapter.usageEnabled)
        let file = root.appendingPathComponent("config.json")
        try Data("invalid".utf8).write(to: file)
        adapter.setConsent(usage: false, enabled: true, approved: true)
        #expect(try String(contentsOf: file, encoding: .utf8) == "invalid")
    }
    @Test func excludesIdleSleepAndClosedIntervals() {
        #expect(WatcherTelemetry.activeMilliseconds(from: 1, to: 6, wasActive: true, isActive: true) == 5000)
        #expect(WatcherTelemetry.activeMilliseconds(from: 1, to: 61, wasActive: true, isActive: true) == 0)
        #expect(WatcherTelemetry.activeMilliseconds(from: 1, to: 6, wasActive: false, isActive: true) == 0)
        #expect(WatcherTelemetry.activeMilliseconds(from: 1, to: 6, wasActive: true, isActive: false) == 0)
    }
    @Test func resultMetadataIsBoundedAndSanitized() {
        let adapter = WatcherTelemetry(environment: [:])
        let id = UUID().uuidString
        let properties = WatcherTelemetry.Properties(distinct_id: id, feature: "mac_menu", outcome: "success", app_version: "0.2.67", app_platform: "PRIVATE")
        let row = WatcherTelemetry.Entry(uuid: id, timestamp: Date(), event: "app_result", properties: properties)
        let safe = adapter.sanitized(row, lane: "usage")
        #expect(safe?.properties?.outcome == "success")
        #expect(safe?.properties?.app_version == "0.2.67")
        #expect(safe?.properties?.app_platform == "macos")
        var invalid = row; invalid.properties?.outcome = "PRIVATE"
        #expect(adapter.sanitized(invalid, lane: "usage") == nil)
        invalid = row; invalid.properties?.app_version = "/Users/PRIVATE"
        #expect(adapter.sanitized(invalid, lane: "usage")?.properties?.app_version == nil)
    }
    @Test func queuedInputsAreReconstructedAndRecordingIsRejected() {
        let adapter = WatcherTelemetry(environment: [:])
        let identity = UUID().uuidString
        let row = WatcherTelemetry.Entry(uuid: identity, timestamp: Date(), event: "app_feature",
            properties: .init(distinct_id: identity, app: "PRIVATE", feature: "mac_menu", active_ms: 500))
        let safe = adapter.sanitized(row, lane: "usage")
        #expect(safe?.properties?.app == "watcher")
        #expect(safe?.properties?.active_ms == nil)
        let forbidden = WatcherTelemetry.Entry(uuid: identity, timestamp: Date(), event: "app_recording", properties: row.properties)
        #expect(adapter.sanitized(forbidden, lane: "usage") == nil)
        let error = WatcherTelemetry.diagnostic(version: "/Users/PRIVATE")
        #expect(error.version == "0.0.0" && error.frames.isEmpty)
    }
}
