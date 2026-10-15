// Animated rig for the 01A "refined_tucked" owl, ported from the approved launch-film rig
// (videos/watcher-owl-study). The mark is split at the neck into a BODY and a HEAD so the head
// can really turn; hidden "shoulders" on the body cover the neck while it moves. At the neutral
// pose the rig draws the same silhouette as `OwlArtwork` `.refined_tucked`.
//
// Everything here is pure and deterministic: a pose is a function of elapsed time only, so the
// popover can draw it frame by frame while visible and do nothing while closed.
import AppKit
import CoreGraphics

/// One frame of the rig, in the artwork's 100×100 y-down units (the same space as the SVG).
struct OwlPose: Equatable, Sendable {
    /// Pupil offset relative to the face.
    var pupilX: Double = 0
    var pupilY: Double = 0
    /// Head rotation in degrees around (50, 61); positive is clockwise on screen.
    var headRotation: Double = 0
    var headX: Double = 0
    /// Parallax of the face features (eye holes, beak and pupils) relative to the head.
    var faceX: Double = 0
    var faceY: Double = 0
    /// Whole-owl lean in degrees around (50, 97); positive is clockwise on screen.
    var lean: Double = 0
    /// Vertical radii of the eye holes and pupils; a blink squashes both.
    var holeRY: Double = 12
    var pupilRY: Double = 6

    static let neutral = OwlPose()

    subscript(channel: OwlChannel) -> Double {
        get {
            switch channel {
            case .pupilX: pupilX
            case .pupilY: pupilY
            case .headRotation: headRotation
            case .headX: headX
            case .faceX: faceX
            case .faceY: faceY
            case .lean: lean
            case .holeRY: holeRY
            case .pupilRY: pupilRY
            }
        }
        set {
            switch channel {
            case .pupilX: pupilX = newValue
            case .pupilY: pupilY = newValue
            case .headRotation: headRotation = newValue
            case .headX: headX = newValue
            case .faceX: faceX = newValue
            case .faceY: faceY = newValue
            case .lean: lean = newValue
            case .holeRY: holeRY = newValue
            case .pupilRY: pupilRY = newValue
            }
        }
    }

    func isClose(to other: OwlPose, tolerance: Double = 1e-6) -> Bool {
        OwlChannel.allCases.allSatisfy { abs(self[$0] - other[$0]) <= tolerance }
    }
}

enum OwlChannel: Int, CaseIterable, Sendable {
    case pupilX, pupilY, headRotation, headX, faceX, faceY, lean, holeRY, pupilRY
}

/// The GSAP eases used by the approved rig.
enum OwlEase: Sendable, Equatable {
    case power3Out, power2In, power2Out, sineInOut
    case backOut(Double)

    func callAsFunction(_ p: Double) -> Double {
        switch self {
        case .power3Out: return 1 - pow(1 - p, 4)
        case .power2In: return p * p * p
        case .power2Out: return 1 - pow(1 - p, 3)
        case .sineInOut: return -(cos(Double.pi * p) - 1) / 2
        case .backOut(let s):
            let q = p - 1
            return q * q * ((s + 1) * q + s) + 1
        }
    }
}

/// A GSAP-style `to` tween: it starts from whatever value the channel has when it begins.
struct OwlTween: Sendable, Equatable {
    let channel: OwlChannel
    let start: Double
    let duration: Double
    let target: Double
    let ease: OwlEase

    var end: Double { start + duration }

    func sample(from: Double, at t: Double) -> Double {
        guard duration > 0 else { return t >= start ? target : from }
        let p = min(max((t - start) / duration, 0), 1)
        return from + (target - from) * ease(p)
    }
}

/// A look: pupils dart first (0.12 s), the head snaps round 0.05 s later with face parallax and
/// a slight overshoot, and the whole owl leans after. `dir` runs −1 (left) … +1 (right);
/// `up` is the pupils' vertical offset (positive is down); `tilt` adds a curious head roll.
struct OwlLook: Sendable, Equatable {
    var time: Double
    var dir: Double
    var up: Double = 0
    var tilt: Double = 0
    var snap: Double = 0.34
    var leans = true

