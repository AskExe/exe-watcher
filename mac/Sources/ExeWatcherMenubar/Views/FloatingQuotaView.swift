import AppKit
import SwiftUI

@MainActor @Observable
final class FloatingQuotaInteraction {
    var isExpanded = false
    var isPinned = false
    var isDragging = false
}

struct FloatingQuotaRail: View {
    let store: AppStore
    let preferences: FloatingQuotaPreferences
    let interaction: FloatingQuotaInteraction
    let preview: Bool
    let hover: (Bool) -> Void
    let togglePin: () -> Void
    let drag: (FloatingQuotaDragHandle.Phase, CGPoint) -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { clock in
            let horizontal = preferences.position.edge?.horizontal ?? preferences.position.horizontal
            VStack(spacing: 9) {
                HStack(spacing: 5) {
                    OwlIcon(size: 14).foregroundStyle(Theme.brandAccent)
                    Text(preview ? "PREVIEW" : "WATCHER").font(.system(size: 8, weight: .bold)).tracking(1)
                        .foregroundStyle(.secondary)
                    if interaction.isPinned { Image(systemName: "pin.fill").font(.system(size: 8)).foregroundStyle(Theme.brandAccent) }
                    Spacer(minLength: 0)
                    FloatingProviderMenu(preferences: preferences)
                }
                if horizontal {
                    HStack(spacing: 12) {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) { ForEach(preferences.orderedProviders) { tile($0, now: clock.date) } }
                        }.frame(minWidth: 0)
                        Rectangle().fill(.white.opacity(0.1)).frame(width: 1, height: 62)
                        timeSummary.frame(width: 162)
                    }
                } else {
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 9) {
                            ForEach(preferences.orderedProviders) { tile($0, now: clock.date) }
                        }
                    }.frame(maxHeight: CGFloat(((preferences.shownProviders.count + 1) / 2) * 82))
                    Rectangle().fill(.white.opacity(0.1)).frame(height: 1)
                    timeSummary
                }
            }
            .padding(.horizontal, 13).padding(.top, 12).padding(.bottom, 22)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.warmSurfaceDark.gradient)
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(Theme.brandAccent.opacity(0.3), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 22))
            .overlay(alignment: .bottom) {
                FloatingQuotaDragHandle(onDrag: drag).frame(width: 64, height: 18)
                    .accessibilityLabel("Move floating usage display")
            }
            .onHover(perform: hover)
            .accessibilityElement(children: .contain)
            .help("Choose a provider ring to pin its details. Drag the bottom handle to move.")
        }.preferredColorScheme(.dark)
    }

    private var timeSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            Menu {
                Picker("Time period", selection: Binding(get: { preferences.timePeriod }, set: { preferences.timePeriod = $0 })) {
                    ForEach(FloatingTimePeriod.allCases, id: \.self) { Text($0.label).tag($0) }
                }
            } label: { Text(preferences.timePeriod.label).font(.system(size: 10, weight: .semibold)) }
            .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("Choose time period")
            FloatingTimeReadout(time: store.floatingTime(for: preferences.timePeriod.period), compact: true)
        }
    }

    private func tile(_ provider: QuotaProviderID, now: Date) -> some View {
        let quota = store.floatingQuota(for: provider)
        let window = quota.primary(preferences.horizon)
        let expired = window?.expired(at: now) == true
        let value = expired ? nil : window?.percent
        let stale = quota.isStale(at: now)
        return Button {
            if preferences.activeProvider != provider {
                preferences.selectedProvider = provider
                if !interaction.isPinned { togglePin() }
            } else { togglePin() }
        } label: {
            VStack(spacing: 3) {
                Text(provider.name).font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(preferences.activeProvider == provider ? Theme.brandAccent : .secondary)
                ZStack {
                    Circle().stroke(.white.opacity(0.09), lineWidth: 4)
                    if let value {
                        Circle().trim(from: 0, to: value / 100)
                            .stroke(quotaColor(value), style: StrokeStyle(lineWidth: 4, lineCap: .round))
                            .rotationEffect(.degrees(-90)).opacity(stale ? 0.4 : 1)
                    }
                    VStack(spacing: 0) {
                        Text(value.map { "\(Int($0.rounded()))" } ?? "—")
                            .font(.system(size: 17, weight: .semibold, design: .rounded)).monospacedDigit()
                        Text(value == nil ? (quota.isLoading ? "loading" : "usage") : "% used")
                            .font(.system(size: 7, weight: .medium)).foregroundStyle(.secondary)
                    }
                    if stale || expired {
                        Circle().fill(Theme.semanticWarning).frame(width: 6, height: 6).offset(x: 18, y: -18)
                    }
                }.frame(width: 46, height: 46)
                Text(window?.label ?? quota.status(at: now)).font(.system(size: 7))
                    .lineLimit(1).foregroundStyle(.secondary)
            }.frame(width: 56).padding(.vertical, 2).contentShape(Rectangle())
        }.buttonStyle(.plain).noFocusRing()
            .accessibilityLabel("\(preview ? "Preview. " : "")\(quota.provider) \(window?.label ?? "capacity"). \(expired ? "Reset pending" : value.map { "\(Int($0.rounded())) percent used" } ?? quota.status(at: now))")
            .help("Show \(provider.name) usage")
    }
}

