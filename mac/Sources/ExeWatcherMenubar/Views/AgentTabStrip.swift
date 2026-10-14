import SwiftUI

struct AgentTabStrip: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 5) {
                ForEach(visibleFilters) { filter in
                    // Deliberately not a SwiftUI Button: AppKit can still draw a blue keyboard
                    // focus ring around focused buttons in menu bar popovers, even with plain
                    // styling. The gold fill is the selected state, so handle taps directly.
                    AgentTab(
                        filter: filter,
                        cost: cost(for: filter),
                        isActive: store.selectedProvider == filter
                    )
                    .onTapGesture {
                        Task { await store.switchTo(provider: filter) }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAddTraits(store.selectedProvider == filter ? .isSelected : [])
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 4)
        }
    }

    /// Drive tab visibility from the selected period's all-provider payload whenever possible.
    /// Never fall back to today's payload here; that makes the tab strip disagree with the
    /// selected period's header whenever a historical fetch is still warming or failed.
    private var tabSourcePayload: MenubarPayload? {
        store.providerTabsPayload
    }

    private var visibleFilters: [ProviderFilter] {
        guard let tabSourcePayload else { return [] }
        // The CLI includes only providers with usage. Free or unpriced models
        // still have real tokens and need a visible detail tab.
        let activeKeys = Set(
            tabSourcePayload.current.providers
                .keys.map { $0.lowercased() }
        )
        let tabs = ProviderFilter.allCases.filter { filter in
            if filter == .all { return true }
            return activeKeys.contains(filter.rawValue.lowercased())
        }
        // If only .all remains (no provider has spend), show just .all without tabs
        return tabs.count > 1 ? tabs : []
    }

    /// Cost for each tab label.
    /// - .all tab: shows the selected period's total cost (reflects period switch)
    /// - Active provider tab: shows the selected-provider payload cost (matches detail view)
    /// - Inactive provider tabs: shows cost from the all-provider payload so amounts stay
    ///   visible even when another provider tab is selected
    private func cost(for filter: ProviderFilter) -> Double? {
        switch filter {
        case .all:
            // "All" always reflects the selected period's grand total
            return store.headerPayload.current.cost
        default:
            let key = filter.rawValue.lowercased()
            // Always look up per-provider cost from the all-provider payload so inactive
            // tabs keep showing their dollar amount regardless of which tab is selected.
            // This also fixes the discrepancy where the active tab's filtered payload could
            // show a different number than the all-provider breakdown.
            return tabSourcePayload?.current.providers[key]
        }
    }
}

private struct AgentTab: View {
    let filter: ProviderFilter
    let cost: Double?
    let isActive: Bool

    /// Dark purple for text on gold backgrounds — darker than brandEmberDeep for better contrast.
    private static let activeTextColor = Color(red: 0x3A/255.0, green: 0x28/255.0, blue: 0x5C/255.0)

    var body: some View {
        HStack(spacing: 5) {
            Text(filter.rawValue)
                .font(.system(size: 11.5, weight: .semibold))
                .tracking(-0.05)
                .foregroundStyle(isActive ? Self.activeTextColor : .secondary)
            if filter != .all, let cost, cost > 0 {
                Text(cost.asCompactCurrency())
                    .font(.codeMono(size: 10.5, weight: .medium))
                    .foregroundStyle(isActive ? Self.activeTextColor : .secondary)
                    .tracking(-0.2)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isActive ? AnyShapeStyle(Theme.brandAccent) : AnyShapeStyle(Color.secondary.opacity(0.08)))
        )
        .contentShape(Rectangle())
    }
}

extension ProviderFilter {
    var color: Color {
        switch self {
        case .all: return Theme.brandAccent
        case .claude: return Theme.categoricalClaude
        case .codex: return Theme.categoricalCodex
        case .cursor: return Theme.categoricalCursor
        case .cursorAgent: return Color(red: 0x8A/255.0, green: 0x6E/255.0, blue: 0xD9/255.0)
        case .copilot: return Color(red: 0x6D/255.0, green: 0x8F/255.0, blue: 0xA6/255.0)
        case .opencode: return Color(red: 0x5B/255.0, green: 0x83/255.0, blue: 0x5B/255.0)
        case .kimi: return Theme.brandAccent
        case .omp: return Color(red: 0xC2/255.0, green: 0x8A/255.0, blue: 0x36/255.0)
        case .pi: return Color(red: 0xB2/255.0, green: 0x6B/255.0, blue: 0x3D/255.0)
        }
    }
}
