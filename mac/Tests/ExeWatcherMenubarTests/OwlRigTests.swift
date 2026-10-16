import AppKit
import Foundation
import SwiftUI
import Testing
@testable import ExeWatcherMenubar

// MARK: - Choreography (pure pose function)

@Suite("Owl motion choreography")
struct OwlMotionTests {
    private static let frame = 1.0 / 60.0

    private func samples(from start: Double, to end: Double, reduceMotion: Bool) -> [(Double, OwlPose)] {
        stride(from: start, through: end, by: Self.frame).map { ($0, OwlMotion.popoverPose(at: $0, reduceMotion: reduceMotion)) }
    }

    @Test func popoverStartsNeutral() {
        #expect(OwlMotion.popoverPose(at: 0, reduceMotion: false) == .neutral)
    }

    @Test func introLooksLeftFirst() {
        let pose = OwlMotion.popoverPose(at: 0.6, reduceMotion: false)
        #expect(pose.pupilX < -3 && pose.headRotation < -5 && pose.faceX < -5 && pose.lean < 0)
    }

    @Test func introLooksRightSecond() {
        let pose = OwlMotion.popoverPose(at: 1.25, reduceMotion: false)
        #expect(pose.pupilX > 3 && pose.headRotation > 5 && pose.faceX > 5 && pose.lean > 0)
    }

    @Test func introBlinks() {
        let pose = OwlMotion.popoverPose(at: OwlMotion.introBlinks[0] + 0.085, reduceMotion: false)
        #expect(pose.holeRY < 1.5 && pose.pupilRY < 0.5)
    }

    @Test func introCuriousTilt() {
        let pose = OwlMotion.popoverPose(at: 1.95, reduceMotion: false)
        #expect(pose.headRotation > 9 && abs(pose.faceX) < 0.5 && abs(pose.pupilX) < 0.1)
    }

    @Test func introSettlesFacingForward() {
        let pose = OwlMotion.popoverPose(at: OwlMotion.idleLookCadence.start - 0.01, reduceMotion: false)
        #expect(pose.isClose(to: .neutral, tolerance: 1e-3))
    }

    /// Longest stretch, in seconds, over which the sampled pose did not change.
    private func longestStill(_ samples: [(Double, OwlPose)]) -> Double {
        var longest = 0.0
        var runStart = samples[0].0
        for (previous, current) in zip(samples, samples.dropFirst()) {
            if current.1.isClose(to: previous.1, tolerance: 1e-4) {
                longest = max(longest, current.0 - runStart)
            } else {
                runStart = current.0
            }
        }
        return longest
    }

    /// 105 s covers the intro and a full cycle of the idle look pattern against its gaps.
    @Test func neverStillForASecondWhileVisible() {
        #expect(longestStill(samples(from: 0, to: 105, reduceMotion: false)) < 1.0)
    }

    @Test func reduceMotionKeepsHeadFaceAndBodyStill() {
        let moved = samples(from: 0, to: 60, reduceMotion: true).filter { _, pose in
            [pose.pupilX, pose.pupilY, pose.headRotation, pose.headX, pose.faceX, pose.faceY, pose.lean].contains { $0 != 0 }
        }
        #expect(moved.isEmpty)
    }

    @Test func reduceMotionStillBlinks() {
        let closed = samples(from: 0, to: 10, reduceMotion: true).filter { $0.1.holeRY < 2 }
        #expect(!closed.isEmpty)
    }

    @Test func lookPatternIsDeterministic() {
        let first = (0..<200).map(OwlMotion.idleLook)
        let second = (0..<200).map(OwlMotion.idleLook)
        let poses = stride(from: 0.0, to: 60, by: 0.37).map { OwlMotion.popoverPose(at: $0, reduceMotion: false) }
        let again = stride(from: 0.0, to: 60, by: 0.37).map { OwlMotion.popoverPose(at: $0, reduceMotion: false) }
        #expect(first == second && poses == again)
    }

    @Test func consecutiveIdleLooksChangeDirection() {
        let looks = (0..<200).map(OwlMotion.idleLook)
        let repeats = zip(looks, looks.dropFirst()).filter { $0.dir == $1.dir }
        #expect(repeats.isEmpty && OwlMotion.introLooks.last!.dir != looks[0].dir)
    }

