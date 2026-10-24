import AppKit
import Testing
@testable import ExeWatcherMenubar

@Suite("Menu bar alignment and animation") @MainActor
struct MenuBarBadgeTests {
    @Test func disablingAnimationCancelsAndRestoresNeutral() async throws {
        let animator = MenuBarOwlAnimator()
        var poses: [OwlPose] = []
        animator.configure(enabled: true) { poses.append($0) }
        #expect(animator.isRunning)
        let deadline = ContinuousClock.now + .seconds(3)
        while !poses.contains(where: { !$0.isClose(to: .neutral) }), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(poses.contains(where: { !$0.isClose(to: .neutral) }))
        animator.configure(enabled: false) { poses.append($0) }
        let count = poses.count
        try await Task.sleep(for: .milliseconds(100))
        #expect(!animator.isRunning && poses.count == count && poses.last == .neutral)
    }

    @Test func textAndOwlInkShareAnOpticalCenter() throws {
        let view = MenuBarBadgeView(frame: NSRect(x: 0, y: 0, width: 110, height: 24))
        view.text = NSAttributedString(string: "$281.29", attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium), .foregroundColor: NSColor.white,
        ])
        let rep = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 110, pixelsHigh: 24,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let context = try #require(NSGraphicsContext(bitmapImageRep: rep))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        view.draw(view.bounds)
        NSGraphicsContext.restoreGraphicsState()
        var owlRows: [Int] = [], textRows: [Int] = []
        for y in 0..<24 {
            for x in 0..<110 {
                let c = try #require(rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB))
                guard c.alphaComponent > 0.5 else { continue }
                if c.redComponent > 0.7 && c.greenComponent > 0.5 && c.blueComponent < 0.7 { owlRows.append(y) }
                if c.redComponent > 0.9 && c.greenComponent > 0.9 && c.blueComponent > 0.9 { textRows.append(y) }
            }
        }
        let owlCenter = Double(try #require(owlRows.min()) + #require(owlRows.max())) / 2
        let textCenter = Double(try #require(textRows.min()) + #require(textRows.max())) / 2
        #expect(abs(owlCenter - textCenter) <= 1)
        #expect(view.hitTest(.zero) == nil)
        #expect(view.requiredWidth > 60)
    }
}
