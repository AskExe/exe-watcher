import AppKit
import Observation
import SwiftUI

/// Native panel lifecycle. Inspired by CodeBurn's Capacity Dock interaction, implemented
/// against Watcher's existing quota reader. See THIRD_PARTY_NOTICES.md and the backlog.
@MainActor
final class FloatingQuotaController {
    private let store: AppStore
    private let preferences: FloatingQuotaPreferences
    private let preview: Bool
    private let interaction = FloatingQuotaInteraction()
    private var rail: FloatingQuotaPanel?
    private var detail: FloatingQuotaPanel?
    private var refreshingProviders: Set<QuotaProviderID> = []
    private var refreshTask: Task<Void, Never>?
    private var hoverWork: DispatchWorkItem?
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var screenObserver: NSObjectProtocol?
    private var wakeObserver: NSObjectProtocol?
    private var isStarted = false
    private var hoveringRail = false
    private var hoveringDetail = false
    private var dragStart: (mouse: CGPoint, frame: CGRect)?
    private var previewCard: Bool { preview && ProcessInfo.processInfo.arguments.contains("--quota-preview-card") }

    init(store: AppStore, preferences: FloatingQuotaPreferences, preview: Bool = false) {
        self.store = store
        self.preferences = preferences
        self.preview = preview
    }

