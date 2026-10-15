import AppKit
import Foundation
import SwiftUI
import Testing
@testable import ExeWatcherMenubar

@Suite("AI time coverage and presentation")
struct TimePayloadTests {
    private func fixture() throws -> TimeBlock {
        let data = Data("""
        {"since":"2025-07-01T00:00:00.000Z","through":"2026-10-15T23:59:59.999Z",
         "aiRunningMs":45000000,"elapsedBusyMs":28800000,"userActiveMs":3720000,
         "estimatedAiMs":0,"coverage":"partial","pendingFiles":0,"indexedFiles":12,
         "firstRecordedAt":"2025-10-01T00:00:00.000Z","lastRecordedAt":"2026-10-15T12:00:00.000Z",
         "providers":[{"name":"claude","files":12,"timedFiles":9,"aiRunningMs":45000000,"status":"partial"}],
         "notes":["Missing timing records are unknown, not zero."]}
        """.utf8)
        return try JSONDecoder().decode(TimeBlock.self, from: data)
    }

    @Test func unknownAndLongDurations() {
        #expect(TimeBlock.duration(nil) == "Unknown")
        #expect(TimeBlock.duration(-1) == "Unknown")
        #expect(TimeBlock.duration(.infinity) == "Unknown")
        #expect(TimeBlock.duration(1e300) == "Unknown")
        #expect(TimeBlock.duration(3_660_000) == "1h 1m")
        #expect(TimeBlock.duration(0) == "<1 min")
    }

    @Test func optionalTimeSurvivesPersistenceAndOldPayloadsRemainReadable() throws {
        let empty = MenubarPayload.empty
        #expect(try JSONDecoder().decode(MenubarPayload.self, from: JSONEncoder().encode(empty)).time == nil)
        var payload = empty
        payload.time = try fixture()
        let decoded = try JSONDecoder().decode(MenubarPayload.self, from: JSONEncoder().encode(payload))
        #expect(decoded.time?.aiRunningMs == 45_000_000)
        #expect(decoded.time?.userActiveMs == 3_720_000)
        #expect(decoded.time?.coverage == "partial")
    }

    @Test func periodSnapshotsCarryTheirOwnTimeWindow() throws {
        let snapshot = PeriodSnapshot(current: MenubarPayload.empty.current, projectSpend: nil,
            diagnostics: nil, historyValidatedAt: 0, time: try fixture())
        let decoded = try JSONDecoder().decode(PeriodSnapshot.self, from: JSONEncoder().encode(snapshot))
        #expect(decoded.time?.elapsedBusyMs == 28_800_000)
    }

    @Test @MainActor func compactTimePanelRendersAtPopoverWidth() throws {
        let renderer = ImageRenderer(content: AITimeContent(time: try fixture())
            .frame(width: 380).background(Color.white).environment(\.colorScheme, .light))
        renderer.scale = 2
        let image = renderer.nsImage
        #expect(image != nil)
        if let path = ProcessInfo.processInfo.environment["WATCHER_TIME_SNAPSHOT_PATH"],
           let tiff = image?.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiff),
           let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: path))
        }
    }
}