    var tweens: [OwlTween] {
        var out = [
            OwlTween(channel: .pupilX, start: time, duration: 0.12, target: dir * 3.2, ease: .power3Out),
            OwlTween(channel: .pupilY, start: time, duration: 0.12, target: up, ease: .power3Out),
            OwlTween(channel: .headRotation, start: time + 0.05, duration: snap, target: dir * 6 + tilt, ease: .backOut(1.7)),
            OwlTween(channel: .headX, start: time + 0.05, duration: snap, target: dir * 2.8, ease: .backOut(1.7)),
            OwlTween(channel: .faceX, start: time + 0.05, duration: snap, target: dir * 5.4, ease: .backOut(1.5)),
            OwlTween(channel: .faceY, start: time + 0.05, duration: snap, target: up * 0.5, ease: .backOut(1.5)),
        ]
        if leans {
            out.append(OwlTween(channel: .lean, start: time + 0.12, duration: 0.6, target: dir * 2.5, ease: .sineInOut))
        }
        return out
    }

    /// Seconds after `time` by which every channel this look drives has reached its target.
    var settleDuration: Double {
        tweens.map(\.end).max().map { $0 - time } ?? 0
    }
}

enum OwlBlink {
    /// Eye holes squash to ry 1.2 and pupils to ry 0 in 0.07 s, then reopen over 0.11 s.
    static func tweens(at t: Double) -> [OwlTween] {
        [
            OwlTween(channel: .holeRY, start: t, duration: 0.07, target: 1.2, ease: .power2In),
            OwlTween(channel: .pupilRY, start: t, duration: 0.07, target: 0, ease: .power2In),
            OwlTween(channel: .holeRY, start: t + 0.1, duration: 0.11, target: 12, ease: .power2Out),
            OwlTween(channel: .pupilRY, start: t + 0.1, duration: 0.11, target: 6, ease: .power2Out),
        ]
    }

    static let settleDuration = 0.21
}

/// Event times that repeat forever from a fixed, cycling list of gaps (no randomness).
struct OwlCadence: Sendable {
    let start: Double
    let gaps: [Double]
    private let prefix: [Double]
    private let period: Double

    init(start: Double, gaps: [Double]) {
        precondition(!gaps.isEmpty && gaps.allSatisfy { $0 > 0 })
        self.start = start
        self.gaps = gaps
        var running = 0.0
        var prefix: [Double] = []
        for gap in gaps { prefix.append(running); running += gap }
        self.prefix = prefix
        self.period = running
    }

    func time(_ k: Int) -> Double {
        start + Double(k / gaps.count) * period + prefix[k % gaps.count]
    }

    /// The last event index whose time is at or before `t`.
    func lastIndex(atOrBefore t: Double) -> Int? {
        guard t >= start else { return nil }
        var k = Int(((t - start) / period).rounded(.down)) * gaps.count
        while time(k + 1) <= t { k += 1 }
        while k > 0 && time(k) > t { k -= 1 }
        return k
    }
}

/// The owl's choreography: an intro when the popover opens, then deterministic idle life.
enum OwlMotion {
    struct Gaze: Sendable, Equatable {
        let dir: Double
        let up: Double
        let tilt: Double
    }

    // MARK: Popover

    /// Intro (≈2.3 s, after the popover's own appear animation): look left, look right, blink,
    /// a curious tilt, then settle facing forward.
    static let introLooks: [OwlLook] = [
        OwlLook(time: 0.25, dir: -1, snap: 0.3),
        OwlLook(time: 0.8, dir: 1, snap: 0.36),
        OwlLook(time: 1.5, dir: 0, tilt: 10),
        OwlLook(time: 2.1, dir: 0, snap: 0.4),
    ]
    static let introBlinks: [Double] = [1.3]

    /// Idle looks: a varied pattern (consecutive directions always differ) walked against a
    /// cycle of 0.8–1.5 s gaps of a different length, so the sequence repeats only every 90 looks.
    static let idleGazes: [Gaze] = [
        Gaze(dir: 0.7, up: 0, tilt: 0),
        Gaze(dir: -0.5, up: -0.6, tilt: 0),
        Gaze(dir: 0.2, up: 0.5, tilt: 0),
        Gaze(dir: 1, up: 0, tilt: 0),
        Gaze(dir: -1, up: -0.4, tilt: 0),
        Gaze(dir: 0, up: 0, tilt: 8),
        Gaze(dir: 0.35, up: 0.8, tilt: 0),
        Gaze(dir: -0.2, up: 0, tilt: 0),
        Gaze(dir: 0.8, up: -0.5, tilt: 0),
        Gaze(dir: 0, up: 0.3, tilt: 0),
    ]
    static let idleLookCadence = OwlCadence(start: 2.9, gaps: [0.9, 1.3, 0.8, 1.15, 1.45, 1.0, 0.85, 1.25, 1.5])
    static let idleSnap = 0.3
    /// Idle blinks every ~2–3 s, with one double blink per cycle.
    static let idleBlinkCadence = OwlCadence(start: 3.5, gaps: [2.4, 2.9, 0.32, 2.2, 2.7, 2.1, 2.6])

