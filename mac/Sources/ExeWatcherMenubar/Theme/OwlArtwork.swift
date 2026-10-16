// Generated from assets/owls/marks.json, wing-studies.json and selection.json.
import AppKit

enum OwlStyle: String, CaseIterable {
    case classic, refined, rounded, focus, refined_tucked
    static var selected: OwlStyle {
        OwlStyle(rawValue: ProcessInfo.processInfo.environment["EXE_WATCHER_OWL_STYLE"] ?? "") ?? .refined_tucked
    }
}

enum OwlArtwork {
    static func image(size: CGFloat, style: OwlStyle = .selected, color: NSColor = .black, isTemplate: Bool = true) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.saveGState()
            ctx.translateBy(x: 0, y: size)
            ctx.scaleBy(x: size / 100, y: -size / 100)
            ctx.setFillColor(color.cgColor)
            func ellipse(_ x: CGFloat, _ y: CGFloat, _ rx: CGFloat, _ ry: CGFloat) {
                ctx.fillEllipse(in: CGRect(x: x-rx, y: y-ry, width: 2*rx, height: 2*ry))
            }
            func path(_ build: (CGMutablePath) -> Void) {
                let p = CGMutablePath(); build(p); ctx.addPath(p); ctx.fillPath()
            }
            switch style {
            case .classic:
                path { p in
            p.move(to: CGPoint(x: 26, y: 32))
            p.addLine(to: CGPoint(x: 18, y: 6))
            p.addLine(to: CGPoint(x: 36, y: 26))
            p.closeSubpath()
        }
                path { p in
            p.move(to: CGPoint(x: 74, y: 32))
            p.addLine(to: CGPoint(x: 82, y: 6))
            p.addLine(to: CGPoint(x: 64, y: 26))
            p.closeSubpath()
        }
                ellipse(50, 38, 24, 24)
                ellipse(50, 70, 21, 23)
                ellipse(40, 92, 7, 3.5)
                ellipse(60, 92, 7, 3.5)
                ctx.setBlendMode(.clear)
                ellipse(38, 35, 10, 10)
                ellipse(62, 35, 10, 10)
                path { p in
            p.move(to: CGPoint(x: 46, y: 46))
            p.addLine(to: CGPoint(x: 50, y: 53))
            p.addLine(to: CGPoint(x: 54, y: 46))
            p.closeSubpath()
        }
                ctx.setBlendMode(.normal)
                ellipse(38, 35, 4.5, 4.5)
                ellipse(62, 35, 4.5, 4.5)
            case .refined:
                path { p in
            p.move(to: CGPoint(x: 17, y: 8))
            p.addQuadCurve(to: CGPoint(x: 33, y: 21), control: CGPoint(x: 26, y: 12))
            p.addQuadCurve(to: CGPoint(x: 67, y: 21), control: CGPoint(x: 50, y: 14))
            p.addQuadCurve(to: CGPoint(x: 83, y: 8), control: CGPoint(x: 74, y: 12))
            p.addLine(to: CGPoint(x: 79, y: 37))
            p.addQuadCurve(to: CGPoint(x: 70, y: 60), control: CGPoint(x: 81, y: 51))
            p.addCurve(to: CGPoint(x: 64, y: 92), control1: CGPoint(x: 80, y: 72), control2: CGPoint(x: 75, y: 87))
            p.addQuadCurve(to: CGPoint(x: 68, y: 97), control: CGPoint(x: 72, y: 94))
            p.addQuadCurve(to: CGPoint(x: 54, y: 95), control: CGPoint(x: 61, y: 100))
            p.addLine(to: CGPoint(x: 46, y: 95))
            p.addQuadCurve(to: CGPoint(x: 32, y: 97), control: CGPoint(x: 39, y: 100))
            p.addQuadCurve(to: CGPoint(x: 36, y: 92), control: CGPoint(x: 28, y: 94))
            p.addCurve(to: CGPoint(x: 30, y: 60), control1: CGPoint(x: 25, y: 87), control2: CGPoint(x: 20, y: 72))
            p.addQuadCurve(to: CGPoint(x: 21, y: 37), control: CGPoint(x: 19, y: 51))
            p.closeSubpath()
        }
                ctx.setBlendMode(.clear)
                ellipse(37, 39, 11, 12)
                ellipse(63, 39, 11, 12)
                path { p in
            p.move(to: CGPoint(x: 45, y: 54))
            p.addQuadCurve(to: CGPoint(x: 55, y: 54), control: CGPoint(x: 50, y: 52))
            p.addLine(to: CGPoint(x: 50, y: 61))
            p.closeSubpath()
        }
                if size >= 24 {
                    path { p in
            p.move(to: CGPoint(x: 30, y: 67))
            p.addQuadCurve(to: CGPoint(x: 39, y: 86), control: CGPoint(x: 27, y: 80))
            p.addQuadCurve(to: CGPoint(x: 33, y: 69), control: CGPoint(x: 33, y: 76))
            p.closeSubpath()
        }
                    path { p in
            p.move(to: CGPoint(x: 70, y: 67))
            p.addQuadCurve(to: CGPoint(x: 61, y: 86), control: CGPoint(x: 73, y: 80))
            p.addQuadCurve(to: CGPoint(x: 67, y: 69), control: CGPoint(x: 67, y: 76))
            p.closeSubpath()
        }
                }
                ctx.setBlendMode(.normal)
                ellipse(38, 39, 4.8, 6)
                ellipse(62, 39, 4.8, 6)
            case .rounded:
                path { p in
            p.move(to: CGPoint(x: 14, y: 13))
            p.addQuadCurve(to: CGPoint(x: 33, y: 23), control: CGPoint(x: 25, y: 14))
            p.addQuadCurve(to: CGPoint(x: 67, y: 23), control: CGPoint(x: 50, y: 18))
            p.addQuadCurve(to: CGPoint(x: 86, y: 13), control: CGPoint(x: 75, y: 14))
            p.addLine(to: CGPoint(x: 83, y: 39))
            p.addQuadCurve(to: CGPoint(x: 75, y: 63), control: CGPoint(x: 88, y: 55))
            p.addCurve(to: CGPoint(x: 50, y: 95), control1: CGPoint(x: 82, y: 81), control2: CGPoint(x: 67, y: 95))
            p.addCurve(to: CGPoint(x: 25, y: 63), control1: CGPoint(x: 33, y: 95), control2: CGPoint(x: 18, y: 81))
            p.addQuadCurve(to: CGPoint(x: 17, y: 39), control: CGPoint(x: 12, y: 55))
            p.closeSubpath()
        }
                ellipse(39, 95, 8, 3)
                ellipse(61, 95, 8, 3)
                ctx.setBlendMode(.clear)
                ellipse(35, 43, 12, 12)
                ellipse(65, 43, 12, 12)
                path { p in
            p.move(to: CGPoint(x: 45, y: 58))
            p.addQuadCurve(to: CGPoint(x: 55, y: 58), control: CGPoint(x: 50, y: 56))
            p.addLine(to: CGPoint(x: 50, y: 64))
            p.closeSubpath()
        }
                if size >= 24 {
                    path { p in
            p.move(to: CGPoint(x: 29, y: 68))
            p.addQuadCurve(to: CGPoint(x: 40, y: 86), control: CGPoint(x: 29, y: 81))
            p.addQuadCurve(to: CGPoint(x: 33, y: 68), control: CGPoint(x: 35, y: 76))
            p.closeSubpath()
        }
                    path { p in
            p.move(to: CGPoint(x: 71, y: 68))
            p.addQuadCurve(to: CGPoint(x: 60, y: 86), control: CGPoint(x: 71, y: 81))
            p.addQuadCurve(to: CGPoint(x: 67, y: 68), control: CGPoint(x: 65, y: 76))
            p.closeSubpath()
        }
                }
                ctx.setBlendMode(.normal)
                ellipse(36, 43, 5, 5.8)
                ellipse(64, 43, 5, 5.8)
            case .focus:
                path { p in
            p.move(to: CGPoint(x: 11, y: 13))
            p.addQuadCurve(to: CGPoint(x: 34, y: 27), control: CGPoint(x: 26, y: 16))
            p.addQuadCurve(to: CGPoint(x: 66, y: 27), control: CGPoint(x: 50, y: 21))
            p.addQuadCurve(to: CGPoint(x: 89, y: 13), control: CGPoint(x: 74, y: 16))
            p.addLine(to: CGPoint(x: 86, y: 48))
            p.addCurve(to: CGPoint(x: 50, y: 91), control1: CGPoint(x: 90, y: 69), control2: CGPoint(x: 72, y: 84))
            p.addCurve(to: CGPoint(x: 14, y: 48), control1: CGPoint(x: 28, y: 84), control2: CGPoint(x: 10, y: 69))
            p.closeSubpath()
        }
                ctx.setBlendMode(.clear)
                path { p in
            p.move(to: CGPoint(x: 22, y: 42))
            p.addQuadCurve(to: CGPoint(x: 46, y: 45), control: CGPoint(x: 36, y: 34))
            p.addCurve(to: CGPoint(x: 32, y: 64), control1: CGPoint(x: 49, y: 57), control2: CGPoint(x: 41, y: 66))
            p.addCurve(to: CGPoint(x: 22, y: 42), control1: CGPoint(x: 23, y: 63), control2: CGPoint(x: 19, y: 53))
            p.closeSubpath()
        }
                path { p in
            p.move(to: CGPoint(x: 78, y: 42))
            p.addQuadCurve(to: CGPoint(x: 54, y: 45), control: CGPoint(x: 64, y: 34))
            p.addCurve(to: CGPoint(x: 68, y: 64), control1: CGPoint(x: 51, y: 57), control2: CGPoint(x: 59, y: 66))
            p.addCurve(to: CGPoint(x: 78, y: 42), control1: CGPoint(x: 77, y: 63), control2: CGPoint(x: 81, y: 53))
            p.closeSubpath()
        }
                path { p in
            p.move(to: CGPoint(x: 44, y: 68))
            p.addQuadCurve(to: CGPoint(x: 56, y: 68), control: CGPoint(x: 50, y: 65))
            p.addLine(to: CGPoint(x: 50, y: 77))
            p.closeSubpath()
        }
                ctx.setBlendMode(.normal)
                ellipse(35, 51, 4.8, 6)
                ellipse(65, 51, 4.8, 6)
            case .refined_tucked:
                path { p in
            p.move(to: CGPoint(x: 17, y: 8))
            p.addQuadCurve(to: CGPoint(x: 33, y: 21), control: CGPoint(x: 26, y: 12))
            p.addQuadCurve(to: CGPoint(x: 67, y: 21), control: CGPoint(x: 50, y: 14))
            p.addQuadCurve(to: CGPoint(x: 83, y: 8), control: CGPoint(x: 74, y: 12))
            p.addLine(to: CGPoint(x: 79, y: 37))
            p.addQuadCurve(to: CGPoint(x: 70, y: 60), control: CGPoint(x: 81, y: 51))
            p.addCurve(to: CGPoint(x: 64, y: 92), control1: CGPoint(x: 80, y: 72), control2: CGPoint(x: 75, y: 87))
            p.addQuadCurve(to: CGPoint(x: 68, y: 97), control: CGPoint(x: 72, y: 94))
            p.addQuadCurve(to: CGPoint(x: 54, y: 95), control: CGPoint(x: 61, y: 100))
            p.addLine(to: CGPoint(x: 46, y: 95))
            p.addQuadCurve(to: CGPoint(x: 32, y: 97), control: CGPoint(x: 39, y: 100))
            p.addQuadCurve(to: CGPoint(x: 36, y: 92), control: CGPoint(x: 28, y: 94))
            p.addCurve(to: CGPoint(x: 30, y: 60), control1: CGPoint(x: 25, y: 87), control2: CGPoint(x: 20, y: 72))
            p.addQuadCurve(to: CGPoint(x: 21, y: 37), control: CGPoint(x: 19, y: 51))
            p.closeSubpath()
        }
                ctx.setBlendMode(.clear)
                ellipse(37, 39, 11, 12)
                ellipse(63, 39, 11, 12)
                path { p in
            p.move(to: CGPoint(x: 47, y: 54))
            p.addQuadCurve(to: CGPoint(x: 53, y: 54), control: CGPoint(x: 50, y: 53))
            p.addLine(to: CGPoint(x: 50, y: 61))
            p.closeSubpath()
        }
                if size >= 24 {
                    path { p in
            p.move(to: CGPoint(x: 29, y: 69))
            p.addQuadCurve(to: CGPoint(x: 37, y: 86), control: CGPoint(x: 28, y: 79))
            p.addQuadCurve(to: CGPoint(x: 29, y: 69), control: CGPoint(x: 36, y: 77))
            p.closeSubpath()
        }
                    path { p in
            p.move(to: CGPoint(x: 71, y: 69))
            p.addQuadCurve(to: CGPoint(x: 63, y: 86), control: CGPoint(x: 72, y: 79))
            p.addQuadCurve(to: CGPoint(x: 71, y: 69), control: CGPoint(x: 64, y: 77))
            p.closeSubpath()
        }
                }
                ctx.setBlendMode(.normal)
                ellipse(38, 39, 4.8, 6)
                ellipse(62, 39, 4.8, 6)
                ctx.setBlendMode(.clear)
                ellipse(38, 39, 1.8, 1.8)
                ellipse(62, 39, 1.8, 1.8)
            }
            ctx.restoreGState()
            return true
        }
        image.isTemplate = isTemplate
        return image
    }
}
