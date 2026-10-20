import AppKit
import SwiftUI

/// Shared artwork for the header mark and the gold macOS menu bar icon.
struct OwlIcon: View {
    let size: CGFloat

    var body: some View {
        Image(nsImage: Self.cachedImage(size: size))
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: size, height: size)
    }

    private static let cacheLock = NSLock()
    private struct CacheKey: Hashable {
        let size: CGFloat
        let menuBar: Bool
    }
    private static var imageCache: [CacheKey: NSImage] = [:]

    static func cachedImage(size: CGFloat, menuBar: Bool = false) -> NSImage {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        let key = CacheKey(size: size, menuBar: menuBar)
        if let cached = imageCache[key] { return cached }
        let image = OwlArtwork.image(
            size: size,
            color: menuBar ? NSColor(Theme.brandAccent) : .black,
            isTemplate: !menuBar
        )
        imageCache[key] = image
        return image
    }
}

/// Popover root. Assembles all sections matching the HTML design spec.
struct MenuBarContent: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            Header()

            Divider()

            if showAgentTabs {
                AgentTabStrip()
                Divider()
            }

            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    HeroSection()
                    Divider().opacity(0.5)
                    PeriodSegmentedControl()
                    Divider().opacity(0.5)
                    if let saved = store.payload.savedHistory {
                        Text(saved.message)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                    }
                    if store.hasCachedData, let error = store.baseLastError {
                        HStack {
                            Text("Update paused. Your saved total is kept.")
                                .help(error)
                            Spacer()
                            Button("Retry update") { Task { await store.refresh(includeOptimize: false) } }
                                .buttonStyle(.borderless)
                        }
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                    }
                    AITimeSection()
                    Divider().opacity(0.5)
                    if isFilteredEmpty {
                        EmptyProviderState(provider: store.selectedProvider, period: store.selectedPeriod)
                    } else {
                        HeatmapSection()
                            .padding(.horizontal, 14)
                            .padding(.top, 10)
                            .padding(.bottom, 10)
                            .zIndex(10)
                        Divider().opacity(0.5)
                        ActivitySection()
                        Divider().opacity(0.5)
                        ModelsSection()
                        Divider().opacity(0.5)
                        AgentsSection()
                        Divider().opacity(0.5)
                        ProjectSpendSection()
                        Divider().opacity(0.5)
                        FindingsSection()
                    }
                }
            }
            .frame(height: 520)
            .overlay {
                if showFirstLoadError {
                    FirstLoadErrorOverlay(
                        periodLabel: store.selectedPeriod.rawValue,
                        message: store.lastError ?? "Unknown error"
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if showInitialLoadingOverlay {
                    BurnLoadingOverlay(periodLabel: store.selectedPeriod.rawValue,
                        recoveryMessage: store.payload.savedHistory?.hasData == false ? store.payload.savedHistory?.message : nil)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .allowsHitTesting(false)
                }
            }

            Divider()

            FooterBar()

            StarBanner()
        }
        .background(Theme.warmSurfaceDark)
    }

    /// True when a specific provider tab is selected and that provider has no spend in the
    /// currently selected period. The .all tab is exempt -- it always shows aggregated data.
    /// Also returns false if data hasn't been fetched yet (payload is empty default),
    /// so we don't flash an empty state while the first fetch is in flight.
    private var isFilteredEmpty: Bool {
        guard store.selectedProvider != .all else { return false }
        let p = store.payload
        // If generated is empty, we haven't fetched yet — don't show empty state
        guard !p.generated.isEmpty else { return false }
        return p.current.cost <= 0 && p.current.calls == 0
    }

    /// Show the tab row whenever the CLI detected at least one AI coding tool installed
    /// on this machine. Hidden only when nothing is detected, which means there's
    /// nothing to filter by anyway.
    private var showAgentTabs: Bool {
        store.showProviderTabs
    }

    private var showInitialLoadingOverlay: Bool {
        if store.payload.savedHistory?.hasData == false { return true }
        guard !store.hasCachedData && store.payload.generated.isEmpty else { return false }
        return store.isCurrentSelectionLoading
    }

    private var showFirstLoadError: Bool {
        guard !store.hasCachedData && store.payload.generated.isEmpty else { return false }
        return !store.isCurrentSelectionLoading && store.lastError != nil
    }
}

private struct EmptyProviderState: View {
    let provider: ProviderFilter
    let period: Period

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "tray")
                .font(.system(size: 26))
                .foregroundStyle(.tertiary)
            Text("No \(provider.rawValue) data for \(periodPhrase)")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    private var periodPhrase: String {
        switch period {
        case .today: "today"
        case .sevenDays: "the last 7 days"
        case .thirtyDays: "the last 30 days"
        case .month: "this month"
        case .all: "all time"
        }
    }
}

