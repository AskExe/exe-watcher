import Foundation
import Darwin

/// Local support artifacts never become product analytics or network payloads.
enum LocalDiagnostics {
    private static func requireRegularFileOrMissing(_ file: URL) throws {
        var status = stat()
        if lstat(file.path, &status) == 0 {
            guard status.st_mode & S_IFMT == S_IFREG else { throw CocoaError(.fileWriteNoPermission) }
        } else if errno != ENOENT { throw CocoaError(.fileWriteNoPermission) }
    }
    static func prepare(_ directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }

    static func write(_ data: Data, to file: URL, append: Bool = false) throws {
        try prepare(file.deletingLastPathComponent())
        let target = append ? file : file.deletingLastPathComponent().appendingPathComponent(".diagnostic-\(UUID().uuidString)")
        let flags = O_WRONLY | O_CREAT | O_CLOEXEC | O_NOFOLLOW | (append ? O_APPEND : O_EXCL)
        let fd = Darwin.open(target.path, flags, mode_t(0o600))
        guard fd >= 0 else { throw CocoaError(.fileWriteNoPermission) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer {
            try? handle.close()
            if !append { try? FileManager.default.removeItem(at: target) }
        }
        guard fchmod(fd, mode_t(0o600)) == 0 else { throw CocoaError(.fileWriteNoPermission) }
        try handle.write(contentsOf: data)
        if !append, Darwin.rename(target.path, file.path) != 0 { throw CocoaError(.fileWriteUnknown) }
    }

    static func appendLog(_ message: String, to file: URL, version: String) throws {
        let old = file.appendingPathExtension("old")
        let manager = FileManager.default
        try requireRegularFileOrMissing(file)
        try requireRegularFileOrMissing(old)
        if manager.fileExists(atPath: old.path) {
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: old.path)
        }
        if let size = try? manager.attributesOfItem(atPath: file.path)[.size] as? NSNumber,
           size.intValue > 500 * 1024 {
            try? manager.removeItem(at: old)
            try manager.moveItem(at: file, to: old)
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: old.path)
        }
        let record: [String: String] = ["timestamp": Date().ISO8601Format(), "severity": "info",
            "service": "watcher-macos", "version": version, "category": "refresh", "message": message]
        var data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        data.append(0x0a)
        try write(data, to: file, append: true)
    }
}
