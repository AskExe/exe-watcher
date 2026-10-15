import SwiftUI
import AppKit
import Observation
import ServiceManagement
import CoreServices
import os.log

private let wlog = Logger(subsystem: "com.askexe.exe-watcher-menubar", category: "refresh")

/// Keep the always-visible menu bar badge live. This matches the README/product promise and
/// avoids the badge appearing stuck while the popover is closed during active coding sessions.
private let statusItemWidth: CGFloat = NSStatusItem.variableLength
private let popoverWidth: CGFloat = 400
private let popoverHeight: CGFloat = 660

/// Module-level log function — writes to ~/.cache/exe-watcher/refresh.log.
/// Accessible from any file in the module (AppStore, AppDelegate, etc).
/// Must be @MainActor to be callable from @MainActor contexts without suspension.
/// Rotates the log when it exceeds ~500KB: moves to refresh.log.old (keeping one
/// generation of history) and starts fresh. Without rotation the file grows unbounded
/// at ~30 lines per minute during active coding sessions.
private let logRotationBytes = 500 * 1024
@MainActor
func watcherLog(_ message: String) {
    let dir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".cache/exe-watcher")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let logFile = dir.appendingPathComponent("refresh.log")
    let ts = refreshTimeFormatter.string(from: Date())
    let line = "[\(ts)] \(message)\n"
    if let handle = try? FileHandle(forWritingTo: logFile) {
        handle.seekToEndOfFile()
        let size = handle.offsetInFile
        handle.write(Data(line.utf8))
        handle.closeFile()
        if size > logRotationBytes {
            let oldLog = dir.appendingPathComponent("refresh.log.old")
            try? FileManager.default.removeItem(at: oldLog)
            try? FileManager.default.moveItem(at: logFile, to: oldLog)
        }
    } else {
        try? Data(line.utf8).write(to: logFile)
    }
}

private let refreshTimeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss"
    return f
}()
private let menubarTitleFontSize: CGFloat = 13

