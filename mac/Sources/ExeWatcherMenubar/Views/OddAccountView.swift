import AppKit
import SwiftUI
import Observation

struct OddAccountRequest: Encodable, Sendable {
    var action: String
    var email: String? = nil
    var code: String? = nil
    var phrase: String? = nil
    var confirm: Bool? = nil
    var deviceId: String? = nil
    var month: String? = nil
    var createAccount: Bool? = nil
    var acceptTerms: Bool? = nil
    var acceptVerificationEmail: Bool? = nil
    var acceptEmailCommunications: Bool? = nil
}

struct OddAccountReply: Decodable, Sendable {
    struct Device: Decodable, Identifiable, Sendable {
        var device_id: String
        var updated_at: String
        var id: String { device_id }
    }
    struct History: Decodable, Sendable {
        struct Provider: Decodable, Identifiable, Sendable {
            var provider: String
            var apiEquivalentUSD: Double
            var id: String { provider }
        }
        struct Timing: Decodable, Sendable {
            var aiRunningMs: Double?
            var elapsedBusyMs: Double?
            var estimatedAiMs: Double
        }
        var apiEquivalentUSD: Double
        var calls: Int
        var providers: [Provider]
        var timing: Timing?
        var partial: Bool
        var capturedAt: String
    }
    var ok: Bool
    var message: String?
    var signedIn: Bool?
    var email: String?
    var backupAvailable: Bool?
    var backupEnabled: Bool?
    var lastBackupAt: String?
    var phrase: String?
    var existingPhrase: Bool?
    var accountSwitchRequired: Bool?
    var devices: [Device]?
    var history: History?
}

enum OddAccountClient {
    static func run(_ request: OddAccountRequest) async throws -> OddAccountReply {
        let input = try JSONEncoder().encode(request)
        let runner = CLIProcessRunner(process: ExeWatcherCLI.makeProcess(subcommand: ["account", "--json"]), timeout: 180, input: input)
        let (output, _, _) = try await runner.run()
        return try JSONDecoder().decode(OddAccountReply.self, from: output)
    }
}

@MainActor @Observable
final class OddAccountModel {
    private let runAccountRequest: (OddAccountRequest) async throws -> OddAccountReply

    init(runAccountRequest: @escaping (OddAccountRequest) async throws -> OddAccountReply = OddAccountClient.run) {
        self.runAccountRequest = runAccountRequest
    }

    var isLayoutPreview = false
    static func layoutPreview(_ state: String) -> OddAccountModel {
        let model = OddAccountModel()
        model.isLayoutPreview = true
        if state == "signup" { model.createAccount = true }
        if state == "verification" {
            model.email = "you@example.com"
            model.acceptTerms = true
            model.acceptVerificationEmail = true
            model.codeSent = true
        }
        if state == "recovery" {
            model.signedIn = true; model.backupAvailable = true; model.recoveryOpen = true
            model.email = "you@example.com"
        }
        return model
    }
    var signedIn = false
    var backupAvailable = false
    var backupEnabled = false
    var email = "" {
        didSet {
            guard email != oldValue else { return }
            acceptVerificationEmail = false
            acceptEmailCommunications = false
            codeSent = false
            code = ""
            message = ""
        }
    }
    var code = ""
    var codeSent = false
    var createAccount = false {
        didSet {
            guard createAccount != oldValue else { return }
            restartSignIn()
        }
    }
    var acceptTerms = false
    var acceptVerificationEmail = false
    var acceptEmailCommunications = false
    var phrase = ""
    var generatedPhrase = ""
    var consent = false
    var recoveryOpen = false
    var busy = false
    var message = ""
    var history: OddAccountReply.History?
    var devices: [OddAccountReply.Device] = []
    var selectedDevice = "local"
    var month = ""
    var lastBackupAt: String?

    private var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedCode: String { code.trimmingCharacters(in: .whitespacesAndNewlines) }
    var canRequestCode: Bool {
        !signedIn && !busy && acceptTerms && acceptVerificationEmail &&
            trimmedEmail.utf16.count <= 254 &&
            trimmedEmail.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
    }
    var canVerifyCode: Bool {
        !signedIn && !busy && codeSent && (6...10).contains(trimmedCode.count) &&
            trimmedCode.allSatisfy { $0.isASCII && $0.isNumber }
    }

    func requestCode() async {
        guard canRequestCode else { return }
        await perform(.init(action: "requestCode", email: trimmedEmail, createAccount: createAccount,
                            acceptTerms: acceptTerms, acceptVerificationEmail: acceptVerificationEmail))
    }