    @Test func idleLookGapsStayWithinCadence() {
        let gaps = OwlMotion.idleLookCadence.gaps
        #expect(gaps.min()! >= 0.8 && gaps.max()! <= 1.5)
    }

    @Test func idleBlinksEveryTwoToThreeSeconds() {
        let gaps = OwlMotion.idleBlinkCadence.gaps.filter { $0 > 1 }
        #expect(gaps.min()! >= 2 && gaps.max()! <= 3)
    }

    @Test func eachIdleEventSettlesBeforeTheNext() {
        let lookSettle = OwlMotion.idleLook(0).settleDuration
        let introEnd = OwlMotion.introLooks.map { $0.time + $0.settleDuration }.max()!
        #expect(OwlMotion.idleLookCadence.gaps.min()! > lookSettle
            && OwlMotion.idleBlinkCadence.gaps.min()! > OwlBlink.settleDuration
            && OwlMotion.idleLookCadence.start > introEnd - lookSettle)
    }

    @Test(arguments: [false, true])
    func windowedPoseMatchesFullHistory(reduceMotion: Bool) {
        let mismatches = stride(from: 0.0, to: 45, by: 0.053).filter { t in
            let windowed = OwlMotion.popoverPose(at: t, reduceMotion: reduceMotion)
            let full = OwlMotion.evaluate(OwlMotion.popoverTweens(at: t, reduceMotion: reduceMotion, fullHistory: true), at: t)
            return !windowed.isClose(to: full, tolerance: 1e-9)
        }
        #expect(mismatches.isEmpty)
    }

    @Test func cadenceLastIndexMatchesLinearScan() {
        let cadence = OwlMotion.idleLookCadence
        let wrong = stride(from: cadence.start, to: cadence.start + 200, by: 0.11).filter { t in
            let expected = (0..<400).last { cadence.time($0) <= t }
            return cadence.lastIndex(atOrBefore: t) != expected
        }
        #expect(wrong.isEmpty)
    }

    @Test func reactionFitsInSixTenthsAndEndsNeutral() {
        let end = OwlMotion.reactionDuration(reduceMotion: false)
        #expect(end <= 0.6 && OwlMotion.reactionPose(at: end, reduceMotion: false) == .neutral)
    }

    @Test func reactionGlancesAndBlinks() {
        let poses = stride(from: 0.0, through: 0.6, by: 1.0 / 120).map { OwlMotion.reactionPose(at: $0, reduceMotion: false) }
        #expect(poses.contains { $0.pupilX > 2 && $0.headRotation > 3 } && poses.contains { $0.holeRY < 2 })
    }

    @Test func reducedReactionOnlyBlinks() {
        let poses = stride(from: 0.0, through: 0.6, by: 1.0 / 120).map { OwlMotion.reactionPose(at: $0, reduceMotion: true) }
        let turned = poses.filter { $0.pupilX != 0 || $0.headRotation != 0 || $0.faceX != 0 || $0.lean != 0 }
        #expect(turned.isEmpty && poses.contains { $0.holeRY < 2 })
    }

    @Test func reactionFramesCoverTheOneShot() {
        let times = OwlMotion.reactionFrameTimes(fps: MenuBarOwlReaction.fps, reduceMotion: false)
        #expect(times.count == 18 && times.last! < OwlMotion.reactionDuration)
    }

    @Test func easesMatchGSAPEndpoints() {
        let eases: [OwlEase] = [.power3Out, .power2In, .power2Out, .sineInOut, .backOut(1.7)]
        #expect(eases.allSatisfy { abs($0(0)) < 1e-12 && abs($0(1) - 1) < 1e-12 })
    }

    @Test func backOutOvershoots() {
        #expect(OwlEase.backOut(1.7)(0.7) > 1)
    }

    @Test @MainActor
    func presenceIsIdleUntilShownAndAfterClose() {
        let presence = OwlPresence()
        let initial = presence.shownAt
        presence.popoverWillShow(at: Date(timeIntervalSince1970: 1))
        let shown = presence.shownAt
        presence.popoverDidClose()
        #expect(initial == nil && shown != nil && presence.shownAt == nil)
    }

    @Test(arguments: [false, true])
    func pausingBetweenMotionsNeverSkipsAChange(reduceMotion: Bool) {
        // Whenever the clock may pause, the pose must hold until the next motion starts.
        let skipped = stride(from: 0.0, to: 60, by: 1.0 / 60).filter { t in
            guard !OwlMotion.isPopoverMoving(at: t, reduceMotion: reduceMotion) else { return false }
            let next = OwlMotion.nextPopoverMotionStart(after: t, reduceMotion: reduceMotion)
            let now = OwlMotion.popoverPose(at: t, reduceMotion: reduceMotion)
            return next <= t || !now.isClose(to: OwlMotion.popoverPose(at: next, reduceMotion: reduceMotion), tolerance: 1e-9)
                || !now.isClose(to: OwlMotion.popoverPose(at: (t + next) / 2, reduceMotion: reduceMotion), tolerance: 1e-9)
        }
        #expect(skipped.isEmpty)
    }

    @Test func idleHasStillStretchesForTheClockToPause() {
        let samples = stride(from: 3.0, to: 60, by: 1.0 / 60).map { OwlMotion.isPopoverMoving(at: $0, reduceMotion: false) }
        let stillFraction = Double(samples.filter { !$0 }.count) / Double(samples.count)
        #expect(stillFraction > 0.1 && stillFraction < 0.6)
    }
}

