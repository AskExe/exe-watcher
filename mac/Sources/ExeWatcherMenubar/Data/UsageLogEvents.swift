import Foundation
import CoreServices

enum UsageLogEvents {
    static func shouldRefresh(path: String, flags: FSEventStreamEventFlags) -> Bool {
        // Dropped events or a renamed/removed watched root require reconciliation.
        let reconcile = kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagRootChanged
        if flags & UInt32(reconcile) != 0 { return true }
        let structural = kFSEventStreamEventFlagItemCreated | kFSEventStreamEventFlagItemRemoved | kFSEventStreamEventFlagItemRenamed
        if flags & UInt32(kFSEventStreamEventFlagItemIsDir) != 0 {
            return flags & UInt32(structural) != 0
        }
        let name = (path as NSString).lastPathComponent
        return name.hasSuffix(".jsonl") || name.hasSuffix(".db") || name.hasSuffix(".db-wal")
            || name == "state.vscdb" || name == "state.vscdb-wal" || name == "stats-cache.json"
            || (path.contains("/opencode/storage/") && name.hasSuffix(".json"))
    }
}
