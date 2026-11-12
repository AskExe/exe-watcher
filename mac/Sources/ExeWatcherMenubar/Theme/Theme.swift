import SwiftUI

/// Design tokens — Exe Foundry Bold palette.
/// Gold accent, void/stratum dark surfaces, aura purple highlights.
enum Theme {
    // Brand accent — Exe Gold (#F5D76E)
    static let brandAccent       = Color(red: 0xF5/255.0, green: 0xD7/255.0, blue: 0x6E/255.0)
    static let brandWordmark     = Color(red: 0xD4/255.0, green: 0x61/255.0, blue: 0x9C/255.0)
    // Hover / lighter gold (#FADF85)
    static let brandAccentDark   = Color(red: 0xFA/255.0, green: 0xDF/255.0, blue: 0x85/255.0)
    // Aura purple for depth/glow (#6B4C9A)
    static let brandEmberDeep    = Color(red: 0x6B/255.0, green: 0x4C/255.0, blue: 0x9A/255.0)
    // Dark purple for text on gold backgrounds (#3A285C) — high contrast
    static let brandPurpleDark   = Color(red: 0x3A/255.0, green: 0x28/255.0, blue: 0x5C/255.0)
    // Pressed / darker gold (#E6C54F)
    static let brandEmberGlow    = Color(red: 0xE6/255.0, green: 0xC5/255.0, blue: 0x4F/255.0)

    // Surfaces
    static let warmSurface       = Color(red: 0xFA/255.0, green: 0xF8/255.0, blue: 0xF3/255.0) // light canvas
    static let warmSurfaceDark   = Color(red: 0x1A/255.0, green: 0x15/255.0, blue: 0x28/255.0) // Deep purple canvas

    // Categorical provider colors (distinct hues, good contrast on dark)
    static let categoricalClaude = Color(red: 0xDA/255.0, green: 0x7E/255.0, blue: 0x56/255.0) // Anthropic warm
    static let categoricalCursor = Color(red: 0x3F/255.0, green: 0x6B/255.0, blue: 0x8C/255.0) // Cursor blue
    static let categoricalCodex  = Color(red: 0x4A/255.0, green: 0x7D/255.0, blue: 0x5C/255.0) // Codex green

    // One-shot success rate indicators
    static let oneShotGood  = Color(red: 0x86/255.0, green: 0xEF/255.0, blue: 0xAC/255.0) // success green
    static let oneShotMid   = Color(red: 0xF5/255.0, green: 0x9E/255.0, blue: 0x0B/255.0) // warning orange (not gold)
    static let oneShotLow   = Color(red: 0xF8/255.0, green: 0x71/255.0, blue: 0x71/255.0) // error red

    // Semantic colors — tuned for Exe Foundry Bold dark surfaces.
    static let semanticDanger  = Color(red: 0xDC/255.0, green: 0x26/255.0, blue: 0x26/255.0) // clear red
    static let semanticWarning = Color(red: 0xF5/255.0, green: 0x9E/255.0, blue: 0x0B/255.0) // orange, never gold
    static let semanticSuccess = Color(red: 0x16/255.0, green: 0xA3/255.0, blue: 0x4A/255.0) // confident green
}

extension Font {
    /// SF Mono for currency values -- developer-tool identity.
    static func codeMono(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

/// Modifier for gold-background buttons that need purple text instead of white.
extension View {
    func goldButton() -> some View {
        self
            .buttonStyle(.borderedProminent)
            .tint(Theme.brandAccent)
            .foregroundStyle(Theme.brandPurpleDark)
            .noFocusRing()
    }

    /// Menu bar popovers are pointer-first surfaces. macOS's blue keyboard focus ring
    /// is visually loud against the Watcher dark UI, so controls that remain native
    /// buttons/menus opt out of focus painting here.
    func noFocusRing() -> some View {
        self
            .focusable(false)
            .focusEffectDisabled()
    }
}
