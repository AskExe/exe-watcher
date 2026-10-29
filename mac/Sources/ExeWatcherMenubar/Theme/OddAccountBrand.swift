import AppKit
import CoreText
import SwiftUI

/// Canonical Odd Community account identity, shared with odd.community/join.
/// Watcher's owl and menu bar retain their product identity.
enum OddAccountBrand {
    static let background = Color(red: 0x35/255.0, green: 0x5E/255.0, blue: 0xA7/255.0)
    static let glow = Color(red: 0x46/255.0, green: 0x6F/255.0, blue: 0xBA/255.0)
    static let ink = Color(red: 0xF5/255.0, green: 0xF2/255.0, blue: 0xEA/255.0)
    static let muted = Color(red: 0xD0/255.0, green: 0xD9/255.0, blue: 0xE9/255.0)
    static let orange = Color(red: 1, green: 0x62/255.0, blue: 0)
    static let buttonInk = Color(red: 0x17/255.0, green: 0x1A/255.0, blue: 0x22/255.0)
    static let link = Color(red: 1, green: 0xD0/255.0, blue: 0xAD/255.0)

    static let fontNames = ["Satoshi-Regular", "Satoshi-Bold", "Grandstander-SemiBold", "Grandstander-Bold"]
    static let resources = Bundle.main.resourceURL
        .flatMap { Bundle(url: $0.appendingPathComponent("ExeWatcherMenubar_ExeWatcherMenubar.bundle")) }
        ?? Bundle.module

    static func registerFonts() {
        for name in fontNames {
            if let url = resources.url(forResource: name, withExtension: "ttf") {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
    }
    static func body(_ size: CGFloat = 14) -> Font { .custom("Satoshi-Regular", size: size) }
    static func bold(_ size: CGFloat = 14) -> Font { .custom("Satoshi-Bold", size: size) }
    static func heading(_ size: CGFloat = 23) -> Font { .custom("Grandstander-Bold", size: size) }
    static func display(_ size: CGFloat = 35) -> Font { .custom("Grandstander-SemiBold", size: size) }
    static var mark: NSImage? {
        resources.url(forResource: "odd-community-mark", withExtension: "png").flatMap(NSImage.init(contentsOf:))
    }
}

struct OddAccountButtonStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(OddAccountBrand.bold())
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .foregroundStyle(primary ? OddAccountBrand.buttonInk : OddAccountBrand.ink)
            .background(primary ? OddAccountBrand.orange : OddAccountBrand.ink.opacity(configuration.isPressed ? 0.18 : 0.08),
                        in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(primary ? .clear : OddAccountBrand.ink.opacity(0.2)))
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.5)
    }
}

struct OddAccountFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<_Label>) -> some View {
        configuration
            .textFieldStyle(.plain)
            .font(OddAccountBrand.body(15))
            .foregroundStyle(OddAccountBrand.ink)
            .padding(12)
            .background(Color(red: 0x21/255.0, green: 0x46/255.0, blue: 0x81/255.0).opacity(0.4),
                        in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(OddAccountBrand.ink.opacity(0.22)))
    }
}