    static func idleLook(_ k: Int) -> OwlLook {
        let gaze = idleGazes[k % idleGazes.count]
        return OwlLook(time: idleLookCadence.time(k), dir: gaze.dir, up: gaze.up, tilt: gaze.tilt, snap: idleSnap)
    }

    /// Tweens that determine the popover pose at `t` seconds after it opened. With
    /// `fullHistory` false only the latest idle events are included; that is exact because
    /// each idle event has settled before the next one starts (verified by tests).
    static func popoverTweens(at t: Double, reduceMotion: Bool, fullHistory: Bool = false) -> [OwlTween] {
        var tweens: [OwlTween] = []
        if !reduceMotion {
            tweens += introLooks.flatMap(\.tweens)
            if let k = idleLookCadence.lastIndex(atOrBefore: t) {
                for i in (fullHistory ? 0 : max(0, k - 2))...k { tweens += idleLook(i).tweens }
            }
        }
        tweens += introBlinks.flatMap(OwlBlink.tweens(at:))
        if let k = idleBlinkCadence.lastIndex(atOrBefore: t) {
            for i in (fullHistory ? 0 : max(0, k - 2))...k { tweens += OwlBlink.tweens(at: idleBlinkCadence.time(i)) }
        }
        return tweens
    }

    /// Pose of the popover header owl `t` seconds after the popover opened. Reduce Motion keeps
    /// the head, face and body still and only blinks.
    static func popoverPose(at t: Double, reduceMotion: Bool) -> OwlPose {
        evaluate(popoverTweens(at: t, reduceMotion: reduceMotion), at: t)
    }

    /// Whether the popover pose is changing at `t` (inclusive of each motion's end, so the
    /// settled pose gets drawn). Between motions the owl holds still and needs no frames.
    static func isPopoverMoving(at t: Double, reduceMotion: Bool) -> Bool {
        func within(_ start: Double, _ settle: Double) -> Bool { t >= start && t <= start + settle }
        if !reduceMotion {
            if introLooks.contains(where: { within($0.time, $0.settleDuration) }) { return true }
            if let k = idleLookCadence.lastIndex(atOrBefore: t) {
                let look = idleLook(k)
                if within(look.time, look.settleDuration) { return true }
            }
        }
        if introBlinks.contains(where: { within($0, OwlBlink.settleDuration) }) { return true }
        if let k = idleBlinkCadence.lastIndex(atOrBefore: t), within(idleBlinkCadence.time(k), OwlBlink.settleDuration) {
            return true
        }
        return false
    }

    /// The start of the next look or blink strictly after `t`.
    static func nextPopoverMotionStart(after t: Double, reduceMotion: Bool) -> Double {
        var candidates: [Double] = []
        if !reduceMotion {
            candidates += introLooks.map(\.time).filter { $0 > t }
            candidates.append(idleLookCadence.time(idleLookCadence.lastIndex(atOrBefore: t).map { $0 + 1 } ?? 0))
        }
        candidates += introBlinks.filter { $0 > t }
        candidates.append(idleBlinkCadence.time(idleBlinkCadence.lastIndex(atOrBefore: t).map { $0 + 1 } ?? 0))
        return candidates.filter { $0 > t }.min()!
    }

    // MARK: Menu bar click reaction

    /// A quick glance down toward the popover with a blink, back to the static mark by 0.6 s.
    static let reactionLooks: [OwlLook] = [
        OwlLook(time: 0, dir: 0.8, up: 1.5, snap: 0.2, leans: false),
        OwlLook(time: 0.34, dir: 0, snap: 0.2, leans: false),
    ]
    static let reactionBlinks: [Double] = [0.17]
    static let reactionDuration = 0.6
    static let reducedReactionDuration = 0.24

    static func reactionDuration(reduceMotion: Bool) -> Double {
        reduceMotion ? reducedReactionDuration : reactionDuration
    }