    func verifyCode() async {
        guard canVerifyCode else { return }
        await perform(.init(action: "verifyCode", email: trimmedEmail, code: trimmedCode,
                            acceptEmailCommunications: acceptEmailCommunications))
    }

    func restartSignIn() {
        codeSent = false
        code = ""
        acceptTerms = false
        acceptVerificationEmail = false
        acceptEmailCommunications = false
        message = ""
    }

    func perform(_ request: OddAccountRequest) async {
        guard !isLayoutPreview else { return }
        guard !busy else { return }
        busy = true; message = ""
        defer { busy = false }
        do {
            let result = try await runAccountRequest(request)
            guard result.ok else { message = result.message ?? "Please try again."; return }
            if let value = result.signedIn { signedIn = value }
            if result.accountSwitchRequired != true, let value = result.email { email = value }
            if let value = result.backupAvailable { backupAvailable = value }
            if let value = result.backupEnabled { backupEnabled = value }
            if let value = result.lastBackupAt { lastBackupAt = value }
            if let value = result.devices { devices = value }
            if let value = result.history { history = value }
            message = result.message ?? ""
            if request.action == "requestCode" { codeSent = true; code = ""; message = "Enter the code sent to your Odd account email." }
            if request.action == "verifyCode" {
                restartSignIn()
                await refreshStatus()
                message = result.accountSwitchRequired == true
                    ? "This is a different Odd account. Sign out first, then request a new code. Your local history will stay here."
                    : result.message ?? ""
            }
            if request.action == "recoveryPhrase" { recoveryOpen = true; generatedPhrase = result.phrase ?? "" }
            if request.action == "enable" { clearPhrase(); recoveryOpen = false }
            if request.action == "logout" || request.action == "delete" { history = nil; devices = []; clearPhrase(); recoveryOpen = false }
            if request.action == "logout" { createAccount = false; restartSignIn() }
        } catch {
            message = "Watcher couldn’t complete the request. Check your connection and try again. Your saved history is safe."
        }
    }
    private func refreshStatus() async {
        guard let reply = try? await runAccountRequest(.init(action: "status")), reply.ok else { return }
        signedIn = reply.signedIn ?? false; backupAvailable = reply.backupAvailable ?? false
        if let email = reply.email { self.email = email }
        backupEnabled = reply.backupEnabled ?? false; lastBackupAt = reply.lastBackupAt
    }
    func clearPhrase() { phrase = ""; generatedPhrase = ""; consent = false }
    func pause() async {
        guard let reply = try? await OddAccountClient.run(.init(action: "disable")), reply.ok else {
            message = "Couldn’t pause backup. Please retry."; return
        }
        backupEnabled = false; message = "Backup on this Mac is paused."
    }
    func loadHistory() async {
        await perform(.init(action: selectedDevice == "local" ? "localDashboard" : "dashboard",
                            deviceId: selectedDevice == "local" ? nil : selectedDevice,
                            month: month.isEmpty ? nil : month))
    }
}