    func start() {
        guard !isStarted else { return }
        isStarted = true
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.placePanels() }
        }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.placePanels(); self?.restartRefreshLoop() }
        }
        observe()
        synchronize()
    }

    func stop() {
        isStarted = false
        hidePanels()
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
        screenObserver = nil
        wakeObserver = nil
    }

    private func observe() {
        guard isStarted else { return }
        withObservationTracking {
            _ = preferences.isEnabled
            _ = preferences.position
            _ = preferences.horizon
            _ = preferences.timePeriod
            _ = preferences.shownProviders
            _ = preferences.selectedProvider
            _ = store.providerQuotaStates
            _ = store.subscription
            _ = store.subscriptionLoadState
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.isStarted else { return }
                self.synchronize()
                self.observe()
            }
        }
    }

    private func synchronize() {
        guard isStarted, preferences.isEnabled else { hidePanels(); return }
        if rail == nil {
            let panel = FloatingQuotaPanel()
            panel.title = "Watcher floating usage"
            panel.setAccessibilityIdentifier("watcher.floatingQuota.rail")
            panel.contentView = FirstClickHostingView(rootView: FloatingQuotaRail(
                store: store, preferences: preferences, interaction: interaction, preview: preview,
                hover: { [weak self] in self?.hover($0, detail: false) },
                togglePin: { [weak self] in self?.togglePin() },
                drag: { [weak self] in self?.drag($0, point: $1) }))
            rail = panel
            if !previewCard { installEventMonitors() }
        }
        if !interaction.isDragging { placePanels() }
        rail?.orderFrontRegardless()
        if refreshTask == nil || refreshingProviders != preferences.shownProviders { restartRefreshLoop() }
        if !preview {
            Task { [weak self] in
                guard let self else { return }
                await self.store.loadFloatingTimeIfNeeded(for: self.preferences.timePeriod.period)
            }
        }
        if previewCard {
            interaction.isPinned = true
            showDetails()
            rail?.orderOut(nil)
        }
    }

    private func restartRefreshLoop() {
        refreshTask?.cancel()
        refreshTask = nil
        guard isStarted, preferences.isEnabled, !preview else { return }
        refreshingProviders = preferences.shownProviders
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.preferences.isEnabled else { return }
                await self.store.refreshFloatingQuotas(self.preferences.shownProviders)
                guard !Task.isCancelled else { return }
                let delay = max(30, self.store.nextQuotaRefresh(for: self.preferences.shownProviders).timeIntervalSinceNow)
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            }
        }
    }

    private func hidePanels() {
        hoverWork?.cancel()
        hoverWork = nil
        refreshTask?.cancel()
        refreshTask = nil
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        localMonitor = nil
        globalMonitor = nil
        detail?.close()
        rail?.close()
        detail = nil
        rail = nil
        hoveringRail = false
        hoveringDetail = false
        interaction.isExpanded = false
        interaction.isPinned = false
        interaction.isDragging = false
        dragStart = nil
    }

    private func screen(for frame: CGRect? = nil) -> NSScreen? {
        if let frame, let screen = NSScreen.screens.max(by: {
            $0.frame.intersection(frame).area < $1.frame.intersection(frame).area
        }), screen.frame.intersects(frame) { return screen }
        if let id = preferences.position.screenID,
           let saved = NSScreen.screens.first(where: { screenID($0) == id }) { return saved }
        return NSScreen.main ?? NSScreen.screens.first
    }
    private func screenID(_ screen: NSScreen) -> String {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.stringValue ?? "main"
    }
    private func placePanels() {
        guard let rail, let screen = screen() else { return }
        rail.setFrame(FloatingQuotaPlacement.railFrame(position: preferences.position, screen: screen.visibleFrame, providerCount: preferences.shownProviders.count), display: true)
        if interaction.isExpanded { showDetails() }
    }

    private func showDetails() {
        guard let rail, let screen = screen(for: rail.frame), !interaction.isDragging else { return }
        interaction.isExpanded = true
        if detail == nil {
            let panel = FloatingQuotaPanel()
            panel.title = "Watcher usage details"
            panel.setAccessibilityIdentifier("watcher.floatingQuota.details")
            panel.contentView = FirstClickHostingView(rootView: FloatingQuotaDetail(
                store: store, preferences: preferences, interaction: interaction, preview: preview,
                hover: { [weak self] in self?.hover($0, detail: true) },
                togglePin: { [weak self] in self?.togglePin() },
                refresh: { [weak self] in self?.refreshExplicitly() }))
            detail = panel
        }
        let model = store.floatingQuota(for: preferences.activeProvider)
        let extraProviderRow = preferences.shownProviders.count > 3 ? 28 : 0
        let rowsHeight = min(4, model.windows.count) * 64
        let noticesHeight = (model.notes.isEmpty ? 0 : 40) + (model.failed ? 20 : 0)
        let connectionHeight = preferences.activeProvider == .claude && model.windows.isEmpty ? 540 : 460
        let height = max(connectionHeight + extraProviderRow, 340 + extraProviderRow + rowsHeight + noticesHeight)
        let size = CGSize(width: 330, height: CGFloat(height))
        detail?.setFrame(FloatingQuotaPlacement.detailFrame(rail: rail.frame, size: size, screen: screen.visibleFrame, edge: preferences.position.edge), display: true)
        detail?.orderFrontRegardless()
    }

    private func dismissDetails() {
        hoverWork?.cancel()
        hoverWork = nil
        interaction.isPinned = false
        interaction.isExpanded = false
        hoveringDetail = false
        detail?.close()
        detail = nil
    }
    private func togglePin() {
        interaction.isPinned.toggle()
        if interaction.isPinned { hoverWork?.cancel(); showDetails() }
        else if !hoveringRail && !hoveringDetail { dismissDetails() }
    }
    private func hover(_ inside: Bool, detail: Bool) {
        if detail { hoveringDetail = inside } else { hoveringRail = inside }
        hoverWork?.cancel()
        guard !interaction.isDragging else { return }
        if inside {
            let work = DispatchWorkItem { [weak self] in self?.showDetails() }
            hoverWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: work)
        } else if !interaction.isPinned {
            let work = DispatchWorkItem { [weak self] in
                guard let self, !self.hoveringRail, !self.hoveringDetail, !self.interaction.isPinned else { return }
                self.dismissDetails()
            }
            hoverWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
        }
    }
    private func refreshExplicitly() {
        guard !preview else { return }
        Task { [weak self] in
            guard let self else { return }
            await self.store.refreshFloatingQuota(self.preferences.activeProvider, allowKeychainPrompt: true)
            await self.store.loadFloatingTimeIfNeeded(for: self.preferences.timePeriod.period, force: true)
        }
    }

    private func drag(_ phase: FloatingQuotaDragHandle.Phase, point: CGPoint) {
        guard let rail else { return }
        switch phase {
        case .began:
            dragStart = (point, rail.frame)
            dismissDetails()
            interaction.isDragging = true
        case .changed:
            guard let start = dragStart else { return }
            rail.setFrameOrigin(CGPoint(x: start.frame.minX + point.x - start.mouse.x, y: start.frame.minY + point.y - start.mouse.y))
        case .ended:
            guard let start = dragStart else { return }
            rail.setFrameOrigin(CGPoint(x: start.frame.minX + point.x - start.mouse.x, y: start.frame.minY + point.y - start.mouse.y))
            dragStart = nil
            interaction.isDragging = false
            guard let screen = screen(for: rail.frame) else { return }
            preferences.position = FloatingQuotaPlacement.position(afterDropping: rail.frame, screen: screen.visibleFrame, screenID: screenID(screen), providerCount: preferences.shownProviders.count)
            placePanels()
        }
    }

    private func installEventMonitors() {
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .keyDown]
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            self?.handleEvent(event)
            return event
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
            // Global key events are available only when macOS already grants access;
            // outside-click and pin controls never require extra permissions.
            MainActor.assumeIsolated { self?.handleEvent(event) }
        }
    }
    private func handleEvent(_ event: NSEvent) {
        if event.type == .keyDown {
            if event.keyCode == 53 { dismissDetails() }
            return
        }
        let mouse = event.window?.convertPoint(toScreen: event.locationInWindow) ?? event.locationInWindow
        if rail?.frame.contains(mouse) != true && detail?.frame.contains(mouse) != true { dismissDetails() }
    }
}

private extension CGRect {
    var area: CGFloat { isNull ? 0 : width * height }
}

@MainActor
final class FloatingQuotaPanel: NSPanel {
    init() {
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isExcludedFromWindowsMenu = true
        animationBehavior = .none
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