    static func reactionPose(at t: Double, reduceMotion: Bool) -> OwlPose {
        let tweens = reduceMotion
            ? OwlBlink.tweens(at: 0)
            : reactionLooks.flatMap(\.tweens) + reactionBlinks.flatMap(OwlBlink.tweens(at:))
        return evaluate(tweens, at: t)
    }

    /// Frame times for the one-shot menu bar reaction; the static image follows the last one.
    static func reactionFrameTimes(fps: Double, reduceMotion: Bool) -> [Double] {
        let count = Int((reactionDuration(reduceMotion: reduceMotion) * fps).rounded(.up))
        return (0..<count).map { Double($0) / fps }
    }

    // MARK: Evaluation

    /// Evaluates tweens with GSAP timeline semantics: per channel, the most recently started
    /// tween wins and animates from the value the channel had when it started.
    static func evaluate(_ tweens: [OwlTween], at t: Double) -> OwlPose {
        var byChannel = [[OwlTween]](repeating: [], count: OwlChannel.allCases.count)
        for tween in tweens { byChannel[tween.channel.rawValue].append(tween) }
        var pose = OwlPose.neutral
        for channel in OwlChannel.allCases {
            let ordered = byChannel[channel.rawValue].enumerated()
                .sorted { ($0.element.start, $0.offset) < ($1.element.start, $1.offset) }
                .map(\.element)
            var active: OwlTween?
            var activeFrom = OwlPose.neutral[channel]
            for tween in ordered {
                guard tween.start <= t else { break }
                let from = active.map { $0.sample(from: activeFrom, at: tween.start) } ?? OwlPose.neutral[channel]
                active = tween
                activeFrom = from
            }
            if let active { pose[channel] = active.sample(from: activeFrom, at: t) }
        }
        return pose
    }
}