@MainActor
enum OddAccountWindow {
    private static var controller: NSWindowController?
    static func show(layoutPreview: String? = nil) {
        if controller == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 680),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "Watcher by EXE"
            window.backgroundColor = NSColor(Theme.warmSurfaceDark)
            window.contentMinSize = NSSize(width: 500, height: 580)
            window.contentView = NSHostingView(rootView: OddAccountView(model: layoutPreview.map(OddAccountModel.layoutPreview) ?? OddAccountModel()))
            window.isReleasedWhenClosed = false
            window.center()
            controller = NSWindowController(window: window)
        }
        controller?.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct OddAccountView: View {
    @State private var model: OddAccountModel
    @State private var confirmDelete = false
    @State private var historyExpanded = false

    init(model: OddAccountModel = OddAccountModel()) { _model = State(initialValue: model) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                brandHeader
                VStack(alignment: .leading, spacing: 14) {
                    if model.signedIn {
                        Text("Your account").font(.system(size: 24, weight: .semibold, design: .rounded))
                        account
                    } else {
                        signIn
                    }
                    if !model.message.isEmpty { Text(model.message).font(.system(size: 13)).textSelection(.enabled).accessibilityIdentifier("odd-account-message") }
                    if model.busy { ProgressView().controlSize(.small) }
                }
                Divider()
                DisclosureGroup(isExpanded: $historyExpanded) {
                    dashboard.padding(.top, 14)
                } label: { Text("Private spending & activity").font(.system(size: 14, weight: .semibold)) }
                Text("Local tracking works without an account. Product usage statistics and error diagnostics are separate settings. Watcher never publishes your spending or activity to your profile.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }.frame(maxWidth: 620, alignment: .leading)
                .padding(24)
                .frame(maxWidth: .infinity)
        }
        .background {
            Theme.warmSurfaceDark.overlay(alignment: .topLeading) {
                RadialGradient(colors: [Theme.brandEmberDeep.opacity(0.35), .clear], center: .topLeading, startRadius: 0, endRadius: 600)
            }.ignoresSafeArea()
        }
        .font(.system(size: 14))
        .foregroundStyle(.primary)
        .tint(Theme.brandAccent)
        .buttonStyle(WatcherAccountButtonStyle())
        .preferredColorScheme(.dark)
        .frame(minWidth: 500, minHeight: 580)
        .disabled(model.busy)
        .overlay(alignment: .bottomTrailing) {
            if model.busy && model.backupEnabled {
                Button("Pause backup") { Task { await model.pause() } }.padding()
            }
        }
        .task { await model.perform(.init(action: "status")) }
        .onDisappear { model.clearPhrase(); model.code = "" }
        .alert("Delete Watcher cloud history?", isPresented: $confirmDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete cloud history", role: .destructive) { Task { await model.perform(.init(action: "delete", confirm: true)) } }
        } message: { Text("Deletes Watcher backups from all devices. Your local tracking and Odd account remain. Backup is paused.") }
    }

    private var brandHeader: some View {
        HStack(spacing: 10) {
            AnimatedOwl(size: 42).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("WATCHER")
                    .font(.custom("Epilogue", size: 19).weight(.bold))
                    .tracking(2)
                    .foregroundStyle(Theme.brandWordmark)
                Text("by EXE")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.brandAccent)
            }
            Spacer()
        }
    }

    private var signIn: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.codeSent ? "Verify your email" : "Sign In or Sign Up")
                .font(.system(size: 24, weight: .semibold, design: .rounded))
            if model.codeSent {
                Text(model.email.trimmingCharacters(in: .whitespacesAndNewlines))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                SecureField("Email code", text: $model.code).textFieldStyle(WatcherAccountFieldStyle()).accessibilityIdentifier("odd-code")
                Button { Task { await model.verifyCode() } } label: {
                    HStack { Text(model.createAccount ? "Verify and Sign Up" : "Verify and Sign In"); Spacer(); Image(systemName: "arrow.up.right") }
                }
                .buttonStyle(WatcherAccountButtonStyle(primary: true))
                .keyboardShortcut(.defaultAction)
                .disabled(!model.canVerifyCode)
                HStack {
                    Button("Send another code") { Task { await model.requestCode() } }
                        .disabled(!model.canRequestCode)
                    Spacer()
                    Button("Use another email") { model.restartSignIn() }
                }.font(.system(size: 12)).buttonStyle(.plain).foregroundStyle(Theme.brandAccent)
            } else {
                Text("Use your Odd account in Watcher.").foregroundStyle(.secondary)
                Picker("Account action", selection: $model.createAccount) {
                    Text("Sign In").tag(false)
                    Text("Sign Up").tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                TextField("Email address", text: $model.email).textFieldStyle(WatcherAccountFieldStyle())
                    .accessibilityIdentifier("odd-email")
                Toggle("I agree to the Odd Community Terms of Use and have read the Privacy Policy", isOn: $model.acceptTerms)
                    .accessibilityIdentifier("odd-accept-terms")
                HStack {
                    Link("Terms of Use", destination: URL(string: "https://odd.community/terms")!)
                    Link("Privacy Policy", destination: URL(string: "https://odd.community/privacy")!)
                }.font(.system(size: 12)).buttonStyle(.plain).foregroundStyle(Theme.brandAccent)
                Toggle("I agree to receive a verification code by email from Odd Community.", isOn: $model.acceptVerificationEmail)
                    .accessibilityIdentifier("odd-accept-verification-email")
                Toggle("Email me product updates, marketing, and other messages from Odd Community and Exe AI.", isOn: $model.acceptEmailCommunications)
                    .accessibilityIdentifier("odd-accept-email-communications")
                Text("Optional. Manage email preferences in your Odd account.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Button { Task { await model.requestCode() } } label: {
                    HStack { Text("Send verification code"); Spacer(); Image(systemName: "arrow.up.right") }
                }
                .buttonStyle(WatcherAccountButtonStyle(primary: true))
                .keyboardShortcut(.defaultAction)
                .disabled(!model.canRequestCode)
            }
            Text("Signing in does not upload history or enable backup.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
        }
    }

    private var account: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                Text(model.email).font(.system(size: 15, weight: .semibold))
                    .lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                Spacer()
                Button("Sign out") { Task { await model.perform(.init(action: "logout")) } }
            }
            if !model.backupAvailable {
                Text("Cloud backup isn’t available in this build yet. Your local history is available below.").foregroundStyle(.secondary)
            } else if model.backupEnabled {
                Label("Encrypted cloud backup enabled", systemImage: "checkmark.shield")
                if let at = model.lastBackupAt { Text("Last completed backup: \(at)").font(.system(size: 12)).foregroundStyle(.secondary) }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { backupButtons }
                    VStack(alignment: .leading, spacing: 10) { backupButtons }
                }
            } else if !model.recoveryOpen {
                Button("Set up private backup…") { Task { await model.perform(.init(action: "recoveryPhrase")) } }
                Button("Load cloud devices") { Task { await model.perform(.init(action: "devices")) } }
            }
            if model.recoveryOpen { recovery }
            if model.backupAvailable {
                Button("Delete Watcher cloud history…", role: .destructive) { confirmDelete = true }
            }
            HStack {
                Link("Manage Odd account & email preferences", destination: URL(string: "https://odd.community/account")!)
                Link("Delete Odd account…", destination: URL(string: "https://odd.community/account/delete")!)
            }.font(.system(size: 12)).buttonStyle(.plain).foregroundStyle(Theme.brandAccent)
        }
    }

    @ViewBuilder private var backupButtons: some View {
        Button("Back up now") { Task { await model.perform(.init(action: "backup")) } }
        Button("Pause backup") { Task { await model.perform(.init(action: "disable")) } }
        Button("Load cloud devices") { Task { await model.perform(.init(action: "devices")) } }
    }

    private var recovery: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Private backup").font(.system(size: 21, weight: .semibold, design: .rounded))
            Text("Saves daily spending estimates, provider/token totals and estimated AI running time. No prompts, code, project names, file paths or credentials. History is encrypted on this Mac before upload; our servers cannot read it.")
                .font(.system(size: 14))
            if !model.generatedPhrase.isEmpty {
                Text("Save your new Odd recovery phrase privately. Use this same phrase in your other Odd apps.").font(.system(size: 14, weight: .semibold))
                Text(model.generatedPhrase).font(.system(.body, design: .monospaced)).textSelection(.enabled)
            }
            SecureField("Your 24-word Odd recovery phrase", text: $model.phrase).textFieldStyle(WatcherAccountFieldStyle())
            Toggle("Enable encrypted backup of my Watcher history", isOn: $model.consent)
            HStack {
                Button("Enable private backup") {
                    Task { await model.perform(.init(action: "enable", phrase: model.phrase, confirm: model.consent)) }
                }.buttonStyle(WatcherAccountButtonStyle(primary: true))
                    .disabled(!model.consent || model.phrase.split(separator: " ").count != 24)
                Button("Cancel") { model.clearPhrase(); model.recoveryOpen = false }
            }
        }.padding().background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
    }

    private var dashboard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("History", selection: $model.selectedDevice) {
                Text("This Mac").tag("local")
                ForEach(model.devices) { device in Text("Device \(device.device_id.prefix(8)) · \(device.updated_at.prefix(10))").tag(device.device_id) }
            }
            Text("Month (optional)").font(.system(size: 12, weight: .semibold))
            HStack(spacing: 10) {
                TextField("YYYY-MM · blank for all time", text: $model.month).textFieldStyle(WatcherAccountFieldStyle())
                Button("View history") { Task { await model.loadHistory() } }
            }
            if let history = model.history {
                Text(history.apiEquivalentUSD, format: .currency(code: "USD")).font(.system(size: 36, weight: .semibold))
                Text("Recorded API-equivalent cost · \(history.calls) calls").foregroundStyle(.secondary)
                ForEach(history.providers) { provider in
                    HStack { Text(provider.provider); Spacer(); Text(provider.apiEquivalentUSD, format: .currency(code: "USD")) }
                }
                if let ms = history.timing?.aiRunningMs {
                    Text("AI running time: \(ms / 3_600_000, specifier: "%.1f") hours").font(.system(size: 21, weight: .semibold, design: .rounded))
                    Text("Partial timing coverage; includes estimates. This is agent runtime, not human time saved.").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                if history.partial { Text("Some dates or providers have incomplete coverage.").font(.system(size: 12)).foregroundStyle(.secondary) }
            }
            Text("Costs are estimates, not invoices. Device histories stay separate so copied logs are not counted twice. Restored views preserve your current local logs and costs.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
        }
    }
}