@main
struct ExeWatcherApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

    var body: some Scene {
        // SwiftUI App needs at least one scene. Settings is invisible by default.
        Settings {
            EmptyView()
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private let store = AppStore(badgeCacheURL: FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".cache/exe-watcher/native-badge.json"))
    let updateChecker = UpdateChecker()
    /// Drives the popover owl: animated only between popoverWillShow and popoverDidClose.
    private let owlPresence = OwlPresence()
    /// One-shot glance-and-blink of the menu bar owl on click.
    private let owlReaction = MenuBarOwlReaction()

    private var usageLogWatcher: UsageLogWatcher?
    private var usageLogDebounceWork: DispatchWorkItem?
    private var healthMonitor: HealthMonitor?
    /// Held for the lifetime of the app to prevent Automatic Termination.
    private var backgroundActivity: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        registerBundledFonts()

        ProcessInfo.processInfo.automaticTerminationSupportEnabled = false
        ProcessInfo.processInfo.disableSuddenTermination()
        backgroundActivity = ProcessInfo.processInfo.beginActivity(
            options: [.automaticTerminationDisabled, .suddenTerminationDisabled],
            reason: "Watcher needs to stay running to update cost display."
        )

        restorePersistedCurrency()
        setupStatusItem()
        setupPopover()
        observeStore()
        loadInitialBadge()
        startUsageLogWatcher()
        setupWakeObservers()
        cleanupLegacyLaunchAgent()
        registerLoginItemIfNeeded()
        Task { await updateChecker.checkIfNeeded() }

        // Telemetry: Perfetto trace writer + self-healing health monitor
        RefreshTracer.shared.initialize()
        let monitor = HealthMonitor(store: store)
        monitor.start()
        healthMonitor = monitor
        store.healthMonitor = monitor
        RefreshTracer.shared.instant(name: "app_launched", category: "lifecycle", tid: .lifecycle)
    }

    private func setupWakeObservers() {
        NotificationCenter.default.addObserver(forName: .NSCalendarDayChanged, object: nil, queue: .main) { [weak self] _ in
            // A calendar notification clears yesterday's visible badge without
            // starting a scheduled scan. New usage or opening the menu hydrates today.
            Task { @MainActor in self?.refreshStatusButton() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.forceRefresh() }
        }

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.screensDidWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.forceRefresh() }
        }

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.sessionDidBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.forceRefresh() }
        }
    }

    /// Removes the legacy LaunchAgent plist that older versions installed. The redundant
    /// system-level timer doubled refresh work and prevented App Nap from throttling the app.
    private func cleanupLegacyLaunchAgent() {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        let destPath = "\(home)/Library/LaunchAgents/com.exe-watcher.refresh.plist"
        guard fm.fileExists(atPath: destPath) else { return }
        let unload = Process()
        unload.launchPath = "/bin/launchctl"
        unload.arguments = ["unload", destPath]
        try? unload.run()
        unload.waitUntilExit()
        try? fm.removeItem(atPath: destPath)
    }

    /// Registers the app as a Login Item so it launches automatically at startup.
    /// Uses SMAppService (macOS 13+). Only registers once — if the user later disables
    /// it via System Settings → General → Login Items, we respect that choice.
    private func registerLoginItemIfNeeded() {
        let service = SMAppService.mainApp
        if service.status == .notRegistered {
            do {
                try service.register()
                NSLog("Exe Watcher: registered as Login Item")
            } catch {
                NSLog("Exe Watcher: Login Item registration failed: \(error)")
            }
        }
    }

    private func forceRefresh() {
        usageLogWatcher?.stop()
        usageLogWatcher = nil
        startUsageLogWatcher()
        RefreshTracer.shared.instant(
            name: "force_refresh", category: "lifecycle", tid: .lifecycle,
            args: ["trigger": .string("system_wake")]
        )
        Task {
            store.recoverFromSystemResume()
            await store.refreshTodayBadge()
            if popover.isShown { await store.refreshVisibleSelection() }
            refreshStatusButton()
        }
    }

    /// Loads the currency code persisted by `exe-watcher currency` so a relaunch picks up where
    /// the user left off. Rate is resolved from the on-disk FX cache if present, otherwise
    /// fetched live in the background.
    private func restorePersistedCurrency() {
        guard let code = CLICurrencyConfig.loadCode(), code != "USD" else { return }
        let symbol = CurrencyState.symbolForCode(code)
        store.currency = code
        let generation = CurrencyState.shared.beginSelection(code: code, symbol: symbol)

        Task {
            let cached = await FXRateCache.shared.cachedRate(for: code)
            await MainActor.run {
                CurrencyState.shared.apply(code: code, rate: cached, symbol: symbol, generation: generation)
            }
            let fresh = await FXRateCache.shared.rate(for: code)
            if let fresh, fresh != cached {
                await MainActor.run {
                    CurrencyState.shared.apply(code: code, rate: fresh, symbol: symbol, generation: generation)
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        healthMonitor?.stop()
        RefreshTracer.shared.instant(name: "app_terminating", category: "lifecycle", tid: .lifecycle)
        RefreshTracer.shared.writeToDisk()
        usageLogDebounceWork?.cancel()
        usageLogWatcher?.stop()
    }

    private func loadInitialBadge() {
        // Initial fetch: update only the always-visible badge. Do not prefetch every period at
        // launch: long historical scans can compete with the badge refresh and make the
        // menubar total look stuck. Historical periods load lazily when selected.
        Task {
            await store.refreshTodayBadge()
            refreshStatusButton()
        }

    }

    /// macOS pushes file-change notifications. There is no periodic usage scan.
    private func startUsageLogWatcher() {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        let environment = ProcessInfo.processInfo.environment
        var additionalClaudeRoots: [String] = []
        let configRoot = environment["XDG_CONFIG_HOME"] ?? "\(home)/.config"
        let configURL = URL(fileURLWithPath: "\(configRoot)/exe-watcher/config.json")
        if let data = try? Data(contentsOf: configURL),
           let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let roots = config["claudeConfigDirs"] as? [String] {
            additionalClaudeRoots = roots
        }
        let roots = UsageLogLocations.roots(home: home, environment: environment, additionalClaudeRoots: additionalClaudeRoots)
        let paths = UsageLogLocations.watchPaths(roots: roots, exists: fm.fileExists(atPath:))
        guard !paths.isEmpty else { return }

        usageLogWatcher = UsageLogWatcher(paths: paths, usageRoots: roots) { [weak self] in
            Task { @MainActor in
                self?.store.noteUsageChange()
                self?.scheduleUsageLogRefresh()
            }
        }
        usageLogWatcher?.start()
    }

    /// Coalesces FSEvents-driven refreshes so a busy transcript directory produces ONE refresh
    /// per quiet/cooldown window instead of back-to-back full refreshes. The previous "throttle"
    /// stamped its cooldown when a refresh STARTED (with a 5s window shorter than the ~7s refresh
    /// and no in-flight guard), so under sustained agent write load it fired continuously —
    /// ~8.6GB of writes in ~10 min. See RefreshCoalescer for the corrected state machine.
    private let refreshCoalescer = RefreshCoalescer(config: .init(minIntervalSeconds: 120, scanRestMultiplier: 9, maxEventRetries: 2))
    private func scheduleUsageLogRefresh() {
        refreshCoalescer.noteEvent(now: Date())
        pumpCoalescer()
    }

    /// Drive the coalescer to its next action. Called on every event and after each refresh
    /// completes. Runs on the main actor (AppDelegate is @MainActor).
    private func pumpCoalescer() {
        switch refreshCoalescer.evaluate(now: Date()) {
        case .idle:
            return
        case .fireNow:
            usageLogDebounceWork?.cancel()
            usageLogDebounceWork = nil
            watcherLog("AUTO coalescer: firing refresh")
            RefreshTracer.shared.instant(name: "automatic_trigger", category: "refresh", tid: .refresh)
            Task { @MainActor [weak self] in
                guard let self else { return }
                let success = await self.performAutomaticRefresh()
                self.refreshCoalescer.refreshDidFinish(now: Date(), success: success)
                self.pumpCoalescer()
            }
        case .wait(let deadline):
            let delay = max(0, deadline.timeIntervalSinceNow)
            usageLogDebounceWork?.cancel()
            let work = DispatchWorkItem { [weak self] in
                self?.usageLogDebounceWork = nil
                self?.pumpCoalescer()
            }
            usageLogDebounceWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }

    private func performAutomaticRefresh() async -> Bool {
        let start = Date()
        watcherLog("REFRESH starting...")
        let success = await store.refreshTodayBadge()
        let elapsed = Date().timeIntervalSince(start)
        let cost = store.todayPayload?.current.cost ?? -1
        watcherLog("REFRESH done in \(String(format: "%.1f", elapsed))s — cost=$\(String(format: "%.2f", cost))")
        refreshStatusButton()
        if popover.isShown {
            let selected = store.selectedPeriod
            if selected != .today {
                await store.refreshQuietly(period: selected)
            }
        }
        return success
    }

    private func observeStore() {
        Task { @MainActor [weak self] in
            while let self {
                await withCheckedContinuation { continuation in
                    withObservationTracking {
                        _ = self.store.payload
                        _ = self.store.todayPayload
                    } onChange: {
                        continuation.resume()
                    }
                }
                self.refreshStatusButton()
            }
        }
    }

    // MARK: - Status Item

    private var isCompact: Bool {
        UserDefaults.standard.bool(forKey: "ExeWatcherMenubarCompact")
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: statusItemWidth)
        guard let button = statusItem.button else { return }
        button.target = self
        button.action = #selector(handleButtonClick(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        refreshStatusButton()
    }

    /// Sets the menubar icon (owl) + cost text. Uses button.image for the icon
    /// and button.attributedTitle for the text — simpler and more reliable than
    /// NSTextAttachment which silently drops custom images.
    private func refreshStatusButton() {
        guard let button = statusItem.button else { return }

        let font = NSFont.monospacedDigitSystemFont(ofSize: menubarTitleFontSize, weight: .medium)

        // Draw the owl programmatically — PDF/SVG template images are unreliable at menubar size.
        // A click reaction in progress keeps its current frame.
        let owlImage: NSImage = owlReaction.currentFrame ?? staticMenuBarOwl

        button.image = owlImage
        button.imagePosition = .imageLeading

        let hasPayload = store.todayPayload != nil
        let compact = isCompact
        // No successful scan for this date means unknown, including day rollover.
        let fallback = compact ? "$-" : "$—"
        let formatted = store.todayPayload?.current.cost
        let valueText = compact
            ? (formatted?.asCompactCurrencyWhole() ?? fallback)
            : (formatted?.asCompactCurrency() ?? fallback)
        let color: NSColor = hasPayload ? .labelColor : .secondaryLabelColor

        button.attributedTitle = NSAttributedString(
            string: valueText,
            attributes: [.font: font, .foregroundColor: color]
        )
        // Force the menu bar to repaint immediately. For accessory apps (LSUIElement), setting
        // needsDisplay + display() only draws into the button's backing store — the system-owned
        // menu bar window won't composite the update until something nudges WindowServer.
        // Toggling the status item length forces a layout pass that makes the fresh content
        // visible without requiring user interaction.
        button.needsDisplay = true
        let currentLength = statusItem.length
        statusItem.length = currentLength == NSStatusItem.variableLength
            ? currentLength : NSStatusItem.variableLength
        statusItem.length = currentLength
        button.display()
    }

    private var menuBarOwlSize: CGFloat { menubarTitleFontSize + 3 }

    private var staticMenuBarOwl: NSImage {
        OwlIcon.cachedImage(size: menuBarOwlSize, menuBar: true)
    }

    /// Quick glance and blink when the menu bar owl is clicked (a blink only with Reduce
    /// Motion). Frames use the same gold, non-template drawing as the static image.
    private func playMenuBarOwlReaction() {
        owlReaction.play(
            size: menuBarOwlSize,
            color: NSColor(Theme.brandAccent),
            reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        ) { [weak self] frame in
            guard let self, let button = self.statusItem.button else { return }
            button.image = frame ?? self.staticMenuBarOwl
            button.needsDisplay = true
            button.display()
        }
    }

    // MARK: - Popover

    private func setupPopover() {
        popover = NSPopover()
        popover.contentSize = NSSize(width: popoverWidth, height: popoverHeight)
        popover.behavior = .transient  // auto-close only on explicit outside click
        popover.animates = true
        popover.delegate = self

        let content = MenuBarContent()
            .environment(store)
            .environment(updateChecker)
            .environment(owlPresence)
            .frame(width: popoverWidth)
            .preferredColorScheme(.dark)

        popover.contentViewController = NSHostingController(rootView: content)
        popover.contentViewController?.view.appearance = NSAppearance(named: .darkAqua)
    }

    @objc private func handleButtonClick(_ sender: AnyObject?) {
        guard let button = statusItem.button else { return }
        playMenuBarOwlReaction()
        if popover.isShown {
            popover.performClose(sender)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    // MARK: - NSPopoverDelegate

    func popoverShouldDetach(_ popover: NSPopover) -> Bool {
        false
    }

    func popoverWillShow(_ notification: Notification) {
        RefreshTracer.shared.instant(name: "popover_open", category: "lifecycle", tid: .lifecycle)
        owlPresence.popoverWillShow()
        Task {
            await store.refreshTodayBadge()
            await store.refreshVisibleSelection()
            refreshStatusButton()
        }
        // Force a fresh update check every time the popover opens, bypassing the 2-day
        // cooldown. The interval is fine for background checks, but when the user actively
        // opens the popover they should see newly available updates immediately.
        Task { await updateChecker.check() }
    }

    func popoverDidClose(_ notification: Notification) {
        RefreshTracer.shared.instant(name: "popover_close", category: "lifecycle", tid: .lifecycle)
        owlPresence.popoverDidClose()
    }

    // MARK: - Font Registration

    /// Register bundled custom fonts (Epilogue) so they're available via Font.custom().
    private func registerBundledFonts() {
        let resourceBundle = Bundle.main.resourceURL
            .flatMap { Bundle(url: $0.appendingPathComponent("ExeWatcherMenubar_ExeWatcherMenubar.bundle")) }
            ?? Bundle.module
        let fontNames = ["Epilogue-Bold"]
        for name in fontNames {
            guard let url = resourceBundle.url(forResource: name, withExtension: "ttf") else {
                NSLog("Exe Watcher: font \(name).ttf not found in bundle")
                continue
            }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

}

private final class UsageLogWatcher: @unchecked Sendable {
    private let paths: [String]
    private let usageRoots: [String]
    private let onChange: @Sendable () -> Void
    private var stream: FSEventStreamRef?

    init(paths: [String], usageRoots: [String], onChange: @escaping @Sendable () -> Void) {
        self.paths = paths
        self.usageRoots = usageRoots
        self.onChange = onChange
    }

    deinit {
        stop()
    }

    func start() {
        guard stream == nil, !paths.isEmpty else { return }

        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )

        let callback: FSEventStreamCallback = { _, info, count, eventPaths, flags, _ in
            guard let info else { return }
            guard count > 0 else { return }
            let watcher = Unmanaged<UsageLogWatcher>.fromOpaque(info).takeUnretainedValue()
            let paths = unsafeBitCast(eventPaths, to: NSArray.self) as? [String] ?? []
            guard (0..<min(count, paths.count)).contains(where: {
                UsageLogLocations.shouldRefresh(path: paths[$0], flags: flags[$0], roots: watcher.usageRoots)
            }) else { return }
            DispatchQueue.main.async {
                watcher.onChange()
            }
        }

        stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            paths as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            1.0,
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot)
        )

        guard let stream else {
            NSLog("Exe Watcher: failed to create usage log watcher")
            return
        }

        FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
        if !FSEventStreamStart(stream) {
            NSLog("Exe Watcher: failed to start usage log watcher")
            stop()
        } else {
            NSLog("Exe Watcher: watching usage logs: \(paths.joined(separator: ", "))")
        }
    }

    func stop() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }
}