/// Draws the split-neck owl. One drawing path serves the popover owl (`OwlAnimationView`) and
/// the menu bar frames (`NSImage`).
enum OwlRig {
    static func headPath() -> CGPath {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: 17, y: 8))
        p.addQuadCurve(to: CGPoint(x: 33, y: 21), control: CGPoint(x: 26, y: 12))
        p.addQuadCurve(to: CGPoint(x: 67, y: 21), control: CGPoint(x: 50, y: 14))
        p.addQuadCurve(to: CGPoint(x: 83, y: 8), control: CGPoint(x: 74, y: 12))
        p.addLine(to: CGPoint(x: 79, y: 37))
        p.addQuadCurve(to: CGPoint(x: 70, y: 60), control: CGPoint(x: 81, y: 51))
        p.addQuadCurve(to: CGPoint(x: 30, y: 60), control: CGPoint(x: 50, y: 76))
        p.addQuadCurve(to: CGPoint(x: 21, y: 37), control: CGPoint(x: 19, y: 51))
        p.closeSubpath()
        return p
    }

    static func bodyPath() -> CGPath {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: 70, y: 60))
        p.addCurve(to: CGPoint(x: 64, y: 92), control1: CGPoint(x: 80, y: 72), control2: CGPoint(x: 75, y: 87))
        p.addQuadCurve(to: CGPoint(x: 68, y: 97), control: CGPoint(x: 72, y: 94))
        p.addQuadCurve(to: CGPoint(x: 54, y: 95), control: CGPoint(x: 61, y: 100))
        p.addLine(to: CGPoint(x: 46, y: 95))
        p.addQuadCurve(to: CGPoint(x: 32, y: 97), control: CGPoint(x: 39, y: 100))
        p.addQuadCurve(to: CGPoint(x: 36, y: 92), control: CGPoint(x: 28, y: 94))
        p.addCurve(to: CGPoint(x: 30, y: 60), control1: CGPoint(x: 25, y: 87), control2: CGPoint(x: 20, y: 72))
        // Hidden shoulders: rise behind the head at the sides, dip under the beak in the middle.
        p.addQuadCurve(to: CGPoint(x: 37, y: 55), control: CGPoint(x: 31, y: 52))
        p.addQuadCurve(to: CGPoint(x: 50, y: 64), control: CGPoint(x: 44, y: 64))
        p.addQuadCurve(to: CGPoint(x: 63, y: 55), control: CGPoint(x: 56, y: 64))
        p.addQuadCurve(to: CGPoint(x: 70, y: 60), control: CGPoint(x: 69, y: 52))
        p.closeSubpath()
        return p
    }

    static func wingPaths() -> [CGPath] {
        let left = CGMutablePath()
        left.move(to: CGPoint(x: 29, y: 69))
        left.addQuadCurve(to: CGPoint(x: 37, y: 86), control: CGPoint(x: 28, y: 79))
        left.addQuadCurve(to: CGPoint(x: 29, y: 69), control: CGPoint(x: 36, y: 77))
        left.closeSubpath()
        let right = CGMutablePath()
        right.move(to: CGPoint(x: 71, y: 69))
        right.addQuadCurve(to: CGPoint(x: 63, y: 86), control: CGPoint(x: 72, y: 79))
        right.addQuadCurve(to: CGPoint(x: 71, y: 69), control: CGPoint(x: 64, y: 77))
        right.closeSubpath()
        return [left, right]
    }

    static func beakPath() -> CGPath {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: 47, y: 54))
        p.addQuadCurve(to: CGPoint(x: 53, y: 54), control: CGPoint(x: 50, y: 53))
        p.addLine(to: CGPoint(x: 50, y: 61))
        p.closeSubpath()
        return p
    }

    /// Wings are cut out only where they stay legible, matching `OwlArtwork`.
    static func showsWings(size: CGFloat) -> Bool { size >= 24 }

    /// Draws the owl into a `side`×`side` square at the context origin. `flipY` is true for a
    /// y-up context (AppKit images and bitmap contexts); pass false for a y-down context.
    static func draw(in ctx: CGContext, side: CGFloat, pose: OwlPose, color: CGColor, wings: Bool, flipY: Bool) {
        ctx.saveGState()
        defer { ctx.restoreGState() }
        if flipY {
            ctx.translateBy(x: 0, y: side)
            ctx.scaleBy(x: side / 100, y: -side / 100)
        } else {
            ctx.scaleBy(x: side / 100, y: side / 100)
        }

        func rotate(_ degrees: Double, aroundX x: CGFloat, y: CGFloat) {
            ctx.translateBy(x: x, y: y)
            ctx.rotate(by: CGFloat(degrees * Double.pi / 180))
            ctx.translateBy(x: -x, y: -y)
        }
        func fill(_ path: CGPath) {
            ctx.addPath(path)
            ctx.fillPath()
        }
        func ellipse(_ x: CGFloat, _ y: CGFloat, _ rx: CGFloat, _ ry: CGFloat) {
            guard ry > 0 else { return }
            ctx.fillEllipse(in: CGRect(x: x - rx, y: y - ry, width: 2 * rx, height: 2 * ry))
        }

        // The whole owl is one isolated layer so the cut-outs clear only the owl, never the backdrop.
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        ctx.setFillColor(color)
        rotate(pose.lean, aroundX: 50, y: 97)

        // Body first, with the wings cut out.
        fill(bodyPath())
        if wings {
            ctx.setBlendMode(.clear)
            wingPaths().forEach(fill)
            ctx.setBlendMode(.normal)
        }

        // Head on top: rotation around the neck plus a slide.
        ctx.translateBy(x: CGFloat(pose.headX), y: 0)
        rotate(pose.headRotation, aroundX: 50, y: 61)
        fill(headPath())

        // Eye holes and beak after the face parallax. Unlike the SVG study (which masked only the
        // head) they cut through the body too, so a turned head never shows the hidden
        // shoulders through the beak.
        ctx.translateBy(x: CGFloat(pose.faceX), y: CGFloat(pose.faceY))
        ctx.setBlendMode(.clear)
        ellipse(37, 39, 11, CGFloat(pose.holeRY))
        ellipse(63, 39, 11, CGFloat(pose.holeRY))
        fill(beakPath())
        ctx.setBlendMode(.normal)

        // Pupils ride the face parallax plus their own dart.
        ctx.translateBy(x: CGFloat(pose.pupilX), y: CGFloat(pose.pupilY))
        ellipse(38, 39, 4.8, CGFloat(pose.pupilRY))
        ellipse(62, 39, 4.8, CGFloat(pose.pupilRY))

        ctx.endTransparencyLayer()
    }

    /// An AppKit image of one pose, drawn on demand at the destination's resolution.
    static func image(size: CGFloat, pose: OwlPose, color: NSColor, isTemplate: Bool) -> NSImage {
        let wings = showsWings(size: size)
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            draw(in: ctx, side: size, pose: pose, color: color.cgColor, wings: wings, flipY: true)
            return true
        }
        image.isTemplate = isTemplate
        return image
    }
}