// MARK: - Popover owl view lifecycle

@Suite("Popover owl view", .serialized)
@MainActor
struct OwlAnimationViewTests {
    private func makeView() -> OwlAnimationView {
        OwlAnimationView(side: 28, color: NSColor(Theme.brandAccent))
    }

    @Test func closedViewSchedulesNothing() {
        let view = makeView()
        view.configure(shownAt: nil, reduceMotion: false, color: NSColor(Theme.brandAccent))
        #expect(!view.hasScheduledWork && view.currentImage != nil)
    }

    @Test func openingStartsTheClock() {
        let view = makeView()
        view.configure(shownAt: Date(), reduceMotion: false, color: NSColor(Theme.brandAccent))
        defer { view.configure(shownAt: nil, reduceMotion: false, color: NSColor(Theme.brandAccent)) }
        #expect(view.hasScheduledWork)
    }

    @Test func clockWaitsForTheIntroThenWakes() async throws {
        let view = makeView()
        view.configure(shownAt: Date(), reduceMotion: false, color: NSColor(Theme.brandAccent))
        defer { view.configure(shownAt: nil, reduceMotion: false, color: NSColor(Theme.brandAccent)) }
        let pausedBeforeIntro = !view.isDeliveringFrames
        let deadline = ContinuousClock.now + .seconds(3)
        while !view.isDeliveringFrames, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(pausedBeforeIntro && view.isDeliveringFrames)
    }

    @Test func closingStopsEverything() {
        let view = makeView()
        let shownAt = Date()
        view.configure(shownAt: shownAt, reduceMotion: false, color: NSColor(Theme.brandAccent))
        view.step(now: shownAt.addingTimeInterval(2.86))
        view.configure(shownAt: nil, reduceMotion: false, color: NSColor(Theme.brandAccent))
        #expect(!view.hasScheduledWork)
    }

    @Test func clockPausesWhileTheOwlHoldsStill() throws {
        let view = makeView()
        let shownAt = Date()
        view.configure(shownAt: shownAt, reduceMotion: false, color: NSColor(Theme.brandAccent))
        defer { view.configure(shownAt: nil, reduceMotion: false, color: NSColor(Theme.brandAccent)) }
        let still = try #require(stride(from: 2.0, to: 4.0, by: 0.01).first { !OwlMotion.isPopoverMoving(at: $0, reduceMotion: false) })
        view.step(now: shownAt.addingTimeInterval(still))
        #expect(!view.isDeliveringFrames && view.hasScheduledWork)
    }

