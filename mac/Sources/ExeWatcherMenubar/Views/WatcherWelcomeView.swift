import AppKit
import Observation
import SwiftUI

struct UsageSourceCheck: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let sources: Int
    let state: String

    var summary: String {
        switch state {
        case "found": "\(sources) local source\(sources == 1 ? "" : "s") found"
        case "not-found": "No compatible sources discovered"
        default: "Check incomplete · scan again"
        }
    }
}

struct UsageCheckReply: Decodable, Sendable {
    let version: Int
    let providers: [UsageSourceCheck]
}

@MainActor @Observable
final class WatcherWelcomeModel {
    static let completionKey = "watcher.welcome.completed.v1"
    var step = 0
    var checking = false
    var sources: [UsageSourceCheck] = []
    var message = ""
    var copied = false
    private let check: () async throws -> UsageCheckReply

    init(check: @escaping () async throws -> UsageCheckReply = WatcherWelcomeModel.checkLocalSources) {
        self.check = check
    }

    static func needsWelcome(defaults: UserDefaults = .standard) -> Bool {
        !defaults.bool(forKey: completionKey)
    }

    static func complete(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: completionKey)
    }

    static func checkLocalSources() async throws -> UsageCheckReply {
        let runner = CLIProcessRunner(process: ExeWatcherCLI.makeProcess(subcommand: ["doctor", "--json"]), timeout: 60)
        let (data, _, code) = try await runner.run()
        guard code == 0 else { throw DataClientError.nonZeroExit(code: code, stderr: "") }
        let result = try JSONDecoder().decode(UsageCheckReply.self, from: data)
        guard result.version == 1 else { throw DataClientError.decode(CocoaError(.coderReadCorrupt)) }
        return result
    }

    func scan() async {
        guard !checking else { return }
        checking = true
        message = ""
        copied = false
        defer { checking = false }
        do {
            let result = try await check()
            try Task.checkCancellation()
            sources = result.providers
        } catch is CancellationError {
            return
        } catch {
            sources = []
            message = "The source check couldn’t finish. Try Scan again when your Mac is less busy. Your saved totals are kept."
        }
    }

    var agentPrompt: String {
        let command = TerminalLauncher.shellCommand(ExeWatcherCLI.baseArgv())
        let summary = sources.isEmpty ? "The automatic source check did not finish." : sources.map { "\($0.name): \($0.summary)" }.joined(separator: "\n")
        return """
        Help me investigate missing or unexpected Watcher token usage on this Mac.
        Watcher’s automatic source check returned these results.
        \(summary)

        Run \(command) --version and \(command) doctor --json first. Use the CLI bundled in this app so its version matches the dashboard. Inspect the report for the same provider and date range I am comparing. Costs are API-equivalent estimates at available model rates. Check input, output, cache tokens, missing-price warnings, partial history and duplicated or archived sessions separately. For All Time with Claude Code and Codex, verify each provider separately and then All tools. Inspect recoverable Claude lifetime counters and archived Codex sessions, and verify recovery adds only token counters missing from retained logs.

        Check standard and custom log locations, including CLAUDE_CONFIG_DIR, CODEX_HOME and extra Claude profiles configured in Watcher. Finder-launched apps can have different environment variables from Terminal. Confirm the actual retained formats and read permissions before recommending a change. Tell me which sources contain token records and which are missing. Explain whether the issue is source discovery, incomplete logs, pricing, date range or a parser problem.

        Keep the investigation on my Mac. Do not print or upload conversation text, API keys, auth tokens or credential files. Preserve original logs and Watcher’s recorded totals. Do not invent missing token counts or delete caches. Ask me before changing a log location or configuration, and explain what the change would recover.
        """
    }

    func copyAgentPrompt() {
        NSPasteboard.general.clearContents()
        copied = NSPasteboard.general.setString(agentPrompt, forType: .string)
    }
}

@MainActor
enum WatcherWelcomeWindow {
    private static var controller: NSWindowController?
    private static var welcomeModel: WatcherWelcomeModel?
    static var openDashboard: (() -> Void)?