struct FloatingProviderMenu: View {
    let preferences: FloatingQuotaPreferences
    var body: some View {
        Menu {
            ForEach(QuotaProviderID.allCases) { provider in
                Toggle(provider.name, isOn: Binding(get: { preferences.shownProviders.contains(provider) },
                    set: { preferences.showProvider(provider, visible: $0) }))
                    .disabled(preferences.shownProviders.count == 1 && preferences.shownProviders.contains(provider))
            }
            Divider()
            Button("Show all providers") { preferences.shownProviders = Set(QuotaProviderID.allCases) }
        } label: { Image(systemName: "slider.horizontal.3").font(.system(size: 10)) }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().noFocusRing()
        .accessibilityLabel("Choose quota providers").help("Choose quota providers")
    }
}

struct FloatingQuotaDetail: View {
    let store: AppStore
    let preferences: FloatingQuotaPreferences
    let interaction: FloatingQuotaInteraction
    let preview: Bool
    let hover: (Bool) -> Void
    let togglePin: () -> Void
    let refresh: () -> Void
    @State private var openingClaudeLogin = false
    @State private var claudeLoginOpened = false
    @State private var claudeLoginFailed = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { clock in
            let quota = store.floatingQuota(for: preferences.activeProvider)
            let stale = quota.isStale(at: clock.date)
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 9) {
                    OwlIcon(size: 26)
                        .foregroundStyle(Theme.brandAccent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(quota.provider) usage").font(.system(size: 15, weight: .semibold))
                        Text(preview ? "Preview · sample data" : (quota.plan ?? "Subscription capacity"))
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    FloatingProviderMenu(preferences: preferences)
                    Button { preferences.isEnabled = false } label: {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                    }.buttonStyle(.plain).foregroundStyle(.secondary).help("Hide floating display")
                        .accessibilityLabel("Hide floating display")
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: min(3, max(1, preferences.shownProviders.count))), spacing: 6) {
                    ForEach(preferences.orderedProviders) { provider in
                        Button(provider.name) { preferences.selectedProvider = provider }
                            .buttonStyle(.plain).noFocusRing().font(.system(size: 10, weight: .semibold))
                            .frame(maxWidth: .infinity).padding(.vertical, 5)
                            .background(preferences.activeProvider == provider ? Theme.brandAccent.opacity(0.18) : .white.opacity(0.05), in: Capsule())
                            .foregroundStyle(preferences.activeProvider == provider ? Theme.brandAccent : .secondary)
                            .accessibilityLabel("Show \(provider.name) usage")
                            .accessibilityAddTraits(preferences.activeProvider == provider ? .isSelected : [])
                    }
                }
                VStack(alignment: .leading, spacing: 9) {
                    Picker("Time period", selection: Binding(get: { preferences.timePeriod }, set: { preferences.timePeriod = $0 })) {
                        ForEach(FloatingTimePeriod.allCases, id: \.self) { Text($0.label).tag($0) }
                    }.pickerStyle(.segmented).labelsHidden().accessibilityLabel("Time period")
                    let time = store.floatingTime(for: preferences.timePeriod.period)
                    FloatingTimeReadout(time: time, compact: false)
                    Text(time == nil ? (store.floatingTimeError ?? "Loading recorded time…") : time?.coverage == "complete" ? "All agents · recorded history" : "All agents · partial timing history")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }
                Rectangle().fill(.white.opacity(0.08)).frame(height: 1)
                HStack(spacing: 6) {
                    Circle().fill(stale || quota.failed ? Theme.semanticWarning : Theme.brandAccent).frame(width: 5, height: 5)
                    Text(quota.status(at: clock.date)).font(.system(size: 10, weight: .medium))
                    Spacer()
                    if quota.windows.contains(where: { $0.id == "fiveHour" }) && quota.windows.contains(where: { $0.id == "weekly" }) {
                        Menu {
                            Picker("Ring shows", selection: Binding(get: { preferences.horizon }, set: { preferences.horizon = $0 })) {
                                ForEach(FloatingQuota.Horizon.allCases, id: \.self) { Text($0.label).tag($0) }
                            }
                        } label: { Text("Ring: \(preferences.horizon.label)").font(.system(size: 10)) }
                        .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("Choose ring window")
                    }
                }.foregroundStyle(stale || quota.failed ? Theme.semanticWarning : .secondary)
                if quota.windows.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(quota.isLoading ? "Checking your capacity…" : quota.isConnected ? "This plan reports no percentage." : "See your limits before the next run.")
                            .font(.system(size: 13, weight: .medium))
                        Text(quota.message ?? (quota.isConnected ? "Any additional allowance details reported by the provider appear below." : quota.providerID.signInHelp))
                            .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        if quota.providerID == .claude && !quota.isLoading && !quota.isConnected {
                            Button {
                                openingClaudeLogin = true
                                Task {
                                    claudeLoginOpened = await TerminalLauncher.openClaudeLogin()
                                    claudeLoginFailed = !claudeLoginOpened
                                    openingClaudeLogin = false
                                }
                            } label: {
                                Label(openingClaudeLogin ? "Opening Claude…" : "Sign in with Claude", systemImage: "person.crop.circle.badge.checkmark")
                                    .font(.system(size: 11, weight: .semibold))
                            }.goldButton().disabled(preview || openingClaudeLogin)
                            if claudeLoginOpened {
                                Text("Finish signing in in your browser, then select Refresh below.")
                                    .font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            }
                            if claudeLoginFailed {
                                Text("Could not open Terminal. Run claude auth login in your terminal, then Refresh here.")
                                    .font(.system(size: 10)).foregroundStyle(Theme.semanticWarning).textSelection(.enabled)
                            }
                        }
                    }.padding(.vertical, 4)
                } else {
                    ScrollView(.vertical) {
                        VStack(spacing: 16) {
                            ForEach(quota.windows) { window in windowRow(window, now: clock.date, stale: stale) }
                        }
                    }.frame(height: CGFloat(min(4, quota.windows.count) * 64 - 16))
                        .id(preferences.activeProvider)
                }
                if !quota.notes.isEmpty {
                    Text(quota.notes.prefix(2).joined(separator: " · "))
                        .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(3)
                }
                Spacer(minLength: 0)
                if stale {
                    Text("Last known usage · retrying later")
                        .font(.system(size: 10)).foregroundStyle(Theme.semanticWarning)
                }
                Rectangle().fill(.white.opacity(0.08)).frame(height: 1)
                HStack {
                    Button(action: togglePin) {
                        Label(interaction.isPinned ? "Pinned" : "Pin", systemImage: interaction.isPinned ? "pin.fill" : "pin")
                    }.buttonStyle(.plain).foregroundStyle(interaction.isPinned ? Theme.brandAccent : .secondary)
                        .accessibilityLabel(interaction.isPinned ? "Unpin usage details" : "Pin usage details")
                    Spacer()
                    Button(action: refresh) {
                        Label(quota.isLoading ? "Updating…" : "Refresh", systemImage: "arrow.clockwise")
                    }.buttonStyle(.plain).foregroundStyle(Theme.brandAccent)
                        .disabled(quota.isLoading || store.quotaRateLimitedUntil(preferences.activeProvider) > clock.date)
                }.font(.system(size: 11, weight: .medium))
            }
            .padding(16)
            .background(Theme.warmSurfaceDark.gradient)
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Theme.brandAccent.opacity(0.2), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .onHover(perform: hover)
        }.preferredColorScheme(.dark)
    }

    private func windowRow(_ window: FloatingQuota.Window, now: Date, stale: Bool) -> some View {
        let expired = window.expired(at: now)
        return VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(window.label).font(.system(size: 12, weight: .medium)).lineLimit(1).help(window.label)
                Spacer()
                Text(expired ? "—" : "\(Int(window.percent.rounded()))%")
                    .font(.system(size: 13, weight: .semibold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(expired ? .secondary : quotaColor(window.percent))
            }
            GeometryReader { bounds in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.07))
                    if !expired { Capsule().fill(quotaColor(window.percent)).frame(width: bounds.size.width * window.fraction) }
                }
            }.frame(height: 5).opacity(stale ? 0.4 : 1)
            Text(FloatingQuota.resetText(window.resetsAt, now: now))
                .font(.system(size: 10)).foregroundStyle(.secondary)
        }
    }
}