/// Translucent overlay that blurs whatever's behind it (the previous tab/period content)
/// and centers an animated owl icon pulsing with the brand palette.
private struct BurnLoadingOverlay: View {
    @Environment(AppStore.self) private var store
    let periodLabel: String
    var recoveryMessage: String? = nil

    private let iconSize: CGFloat = 48

    var body: some View {
        ZStack {
            Rectangle()
                .fill(.ultraThinMaterial)

            VStack(spacing: 14) {
                if recoveryMessage != nil && store.headerStatus == "Recovery paused" {
                    OwlIcon(size: iconSize).opacity(0.82)
                } else {
                    AnimatedOwl(size: iconSize, color: .white)
                        .opacity(0.82)
                        .frame(width: iconSize, height: iconSize)
                }

                Text(recoveryMessage == nil ? "Loading \(periodLabel)…" : "Recovering \(periodLabel)")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(.secondary)
                if let recoveryMessage {
                    Text(recoveryMessage)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)
                }
            }
        }
    }
}

private struct FirstLoadErrorOverlay: View {
    @Environment(AppStore.self) private var store

    let periodLabel: String
    let message: String

    var body: some View {
        ZStack {
            Rectangle()
                .fill(.ultraThinMaterial)

            VStack(spacing: 12) {
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(.orange)

                VStack(spacing: 4) {
                    Text("Couldn't load \(periodLabel)")
                        .font(.system(size: 12, weight: .semibold))
                    Text(message)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(4)
                        .frame(maxWidth: 260)
                }

                Button("Retry") {
                    Task { await store.refresh(includeOptimize: false) }
                }
                .goldButton()
                .controlSize(.small)
            }
            .padding(20)
        }
    }
}

private struct Header: View {
    @Environment(AppStore.self) private var store
    @Environment(UpdateChecker.self) private var updateChecker

    var body: some View {
        HStack {
            HStack(alignment: .center, spacing: 8) {
                AnimatedOwl(size: 28, color: Theme.brandAccent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("WATCHER")
                    .foregroundStyle(Color(red: 0xD4/255.0, green: 0x61/255.0, blue: 0x9C/255.0))
                    .font(.custom("Epilogue", size: 14).weight(.bold))
                    .tracking(2)
                    Text("by EXE")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.brandAccent.opacity(0.6))
                }
                .offset(y: 4)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(store.selectedPeriodSummaryPayload.flatMap { $0.savedHistory?.hasData == false ? nil : $0.current.cost.asCurrency() } ?? "—")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .tracking(-0.5)
                    .foregroundStyle(Theme.brandAccent)
                if let status = store.headerStatus {
                    Text(status)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.orange.opacity(0.8))
                }
                if updateChecker.shouldShowUpdateButton {
                    UpdateBadge()
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }
}

private struct UpdateBadge: View {
    @Environment(UpdateChecker.self) private var updateChecker

    var body: some View {
        VStack(spacing: 2) {
            Button {
                updateChecker.performUpdate()
            } label: {
                HStack(spacing: 4) {
                    if updateChecker.isUpdating {
                        ProgressView()
                            .controlSize(.mini)
                            .scaleEffect(0.7)
                    } else if updateChecker.updateError != nil {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(.orange)
                    } else {
                        Image(systemName: "arrow.down.circle.fill")
                            .font(.system(size: 10))
                    }
                    Text(updateChecker.isUpdating ? "Updating..." : updateChecker.updateError != nil ? "Retry" : "Update Available")
                        .font(.system(size: 10, weight: .medium))
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
            }
            .goldButton()
            .controlSize(.mini)
            .disabled(updateChecker.isUpdating)

            if let error = updateChecker.updateError {
                Text(error)
                    .font(.system(size: 8.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 220, alignment: .trailing)
            }
        }
    }
}

struct FlameMark: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 5)
                .fill(
                    LinearGradient(
                        colors: [Theme.brandAccentDark, Theme.brandEmberDeep],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .shadow(color: .black.opacity(0.2), radius: 1, y: 0.5)
            OwlIcon(size: 12)
                .foregroundStyle(.white)
        }
    }
}

private let starBannerGitHubURL = URL(string: "https://github.com/AskExe/exe-watcher")!

/// Shown at the very bottom on first launch. A small terracotta strip nudges users to star the
/// repo; clicking opens GitHub, clicking the close icon hides it forever (persisted to
/// UserDefaults so it never returns across launches).
struct StarBanner: View {
    @AppStorage("exe-watcher.starBannerDismissed") private var dismissed: Bool = false

