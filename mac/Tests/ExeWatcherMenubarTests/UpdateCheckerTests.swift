import Testing
@testable import ExeWatcherMenubar

@Suite("Update checker")
@MainActor
struct UpdateCheckerTests {
    @Test func unpackagedBuildDoesNotStartTheUpdater() {
        let checker = UpdateChecker()
        checker.start()
        #expect(!checker.isAvailable)
    }
}
