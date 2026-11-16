import Darwin
import Foundation
import Testing
@testable import ExeWatcherMenubar

@Suite("Safe file I/O")
struct SafeFileTests {
    @Test func readsRegularFilesAndRejectsOversizedSymlinkAndSpecialFiles() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("value.json")
        try Data("{\"ok\":true}".utf8).write(to: file)
        #expect(try SafeFile.read(from: file.path) == Data("{\"ok\":true}".utf8))
        #expect(throws: SafeFile.Error.self) { try SafeFile.read(from: file.path, maxBytes: 2) }

        let link = directory.appendingPathComponent("link.json")
        #expect(symlink(file.path, link.path) == 0)
        #expect(throws: SafeFile.Error.self) { try SafeFile.read(from: link.path) }

        let fifo = directory.appendingPathComponent("input.fifo")
        #expect(mkfifo(fifo.path, 0o600) == 0)
        #expect(throws: SafeFile.Error.self) { try SafeFile.read(from: fifo.path) }
    }

    @Test func writesPrivateAtomicallyWithoutFollowingATargetSymlink() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let sensitive = directory.appendingPathComponent("sensitive")
        try Data("preserve".utf8).write(to: sensitive)
        let target = directory.appendingPathComponent("target")
        #expect(symlink(sensitive.path, target.path) == 0)
        #expect(throws: SafeFile.Error.self) { try SafeFile.write(Data("replacement".utf8), to: target.path) }
        #expect(try Data(contentsOf: sensitive) == Data("preserve".utf8))

        try FileManager.default.removeItem(at: target)
        try SafeFile.write(Data("replacement".utf8), to: target.path)
        #expect(try SafeFile.read(from: target.path) == Data("replacement".utf8))
        let attributes = try FileManager.default.attributesOfItem(atPath: target.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }
}
