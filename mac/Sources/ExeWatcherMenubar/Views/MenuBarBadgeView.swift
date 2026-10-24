import AppKit
import CoreText

/// One optical center for the owl and the actual text ink, independent of font line padding.
@MainActor
final class MenuBarBadgeView: NSView {
    var text = NSAttributedString(string: "$—") { didSet { needsDisplay = true } }
    var pose = OwlPose.neutral { didSet { needsDisplay = true } }
    static let owlSide: CGFloat = 16
    static let inset: CGFloat = 5
    static let gap: CGFloat = 3

    var requiredWidth: CGFloat {
        ceil(Self.inset * 2 + Self.owlSide + Self.gap + CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(text), nil, nil, nil)))
    }

    // Leave every click and the standard status-button highlight with AppKit.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let line = CTLineCreateWithAttributedString(text)
        let ink = CTLineGetImageBounds(line, ctx)
        ctx.saveGState()
        ctx.textMatrix = .identity
        ctx.textPosition = CGPoint(x: Self.inset + Self.owlSide + Self.gap, y: bounds.midY - ink.midY)
        CTLineDraw(line, ctx)
        ctx.restoreGState()

        ctx.saveGState()
        // The neutral artwork occupies y=8...98 in its 100-unit, y-down canvas.
        // Shift its canvas up by 3% so its visible silhouette shares the text's center.
        ctx.translateBy(x: Self.inset, y: bounds.midY - Self.owlSide / 2 + Self.owlSide * 0.03)
        OwlRig.draw(in: ctx, side: Self.owlSide, pose: pose, color: NSColor(Theme.brandAccent).cgColor,
                    wings: OwlRig.showsWings(size: Self.owlSide), flipY: true)
        ctx.restoreGState()
    }
}

/// Persistent, gentle looks and blinks. No frames are scheduled during still holds,
/// when switched off, or with Reduce Motion. The clock is monotonic across wall-clock changes.
@MainActor
final class MenuBarOwlAnimator {
    nonisolated static let preferenceKey = "WatcherAnimateMenuBarOwl"
    private var task: Task<Void, Never>?
    private(set) var isRunning = false
    private var apply: (@MainActor (OwlPose) -> Void)?

    func configure(enabled: Bool, apply: @escaping @MainActor (OwlPose) -> Void) {
        self.apply = apply
        guard enabled else { stop(); return }
        guard !isRunning else { return }
        isRunning = true
        task = Task { @MainActor [weak self] in
            let clock = ContinuousClock()
            let start = clock.now
            while !Task.isCancelled {
                let elapsed = start.duration(to: clock.now)
                let t = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
                self?.apply?(OwlMotion.popoverPose(at: t, reduceMotion: false))
                let next = OwlMotion.isPopoverMoving(at: t, reduceMotion: false)
                    ? t + 1 / 24 : OwlMotion.nextPopoverMotionStart(after: t, reduceMotion: false)
                do { try await Task.sleep(until: start + .seconds(next), clock: clock) }
                catch { return }
            }
        }
    }

    func stop() {
        task?.cancel(); task = nil; isRunning = false
        apply?(.neutral)
    }

    deinit { task?.cancel() }
}
