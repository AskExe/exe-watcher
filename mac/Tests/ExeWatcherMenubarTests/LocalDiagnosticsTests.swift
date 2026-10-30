import Foundation
import Testing
@testable import ExeWatcherMenubar

@Suite("Local diagnostics privacy")
struct LocalDiagnosticsTests {
    @Test func privateArtifactsAndExistingFilesUseOwnerOnlyPermissions() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("trace.json")
        try Data("old".utf8).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        try LocalDiagnostics.write(Data("new".utf8), to: file)
        #expect(try String(contentsOf: file, encoding: .utf8) == "new")
        #expect(try permissions(file) == 0o600)
        #expect(try permissions(root) == 0o700)
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path) == ["trace.json"])
    }
    @Test func structuredLinesEscapeNewlinesAndRotatePrivately() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("refresh.log")
        try Data(repeating: 32, count: 513 * 1024).write(to: file)
        try LocalDiagnostics.appendLog("line one\nline two", to: file, version: "0.2.74")
        let data = try Data(contentsOf: file)
        #expect(data.filter { $0 == 0x0a }.count == 1)
        let row = try JSONSerialization.jsonObject(with: data) as! [String: String]
        #expect(row["message"] == "line one\nline two")
        #expect(row["service"] == "watcher-macos" && row["version"] == "0.2.74")
        #expect(try permissions(file) == 0o600)
        #expect(try permissions(file.appendingPathExtension("old")) == 0o600)
    }
    @Test func appendRefusesSymlinkTargets() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let target = root.appendingPathComponent("other")
        try Data("unchanged".utf8).write(to: target)
        let link = root.appendingPathComponent("refresh.log")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        #expect(throws: (any Error).self) { try LocalDiagnostics.write(Data("private".utf8), to: link, append: true) }
        #expect(throws: (any Error).self) { try LocalDiagnostics.appendLog("private", to: link, version: "0.2.74") }
        #expect(try String(contentsOf: target, encoding: .utf8) == "unchanged")
    }
    private func permissions(_ file: URL) throws -> Int {
        (try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as! NSNumber).intValue
    }
}
