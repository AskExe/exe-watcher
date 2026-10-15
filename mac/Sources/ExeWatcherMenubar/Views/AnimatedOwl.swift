import AppKit
import Observation
import SwiftUI

/// Whether the popover is on screen. The app delegate sets it from the popover's delegate
/// callbacks; while it is nil no owl animates and no frame work is scheduled.
@MainActor @Observable
final class OwlPresence {
    private(set) var shownAt: Date?

    func popoverWillShow(at date: Date = Date()) { shownAt = date }
    func popoverDidClose() { shownAt = nil }
}

/// The popover owl. When the popover opens it plays the intro (look left, look right, blink,
/// curious tilt, settle) and then idles with small looks and blinks for as long as it stays
/// open. While the popover is closed it shows the static pose and schedules nothing.
struct AnimatedOwl: View {
    let size: CGFloat
    var color: Color = Theme.brandAccent

    @Environment(OwlPresence.self) private var presence: OwlPresence?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        OwlAnimationRepresentable(size: size, color: NSColor(color), shownAt: presence?.shownAt, reduceMotion: reduceMotion)
            .frame(width: size, height: size)
    }
}

private struct OwlAnimationRepresentable: NSViewRepresentable {
    let size: CGFloat
    let color: NSColor
    let shownAt: Date?
    let reduceMotion: Bool

    func makeNSView(context: Context) -> OwlAnimationView {
        OwlAnimationView(side: size, color: color)
    }

    func updateNSView(_ view: OwlAnimationView, context: Context) {
        view.configure(shownAt: shownAt, reduceMotion: reduceMotion, color: color)
    }
}

/// Draws the rig into its layer, one frame per display refresh while the owl is moving.
///
/// Measured in a standalone AppKit harness, this costs about a third of the CPU of a SwiftUI
/// `TimelineView`, and unlike it the cost does not grow with the size of the surrounding
/// popover. The display link exists only while the popover is shown, pauses whenever the owl
/// holds still between motions (resuming at the next look or blink), and is invalidated on close.
@MainActor
final class OwlAnimationView: NSView {
    nonisolated static let maximumFPS: Float = 60

    let side: CGFloat
    private var color: NSColor
    private(set) var shownAt: Date?
    private var reduceMotion = false
    private var link: CADisplayLink?
    private var wakeTask: Task<Void, Never>?
    private var image: CGImage?
    private var renderedPose: OwlPose?
    private var renderedScale: CGFloat = 0

    /// True while any frame work (display link or pending wake-up) is scheduled.
    var hasScheduledWork: Bool { link != nil || wakeTask != nil }
    /// True while the display link is delivering frames.
    var isDeliveringFrames: Bool { link.map { !$0.isPaused } ?? false }
    var currentImage: CGImage? { image }

    init(side: CGFloat, color: NSColor) {
        self.side = side
        self.color = color
        super.init(frame: NSRect(x: 0, y: 0, width: side, height: side))
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        setAccessibilityElement(false)
        show(.neutral)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var intrinsicContentSize: NSSize { NSSize(width: side, height: side) }
    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.contentsGravity = .resizeAspect
        layer?.contentsScale = renderedScale
        layer?.contents = image
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        if let pose = renderedPose { show(pose) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stopClock() } else if shownAt != nil && link == nil { startClock() }
    }

    func configure(shownAt: Date?, reduceMotion: Bool, color: NSColor) {
        if color != self.color {
            self.color = color
            image = nil
            if let pose = renderedPose { show(pose) }
        }
        guard shownAt != self.shownAt || reduceMotion != self.reduceMotion else { return }
        self.shownAt = shownAt
        self.reduceMotion = reduceMotion
        stopClock()
        if shownAt == nil { show(.neutral) } else { startClock() }
    }