    var body: some View {
        if !dismissed {
            HStack(spacing: 8) {
                Image(systemName: "star.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.brandAccent)

                Button {
                    NSWorkspace.shared.open(starBannerGitHubURL)
                } label: {
                    HStack(spacing: 4) {
                        Text("Enjoying Watcher?")
                            .foregroundStyle(.primary)
                        Text("Star us on GitHub")
                            .foregroundStyle(Theme.brandAccent)
                            .underline(true, pattern: .solid)
                    }
                    .font(.system(size: 10.5, weight: .medium))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .noFocusRing()

                Spacer()

                Button {
                    dismissed = true
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .noFocusRing()
                .help("Hide this banner")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Theme.brandAccent.opacity(0.08))
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Color.secondary.opacity(0.18))
                    .frame(height: 0.5)
            }
        }
    }
}

struct FooterBar: View {
    @Environment(AppStore.self) private var store
    @Environment(FloatingQuotaPreferences.self) private var quotaPreferences

    var body: some View {
        HStack(spacing: 6) {
            Menu {
                ForEach(SupportedCurrency.allCases) { currency in
                    Button {
                        applyCurrency(code: currency.rawValue)
                    } label: {
                        if currency.rawValue == store.currency {
                            Label("\(currency.displayName) (\(currency.rawValue))", systemImage: "checkmark")
                        } else {
                            Text("\(currency.displayName) (\(currency.rawValue))")
                        }
                    }
                }
            } label: {
                Label(store.currency, systemImage: "dollarsign.circle")
                    .font(.system(size: 11, weight: .medium))
                    .labelStyle(.titleAndIcon)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()
            .noFocusRing()

            Button {
                Task { await store.refresh(includeOptimize: true) }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .noFocusRing()

            Menu {
                Button("CSV (folder)") { runExport(format: .csv) }
                Button("JSON") { runExport(format: .json) }
            } label: {
                Label("Export", systemImage: "square.and.arrow.down")
                    .font(.system(size: 11, weight: .medium))
                    .labelStyle(.titleAndIcon)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()
            .noFocusRing()

            Menu {
                Toggle("Floating quota display", isOn: Binding(
                    get: { quotaPreferences.isEnabled }, set: { quotaPreferences.isEnabled = $0 }))
                Button("Reset floating display position") { quotaPreferences.resetPosition() }
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 11, weight: .medium))
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .controlSize(.small)
            .help("Display settings")
            .accessibilityLabel("Display settings")

            Spacer()

            Button { openReport() } label: {
                Label("Report", systemImage: "terminal")
                    .font(.system(size: 11, weight: .semibold))
                    .labelStyle(.titleAndIcon)
            }
            .goldButton()
            .controlSize(.small)

            Button { NSApp.terminate(nil) } label: {
                Image(systemName: "power")
                    .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .noFocusRing()
            .help("Quit Watcher")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func openReport() {
        TerminalLauncher.open(subcommand: ["report"])
    }

    private enum ExportFormat {
        case csv, json
        var cliName: String { self == .csv ? "csv" : "json" }
        var suffix: String { self == .csv ? "" : ".json" }
    }

    /// Runs `exe-watcher export` directly into ~/Downloads and reveals the result in Finder. CSV
    /// produces a folder of clean one-table-per-file CSVs; JSON produces a single structured
    /// file. The CLI is spawned with argv (no shell interpretation), so the output path cannot
    /// be abused to inject shell commands even if a pathological value slips through.
    ///
    /// Uses terminationHandler instead of the blocking waitUntilExit() which would freeze
    /// the entire UI if the CLI hangs (same class of bug as the Task.sleep staleness fix).
    private func runExport(format: ExportFormat) {
        let downloads = (NSHomeDirectory() as NSString).appendingPathComponent("Downloads")
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let base = "exe-watcher-\(formatter.string(from: Date()))"
        let outputPath = (downloads as NSString).appendingPathComponent(base + format.suffix)

        let process = ExeWatcherCLI.makeProcess(subcommand: [
            "export", "-f", format.cliName, "-o", outputPath
        ])
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        process.terminationHandler = { finished in
            if finished.terminationStatus == 0 {
                DispatchQueue.main.async {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: outputPath)])
                }
            } else {
                NSLog("Exe Watcher: \(format.cliName.uppercased()) export exited with status \(finished.terminationStatus)")
            }
        }

        do {
            try process.run()
        } catch {
            NSLog("Exe Watcher: \(format.cliName.uppercased()) export failed: \(error)")
        }
    }

    /// Instant-feeling currency switch. Updates the symbol and any cached FX rate on the main
     /// thread right away so the UI redraws the next frame, then fetches a fresh rate in the
     /// background. CLI config is persisted so other exe-watcher commands stay in sync.
    private func applyCurrency(code: String) {
        store.currency = code
        let symbol = CurrencyState.symbolForCode(code)
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

        CLICurrencyConfig.persist(code: code)
    }
}
