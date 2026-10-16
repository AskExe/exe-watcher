import Foundation

/// Geometry is independent of AppKit so display removal, clamping and snapping are testable.
enum FloatingQuotaPlacement {
    static let inset: CGFloat = 10
    static func railSize(horizontal: Bool, providerCount: Int = 2) -> CGSize {
        let count = max(1, min(6, providerCount))
        return horizontal ? CGSize(width: 248 + count * 64, height: 142)
            : CGSize(width: 176, height: 156 + ((count + 1) / 2) * 82)
    }
    static func clamped(_ frame: CGRect, to screen: CGRect) -> CGRect {
        let width = min(frame.width, max(1, screen.width - 2 * inset))
        let height = min(frame.height, max(1, screen.height - 2 * inset))
        return CGRect(x: min(max(frame.minX, screen.minX + inset), screen.maxX - inset - width),
                      y: min(max(frame.minY, screen.minY + inset), screen.maxY - inset - height),
                      width: width, height: height)
    }
    static func railFrame(position: FloatingQuotaPosition, screen: CGRect, providerCount: Int = 2) -> CGRect {
        let size = railSize(horizontal: position.edge?.horizontal ?? position.horizontal, providerCount: providerCount)
        let x = position.x.isFinite ? min(1, max(0, position.x)) : 1
        let y = position.y.isFinite ? min(1, max(0, position.y)) : 0.72
        var frame = CGRect(x: screen.minX + inset + x * max(0, screen.width - size.width - 2 * inset),
                           y: screen.minY + inset + y * max(0, screen.height - size.height - 2 * inset),
                           width: size.width, height: size.height)
        switch position.edge {
        case .left: frame.origin.x = screen.minX + inset
        case .right: frame.origin.x = screen.maxX - inset - size.width
        case .top: frame.origin.y = screen.maxY - inset - size.height
        case .bottom: frame.origin.y = screen.minY + inset
        case nil: break
        }
        return clamped(frame, to: screen)
    }
    static func position(afterDropping frame: CGRect, screen: CGRect, screenID: String?, providerCount: Int = 2) -> FloatingQuotaPosition {
        let distances: [(FloatingQuotaEdge, CGFloat)] = [
            (.left, abs(frame.minX - screen.minX - inset)),
            (.right, abs(screen.maxX - inset - frame.maxX)),
            (.top, abs(screen.maxY - inset - frame.maxY)),
            (.bottom, abs(frame.minY - screen.minY - inset)),
        ]
        let nearest = distances.min { $0.1 < $1.1 }
        let edge = nearest.flatMap { $0.1 <= 28 ? $0.0 : nil }
        let horizontal = edge?.horizontal ?? (frame.width > frame.height)
        let size = railSize(horizontal: horizontal, providerCount: providerCount)
        let desired = clamped(CGRect(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2,
                                     width: size.width, height: size.height), to: screen)
        return FloatingQuotaPosition(edge: edge, horizontal: horizontal,
            x: Double((desired.minX - screen.minX - inset) / max(1, screen.width - desired.width - 2 * inset)),
            y: Double((desired.minY - screen.minY - inset) / max(1, screen.height - desired.height - 2 * inset)),
            screenID: screenID)
    }
    static func detailFrame(rail: CGRect, size: CGSize, screen: CGRect, edge: FloatingQuotaEdge?) -> CGRect {
        let opensLeft = edge == .right || (edge == nil && rail.midX > screen.midX)
        var origin = CGPoint(x: opensLeft ? rail.minX - size.width - 10 : rail.maxX + 10,
                             y: rail.maxY - size.height)
        if edge == .top || edge == .bottom {
            origin = CGPoint(x: rail.midX - size.width / 2,
                             y: edge == .top ? rail.minY - size.height - 10 : rail.maxY + 10)
        }
        return clamped(CGRect(origin: origin, size: size), to: screen)
    }
}