private struct FloatingTimeReadout: View {
    let time: TimeBlock?
    let compact: Bool

    var body: some View {
        VStack(spacing: compact ? 5 : 8) {
            row("You + AI ≈", time?.userActiveMs, help: "Estimated time you spend interacting with AI, inferred from short reply-to-next-prompt gaps. Overlapping interactions count once; this does not measure attention.")
            row("AI Time\(time?.estimatedAiMs ?? 0 > 0 ? " ≈" : "")", time?.aiRunningMs, help: "Time AI agents spend working for you, added across all agents. Parallel work can add up to more than the elapsed clock time.")
        }
    }

    private func row(_ label: String, _ milliseconds: Double?, help: String) -> some View {
        HStack(spacing: 5) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text(TimeBlock.duration(milliseconds) == "Unknown" ? "—" : TimeBlock.duration(milliseconds))
                .font(.system(size: compact ? 12 : 15, weight: .semibold, design: .rounded)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.75)
        }.font(.system(size: compact ? 10 : 12))
            .help(help).accessibilityElement(children: .combine).accessibilityHint(help)
    }
}

private func quotaColor(_ percent: Double) -> Color {
    percent >= 95 ? Theme.oneShotLow : percent >= 80 ? Theme.semanticWarning : Theme.brandAccent
}

/// Absolute screen-space deltas avoid the moving-coordinate feedback of a SwiftUI drag.
struct FloatingQuotaDragHandle: View {
    enum Phase { case began, changed, ended }
    let onDrag: (Phase, CGPoint) -> Void
    @State private var dragging = false

    private static var eventScreenPoint: CGPoint {
        guard let event = NSApp.currentEvent else { return NSEvent.mouseLocation }
        return event.window?.convertPoint(toScreen: event.locationInWindow) ?? event.locationInWindow
    }

    var body: some View {
        Capsule().fill(.white.opacity(0.3)).frame(width: 24, height: 2)
            .frame(width: 64, height: 18).contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { value in
                    let mouse = Self.eventScreenPoint
                    if !dragging {
                        dragging = true
                        // SwiftUI's y axis points down; AppKit screen coordinates point up.
                        onDrag(.began, CGPoint(x: mouse.x - value.translation.width, y: mouse.y + value.translation.height))
                    }
                    onDrag(.changed, mouse)
                }
                .onEnded { _ in dragging = false; onDrag(.ended, Self.eventScreenPoint) })
    }
}