    static func show(step: Int = 0, preview: Bool = false) {
        if controller == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 700),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "Welcome to Watcher"
            window.contentMinSize = NSSize(width: 540, height: 580)
            window.backgroundColor = NSColor(Theme.warmSurfaceDark)
            window.isReleasedWhenClosed = false
            let model = preview ? WatcherWelcomeModel(check: {
                UsageCheckReply(version: 1, providers: [
                    UsageSourceCheck(id: "claude", name: "Claude", sources: 4, state: "found"),
                    UsageSourceCheck(id: "codex", name: "Codex", sources: 0, state: "not-found"),
                ])
            }) : WatcherWelcomeModel()
            welcomeModel = model
            window.contentView = NSHostingView(rootView: WatcherWelcomeView(model: model) {
                if !preview { WatcherWelcomeModel.complete() }
                controller?.close()
                openDashboard?()
            })
            window.center()
            controller = NSWindowController(window: window)
        }
        welcomeModel?.step = min(2, max(0, step))
        controller?.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct WatcherWelcomeView: View {
    @State var model: WatcherWelcomeModel
    let finish: () -> Void

    private let headings = ["Meet your menu bar owl", "Check your usage sources", "Connect your Odd account"]

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(spacing: 12) {
                        OwlIcon(size: 42).foregroundStyle(Theme.brandAccent)
                        Text("WATCHER").font(.system(size: 22, weight: .heavy)).tracking(2).foregroundStyle(Theme.brandWordmark)
                    }
                    Text(headings[model.step])
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .accessibilityAddTraits(.isHeader)
                    if model.step == 0 { introduction }
                    if model.step == 1 { usageCheck }
                    if model.step == 2 { account }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(28)
            }
            Divider().opacity(0.4)
            HStack(spacing: 12) {
                if model.step > 0 {
                    Button("Back") { model.step -= 1 }
                }
                Spacer()
                Button(model.step == 2 ? "Open Watcher" : "Continue") {
                    if model.step == 2 { finish() }
                    else { model.step += 1 }
                }
                .buttonStyle(WatcherAccountButtonStyle(primary: true))
                .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 28).padding(.top, 16)
            HStack {
                Text("Find this guide anytime in Watcher’s Settings.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Image(nsImage: Self.oddMark)
                    .resizable().scaledToFit().frame(width: 32, height: 32)
                    .accessibilityLabel("Odd Community")
            }
            .padding(.horizontal, 28).padding(.vertical, 12)
        }
        .font(.system(size: 14))
        .foregroundStyle(.primary)
        .tint(Theme.brandAccent)
        .buttonStyle(WatcherAccountButtonStyle())
        .background(Theme.warmSurfaceDark)
        .preferredColorScheme(.dark)
        .task(id: model.step) {
            if model.step == 1 { await model.scan() }
        }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 10) {
                Spacer()
                OwlIcon(size: 22).foregroundStyle(Theme.brandAccent)
                Text("$—").font(.codeMono(size: 14, weight: .semibold))
            }
            .padding(14)
            .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
            explanation("Find the yellow owl at the top of your screen", "Click it to open your dashboard. Watcher runs in your Mac’s menu bar.")
            explanation("Your coding tools are detected automatically", "Watcher reads compatible usage logs saved on this Mac. Use your coding tools normally to create new records.")
            explanation("Compare the same period and tool", "Start with Today and All tools. Choose a provider or a longer period when you want to compare its recorded usage.")
            explanation("Give older history time to load", "Large histories can take 10 minutes or more. Progress is saved so the next scan can continue.")
        }
    }

    private var usageCheck: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Watcher checks the same local sources used by the dashboard. Finding a source confirms discovery. Token coverage depends on the records your tools retained.")
                .foregroundStyle(.secondary)
            if model.checking {
                HStack { ProgressView().controlSize(.small); Text("Checking saved usage sources…") }
            }
            ForEach(model.sources) { source in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: source.state == "found" ? "checkmark.circle.fill" : "questionmark.circle")
                        .foregroundStyle(source.state == "found" ? Theme.brandAccent : .secondary)
                    Text(source.name).fontWeight(.semibold)
                    Spacer()
                    Text(source.summary).font(.system(size: 12)).foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
            }
            if !model.message.isEmpty { Text(model.message).foregroundStyle(Theme.semanticWarning) }
            HStack {
                Button("Scan again") { Task { await model.scan() } }.disabled(model.checking)
                Button(model.copied ? "Prompt copied" : "Copy help prompt for Claude or Codex") { model.copyAgentPrompt() }
            }
            .controlSize(.small)
            Divider().opacity(0.4)
            explanation("Understand the totals", "Tokens come from saved tool records. Costs use available API rates and can differ from your subscription bill. Cache reads and writes have their own rates.")
            explanation("When you choose All Time", "Watcher combines retained Claude Code and Codex history. Claude may also retain lifetime token counters after older transcripts disappear. Recovered history is marked incomplete for calls and dates. Codex archives are included when their saved session records are available.")
            explanation("If something is missing", "Open Report and check the same provider and dates. Look for partial history, unreadable files or missing model prices. Unknown prices leave tokens counted while excluding their cost. Copilot records output tokens only, and Cursor Auto uses estimates.")
            Text("If the expected tool has no sources, create a new session and scan again. Custom profiles, another computer or deleted logs can leave gaps. Paste the help prompt into Claude or Codex to investigate locally.")
                .foregroundStyle(.secondary)
            Button("Open full report") { TerminalLauncher.open(subcommand: ["report"]) }
        }
    }

    private var account: some View {
        VStack(alignment: .leading, spacing: 20) {
            explanation("Use the email shown in your Odd account", "Choose Sign in to Odd below, then request and enter the email verification code. You can return through Settings → Odd account & private history…")
            Button("Sign in to Odd") { OddAccountWindow.show() }
            explanation("Local tracking works as soon as logs are available", "You can explore your dashboard while signed out. Cloud backup is unavailable in this build.")
            explanation("Choose what you share", "Settings contains separate controls for basic usage statistics and error diagnostics. Your coding history stays on this Mac.")
            Link("Read the privacy policy", destination: URL(string: "https://odd.community/privacy")!)
                .foregroundStyle(Theme.brandAccent)
        }
    }

    private func explanation(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 15, weight: .semibold))
            Text(text).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    @MainActor private static let oddMark: NSImage = {
        let resources = Bundle.main.resourceURL
            .flatMap { Bundle(url: $0.appendingPathComponent("ExeWatcherMenubar_ExeWatcherMenubar.bundle")) }
            ?? Bundle.module
        return resources.image(forResource: "odd-community-mark") ?? NSImage()
    }()
}
