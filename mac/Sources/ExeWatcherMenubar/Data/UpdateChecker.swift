import AppKit
import Observation
import Sparkle

@MainActor @Observable
final class UpdateChecker {
    private var controller: SPUStandardUpdaterController?

    var isAvailable: Bool { controller != nil }

    func start() {
        guard controller == nil,
              Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") is String else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    }

    func checkForUpdates() {
        controller?.checkForUpdates(nil)
    }
}