    /// Renders the pose at `now` and pauses the clock when the owl holds still.
    func step(now: Date) {
        guard let shownAt else { return }
        let t = max(0, now.timeIntervalSince(shownAt))
        show(OwlMotion.popoverPose(at: t, reduceMotion: reduceMotion))
        wakeTask?.cancel()
        wakeTask = nil
        guard !OwlMotion.isPopoverMoving(at: t, reduceMotion: reduceMotion) else {
            link?.isPaused = false
            return
        }
        link?.isPaused = true
        let delay = OwlMotion.nextPopoverMotionStart(after: t, reduceMotion: reduceMotion) - t
        wakeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.wakeTask = nil
            self.link?.isPaused = false
        }
    }

    private func startClock() {
        guard link == nil, shownAt != nil else { return }
        let link = displayLink(target: self, selector: #selector(tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: Self.maximumFPS, preferred: Self.maximumFPS)
        link.add(to: .main, forMode: .common)
        self.link = link
        step(now: Date())
    }

    private func stopClock() {
        link?.invalidate()
        link = nil
        wakeTask?.cancel()
        wakeTask = nil
    }

    @objc private func tick(_ link: CADisplayLink) {
        step(now: Date())
    }

    private func show(_ pose: OwlPose) {
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        guard pose != renderedPose || scale != renderedScale || image == nil else { return }
        image = Self.renderImage(pose: pose, side: side, scale: scale, color: color)
        renderedPose = pose
        renderedScale = scale
        needsDisplay = true
    }

    /// The bitmap the view shows for a pose: the shared rig drawing at the backing scale.
    nonisolated static func renderImage(pose: OwlPose, side: CGFloat, scale: CGFloat, color: NSColor) -> CGImage? {
        let pixels = Int((side * scale).rounded())
        guard pixels > 0, let ctx = CGContext(
            data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        OwlRig.draw(in: ctx, side: CGFloat(pixels), pose: pose, color: color.cgColor, wings: OwlRig.showsWings(size: side), flipY: true)
        return ctx.makeImage()
    }
}

/// One-shot glance-and-blink of the menu bar owl when it is clicked. It plays a handful of
/// pre-rendered frames and then hands back to the static image; nothing keeps running after it.
@MainActor
final class MenuBarOwlReaction {
    nonisolated static let fps = 30.0

    private struct FramesKey: Hashable {
        let size: CGFloat
        let reduceMotion: Bool
    }

    private var framesCache: [FramesKey: [NSImage]] = [:]
    private var task: Task<Void, Never>?
    /// The frame currently on the status button, or nil when the static image should show.
    private(set) var currentFrame: NSImage?

    nonisolated static func frames(size: CGFloat, color: NSColor, reduceMotion: Bool) -> [NSImage] {
        OwlMotion.reactionFrameTimes(fps: fps, reduceMotion: reduceMotion).map {
            OwlRig.image(size: size, pose: OwlMotion.reactionPose(at: $0, reduceMotion: reduceMotion), color: color, isTemplate: false)
        }
    }

    /// Plays the reaction once. `apply` receives each frame and finally nil (static image).
    func play(size: CGFloat, color: NSColor, reduceMotion: Bool, apply: @escaping @MainActor (NSImage?) -> Void) {
        task?.cancel()
        let key = FramesKey(size: size, reduceMotion: reduceMotion)
        let frames = framesCache[key] ?? Self.frames(size: size, color: color, reduceMotion: reduceMotion)
        framesCache[key] = frames
        let duration = OwlMotion.reactionDuration(reduceMotion: reduceMotion)
        task = Task { @MainActor [weak self] in
            let clock = ContinuousClock()
            let start = clock.now
            for (index, frame) in frames.enumerated() {
                if index > 0 {
                    try? await Task.sleep(until: start + .seconds(Double(index) / Self.fps), clock: clock)
                }
                guard !Task.isCancelled, let self else { return }
                self.currentFrame = frame
                apply(frame)
            }
            try? await Task.sleep(until: start + .seconds(duration), clock: clock)
            guard !Task.isCancelled, let self else { return }
            self.currentFrame = nil
            apply(nil)
        }
    }
}