    @Test func clockRunsWhileTheOwlMoves() {
        let view = makeView()
        let shownAt = Date()
        view.configure(shownAt: shownAt, reduceMotion: false, color: NSColor(Theme.brandAccent))
        defer { view.configure(shownAt: nil, reduceMotion: false, color: NSColor(Theme.brandAccent)) }
        view.step(now: shownAt.addingTimeInterval(0.5))
        #expect(view.isDeliveringFrames)
    }

    @Test func closedViewShowsTheNeutralPose() throws {
        let view = makeView()
        let shown = try #require(view.currentImage)
        let expected = try #require(OwlAnimationView.renderImage(pose: .neutral, side: 28, scale: CGFloat(shown.width) / 28, color: NSColor(Theme.brandAccent)))
        #expect(Bitmap(shown).rgba == Bitmap(expected).rgba)
    }
}

// MARK: - Menu bar reaction (one-shot, real run loop)

@MainActor
private final class AppliedFrames {
    var frames: [NSImage?] = []

    /// Waits (bounded) until the static image has been restored, then a little longer so any
    /// stray frame would show up.
    func waitForStaticImage() async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while frames.last.map({ $0 != nil }) ?? true, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        try await Task.sleep(for: .milliseconds(300))
    }
}

@Suite("Menu bar owl reaction", .serialized)
@MainActor
struct MenuBarOwlReactionTests {
    @Test(arguments: [false, true])
    func playsOnceThenRestoresTheStaticImage(reduceMotion: Bool) async throws {
        let reaction = MenuBarOwlReaction()
        let applied = AppliedFrames()
        reaction.play(size: 16, color: NSColor(Theme.brandAccent), reduceMotion: reduceMotion) { applied.frames.append($0) }
        try await applied.waitForStaticImage()
        let expected = OwlMotion.reactionFrameTimes(fps: MenuBarOwlReaction.fps, reduceMotion: reduceMotion).count + 1
        #expect(applied.frames.count == expected && applied.frames.last! == nil && reaction.currentFrame == nil)
    }

    @Test func secondClickRestartsWithoutLeavingAFrameBehind() async throws {
        let reaction = MenuBarOwlReaction()
        let applied = AppliedFrames()
        reaction.play(size: 16, color: NSColor(Theme.brandAccent), reduceMotion: false) { applied.frames.append($0) }
        try await Task.sleep(for: .milliseconds(200))
        reaction.play(size: 16, color: NSColor(Theme.brandAccent), reduceMotion: false) { applied.frames.append($0) }
        try await applied.waitForStaticImage()
        #expect(applied.frames.filter { $0 == nil }.count == 1 && applied.frames.last! == nil && reaction.currentFrame == nil)
    }
}

// MARK: - Rendering (real AppKit and SwiftUI drawing code)

private struct Bitmap {
    let width: Int
    let height: Int
    let rgba: [UInt8]

    init(_ image: CGImage) {
        width = image.width
        height = image.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let ctx = CGContext(
            data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        rgba = data
    }

    /// Alpha at a point in the artwork's 100-unit, y-down space (row 0 is the top).
    func alpha(unitX: Double, unitY: Double) -> Double {
        let x = min(width - 1, Int(unitX / 100 * Double(width)))
        let y = min(height - 1, Int(unitY / 100 * Double(height)))
        return Double(rgba[(y * width + x) * 4 + 3]) / 255
    }

    func pixel(unitX: Double, unitY: Double) -> [UInt8] {
        let x = min(width - 1, Int(unitX / 100 * Double(width)))
        let y = min(height - 1, Int(unitY / 100 * Double(height)))
        let offset = (y * width + x) * 4
        return Array(rgba[offset..<(offset + 4)])
    }

    /// Centroid and count of transparent pixels inside a unit-space box.
    func holes(x: ClosedRange<Double>, y: ClosedRange<Double>) -> (x: Double, y: Double, count: Int) {
        var sx = 0.0, sy = 0.0, n = 0
        for py in 0..<height {
            for px in 0..<width {
                let ux = (Double(px) + 0.5) / Double(width) * 100
                let uy = (Double(py) + 0.5) / Double(height) * 100
                guard x.contains(ux), y.contains(uy), rgba[(py * width + px) * 4 + 3] < 64 else { continue }
                sx += ux; sy += uy; n += 1
            }
        }
        return n == 0 ? (0, 0, 0) : (sx / Double(n), sy / Double(n), n)
    }
}

/// `menuBarImage` is the status-item frame path (`NSImage`); `popoverView` is the bitmap the
/// popover's `OwlAnimationView` puts in its layer.
enum OwlRenderer: String, CaseIterable, CustomTestStringConvertible {
    case menuBarImage, popoverView
    var testDescription: String { rawValue }
}

// Rendering runs off the main actor so these tests never starve the MainActor-bound
// AppStore tests that run in parallel with short sleeps.
private func renderAppKit(_ image: NSImage, points: CGFloat, scale: CGFloat, background: NSColor?) -> CGImage {
    let pixels = Int(points * scale)
    let ctx = CGContext(
        data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    if let background {
        ctx.setFillColor(background.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: pixels, height: pixels))
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
    NSGraphicsContext.restoreGraphicsState()
    return ctx.makeImage()!
}

private func render(_ renderer: OwlRenderer, pose: OwlPose, points: CGFloat, scale: CGFloat, background: Color? = nil) -> CGImage {
    switch renderer {
    case .menuBarImage:
        let image = OwlRig.image(size: points, pose: pose, color: NSColor(Theme.brandAccent), isTemplate: false)
        return renderAppKit(image, points: points, scale: scale, background: background.map { NSColor($0) })
    case .popoverView:
        let owl = OwlAnimationView.renderImage(pose: pose, side: points, scale: scale, color: NSColor(Theme.brandAccent))!
        guard let background else { return owl }
        let ctx = CGContext(
            data: nil, width: owl.width, height: owl.height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        let rect = CGRect(x: 0, y: 0, width: owl.width, height: owl.height)
        ctx.setFillColor(NSColor(background).cgColor)
        ctx.fill(rect)
        ctx.draw(owl, in: rect)
        return ctx.makeImage()!
    }
}

private let lookLeft = OwlMotion.evaluate(OwlLook(time: 0, dir: -1).tweens, at: 2)
private let lookRight = OwlMotion.evaluate(OwlLook(time: 0, dir: 1).tweens, at: 2)
private let tilt = OwlMotion.evaluate(OwlLook(time: 0, dir: 0, tilt: 10).tweens, at: 2)
private let blink = OwlMotion.evaluate(OwlBlink.tweens(at: 0), at: 0.085)
/// Box inside the head that contains the eye holes in every pose (and nothing outside the owl).
private let eyeBoxX = 30.0...70.0
private let eyeBoxY = 28.0...50.0
/// Box around the beak that excludes the eye holes and the outside in every pose.
private let beakBoxX = 36.0...64.0
private let beakBoxY = 52.5...62.0

@Suite("Owl rig rendering", .serialized)
struct OwlRigRenderingTests {
    @Test(arguments: [false, true])
    func approvedPupilDetailsStayContrasting(isDarkOwl: Bool) {
        let color = isDarkOwl ? NSColor.black : NSColor(Theme.brandAccent)
        let x = isDarkOwl ? 36.6 : 38
        let y = isDarkOwl ? 37.0 : 39
        let images = [
            OwlArtwork.image(size: 100, style: .refined_tucked, color: color, isTemplate: false),
            OwlRig.image(size: 100, pose: .neutral, color: color, isTemplate: false),
        ]
        for image in images {
            #expect(!image.isTemplate)
            // A white backdrop catches transparent dots that disappear in a light menu bar.
            let bitmap = Bitmap(renderAppKit(image, points: 100, scale: 3, background: .white))
            for eyeX in [x, x + 24] {
                let pupil = bitmap.pixel(unitX: eyeX, unitY: y)
                #expect(pupil[3] == 255)
                if isDarkOwl {
                    #expect(pupil.prefix(3).allSatisfy { $0 > 245 })
                } else {
                    #expect(pupil.prefix(3).allSatisfy { $0 < 45 })
                }
            }
        }
    }

    @Test(arguments: OwlRenderer.allCases)
    func earsAreAtTheTop(renderer: OwlRenderer) {
        let bitmap = Bitmap(render(renderer, pose: .neutral, points: 100, scale: 2))
        #expect(bitmap.alpha(unitX: 22, unitY: 20) > 0.9 && bitmap.alpha(unitX: 22, unitY: 80) < 0.1)
    }

    @Test(arguments: OwlRenderer.allCases)
    func neutralBeakIsCentred(renderer: OwlRenderer) {
        let beak = Bitmap(render(renderer, pose: .neutral, points: 100, scale: 2)).holes(x: beakBoxX, y: beakBoxY)
        #expect(abs(beak.x - 50) < 0.5)
    }

    @Test(arguments: OwlRenderer.allCases)
    func lookLeftMovesTheFaceLeft(renderer: OwlRenderer) {
        let beak = Bitmap(render(renderer, pose: lookLeft, points: 100, scale: 2)).holes(x: beakBoxX, y: beakBoxY)
        #expect(beak.x < 44)
    }

    @Test(arguments: OwlRenderer.allCases)
    func lookRightMovesTheFaceRight(renderer: OwlRenderer) {
        let beak = Bitmap(render(renderer, pose: lookRight, points: 100, scale: 2)).holes(x: beakBoxX, y: beakBoxY)
        #expect(beak.x > 56)
    }

    @Test(arguments: OwlRenderer.allCases)
    func turnedBeakStaysFullyCutOut(renderer: OwlRenderer) {
        let neutral = Bitmap(render(renderer, pose: .neutral, points: 100, scale: 2)).holes(x: beakBoxX, y: beakBoxY)
        let turned = [lookLeft, lookRight].map { Bitmap(render(renderer, pose: $0, points: 100, scale: 2)).holes(x: beakBoxX, y: beakBoxY) }
        #expect(turned.allSatisfy { abs($0.count - neutral.count) <= neutral.count / 10 })
    }

    @Test(arguments: OwlRenderer.allCases)
    func tiltRaisesTheLeftEye(renderer: OwlRenderer) {
        let bitmap = Bitmap(render(renderer, pose: tilt, points: 100, scale: 2))
        let leftEye = bitmap.holes(x: 30...50, y: eyeBoxY)
        let rightEye = bitmap.holes(x: 50...70, y: eyeBoxY)
        #expect(leftEye.y < rightEye.y - 1)
    }

    @Test(arguments: OwlRenderer.allCases)
    func blinkClosesTheEyes(renderer: OwlRenderer) {
        let open = Bitmap(render(renderer, pose: .neutral, points: 100, scale: 2)).holes(x: eyeBoxX, y: eyeBoxY)
        let closed = Bitmap(render(renderer, pose: blink, points: 100, scale: 2)).holes(x: eyeBoxX, y: eyeBoxY)
        #expect(closed.count < open.count / 4)
    }

    @Test(arguments: OwlRenderer.allCases)
    func neckShowsNoSeamWhileTurned(renderer: OwlRenderer) {
        // Points just inside the silhouette around the neck and shoulders stay solid.
        let points = [(34.0, 60.0), (40.0, 63.0), (50.0, 66.0), (60.0, 63.0), (66.0, 60.0)]
        let gaps = [lookLeft, lookRight, tilt].flatMap { pose in
            let bitmap = Bitmap(render(renderer, pose: pose, points: 100, scale: 2))
            return points.filter { bitmap.alpha(unitX: $0.0, unitY: $0.1) < 0.98 }
        }
        #expect(gaps.isEmpty)
    }

    @Test(arguments: [CGFloat(16), 22, 28, 48])
    func neutralRigMatchesShippedArtwork(points: CGFloat) {
        let shipped = Bitmap(renderAppKit(
            OwlArtwork.image(size: points, style: .refined_tucked, color: NSColor(Theme.brandAccent), isTemplate: false),
            points: points, scale: 2, background: nil))
        let rig = Bitmap(render(.menuBarImage, pose: .neutral, points: points, scale: 2))
        let diffs = (0..<(shipped.width * shipped.height)).map { abs(Int(shipped.rgba[$0 * 4 + 3]) - Int(rig.rgba[$0 * 4 + 3])) }
        #expect(diffs.filter { $0 > 64 }.count <= 2 && Double(diffs.reduce(0, +)) / Double(diffs.count) < 1)
    }

    @Test func popoverViewMatchesMenuBarImage() {
        let image = Bitmap(render(.menuBarImage, pose: tilt, points: 28, scale: 2))
        let view = Bitmap(render(.popoverView, pose: tilt, points: 28, scale: 2))
        let diffs = (0..<(image.width * image.height)).map { abs(Int(image.rgba[$0 * 4 + 3]) - Int(view.rgba[$0 * 4 + 3])) }
        #expect(image.width == view.width && diffs.filter { $0 > 64 }.count <= 4)
    }

    @Test func reactionFramesKeepGoldNonTemplateImages() {
        let frames = MenuBarOwlReaction.frames(size: 16, color: NSColor(Theme.brandAccent), reduceMotion: false)
        #expect(frames.count == 18 && frames.allSatisfy { !$0.isTemplate && $0.size == NSSize(width: 16, height: 16) })
    }

    /// Renders review frames (poses, sizes, the popover intro and the click reaction) as PNGs.
    /// They are kept in OWL_RIG_FRAMES_DIR when it is set, otherwise written to a temporary
    /// folder and removed.
    @Test func exportReviewFrames() throws {
        let keepDir = ProcessInfo.processInfo.environment["OWL_RIG_FRAMES_DIR"]
        let url = keepDir.map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("owl-rig-frames-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        defer { if keepDir == nil { try? FileManager.default.removeItem(at: url) } }
        let popover = Color(red: 0x22 / 255.0, green: 0x1C / 255.0, blue: 0x33 / 255.0)
        let menuBarLight = Color(red: 0xEC / 255.0, green: 0xEC / 255.0, blue: 0xEC / 255.0)
        let poses: [(String, OwlPose)] = [("1-neutral", .neutral), ("2-look-left", lookLeft), ("3-look-right", lookRight), ("4-blink", blink), ("5-tilt", tilt)]
        var written = 0
        for (name, pose) in poses {
            try write(render(.popoverView, pose: pose, points: 200, scale: 2, background: popover), to: url.appendingPathComponent("large-\(name).png"))
            try write(render(.popoverView, pose: pose, points: 28, scale: 2, background: popover), to: url.appendingPathComponent("header28-\(name).png"))
            for points in [CGFloat(16), 22] {
                try write(render(.menuBarImage, pose: pose, points: points, scale: 2, background: popover), to: url.appendingPathComponent("menubar\(Int(points))-dark-\(name).png"))
                try write(render(.menuBarImage, pose: pose, points: points, scale: 2, background: menuBarLight), to: url.appendingPathComponent("menubar\(Int(points))-light-\(name).png"))
            }
            written += 1
        }
        for (index, t) in stride(from: 0.0, through: 6.0, by: 0.1).enumerated() {
            let pose = OwlMotion.popoverPose(at: t, reduceMotion: false)
            try write(render(.popoverView, pose: pose, points: 56, scale: 2, background: popover), to: url.appendingPathComponent(String(format: "seq-popover-%03d.png", index)))
        }
        for (index, t) in OwlMotion.reactionFrameTimes(fps: MenuBarOwlReaction.fps, reduceMotion: false).enumerated() {
            let pose = OwlMotion.reactionPose(at: t, reduceMotion: false)
            try write(render(.menuBarImage, pose: pose, points: 22, scale: 2, background: popover), to: url.appendingPathComponent(String(format: "seq-reaction-%03d.png", index)))
        }
        let pngs = try FileManager.default.contentsOfDirectory(atPath: url.path).filter { $0.hasSuffix(".png") }
        #expect(written == poses.count && pngs.count >= poses.count * 6 + 61 + 18)
    }

    private func write(_ image: CGImage, to url: URL) throws {
        let rep = NSBitmapImageRep(cgImage: image)
        try rep.representation(using: .png, properties: [:])!.write(to: url)
    }
}
