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
    var isLayoutPreview = false
    static func layoutPreview(_ state: String) -> OddAccountModel {
        let model = OddAccountModel()
        model.isLayoutPreview = true
        if state == "verification" { model.codeSent = true; model.email = "you@example.com" }
        if state == "recovery" {
            model.signedIn = true; model.backupAvailable = true; model.recoveryOpen = true
            model.email = "you@example.com"
        }
        return model
    }
    var signedIn = false
    var backupAvailable = false
    var backupEnabled = false
    var email = ""
    var code = ""
    var codeSent = false
    var createAccount = false
    var acceptTerms = false
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

    func perform(_ request: OddAccountRequest) async {
        guard !isLayoutPreview else { return }
        guard !busy else { return }
        busy = true; message = ""
        defer { busy = false }
        do {
            let result = try await OddAccountClient.run(request)
            guard result.ok else { message = result.message ?? "Please try again."; return }
            if let value = result.signedIn { signedIn = value }
            if let value = result.email { email = value }
            if let value = result.backupAvailable { backupAvailable = value }
            if let value = result.backupEnabled { backupEnabled = value }
            if let value = result.lastBackupAt { lastBackupAt = value }
            if let value = result.devices { devices = value }
            if let value = result.history { history = value }
            message = result.message ?? ""
            if request.action == "requestCode" { codeSent = true; message = "Enter the code sent to your Odd account email." }
            if request.action == "verifyCode" {
                code = ""
                if result.accountSwitchRequired == true { message = "This is a different Odd account. Sign out first, then request a new code. Your local history will stay here." }
                else { codeSent = false; await refreshStatus() }
            }
            if request.action == "recoveryPhrase" { recoveryOpen = true; generatedPhrase = result.phrase ?? "" }
            if request.action == "enable" { clearPhrase(); recoveryOpen = false }
            if request.action == "logout" || request.action == "delete" { history = nil; devices = []; clearPhrase(); recoveryOpen = false }
        } catch {
            message = "Watcher couldn’t complete the request. Check your connection and try again. Your saved history is safe."
        }
    }
    private func refreshStatus() async {
        guard let reply = try? await OddAccountClient.run(.init(action: "status")), reply.ok else { return }
        signedIn = reply.signedIn ?? false; backupAvailable = reply.backupAvailable ?? false
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
            window.title = "Odd Community · Watcher"
            window.backgroundColor = NSColor(OddAccountBrand.background)
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
                VStack(alignment: .leading, spacing: 10) {
                    Text("Your AI history,\nin one place.").font(OddAccountBrand.display(30))
                    Text("Keep a private backup of your AI spending and agent activity across your Macs.")
                        .foregroundStyle(OddAccountBrand.muted)
                }
                VStack(alignment: .leading, spacing: 14) {
                    Rectangle().fill(OddAccountBrand.orange).frame(height: 2)
                    HStack {
                        Text(model.signedIn ? "YOUR ACCOUNT" : "ONE-TIME EMAIL CODE")
                            .font(OddAccountBrand.bold(10)).tracking(1.2)
                        Spacer()
                        Label("Private to you", systemImage: "lock.shield").font(OddAccountBrand.body(12))
                    }.foregroundStyle(OddAccountBrand.muted)
                    if model.signedIn { account } else { signIn }
                    if !model.message.isEmpty { Text(model.message).font(OddAccountBrand.body(13)).textSelection(.enabled).accessibilityIdentifier("odd-account-message") }
                    if model.busy { ProgressView().controlSize(.small) }
                }
                Divider()
                DisclosureGroup(isExpanded: $historyExpanded) {
                    dashboard.padding(.top, 14)
                } label: { Text("Private spending & activity").font(OddAccountBrand.bold(14)) }
                Text("Local tracking works without an account. Product usage statistics and error diagnostics are separate settings. Watcher never publishes your spending or activity to your profile.")
                    .font(OddAccountBrand.body(12)).foregroundStyle(OddAccountBrand.muted)
            }.frame(maxWidth: 620, alignment: .leading)
                .padding(24)
                .frame(maxWidth: .infinity)
        }
        .background {
            OddAccountBrand.background.overlay(alignment: .topLeading) {
                RadialGradient(colors: [OddAccountBrand.glow, .clear], center: .topLeading, startRadius: 0, endRadius: 600)
            }.ignoresSafeArea()
        }
        .font(OddAccountBrand.body())
        .foregroundStyle(OddAccountBrand.ink)
        .tint(OddAccountBrand.link)
        .buttonStyle(OddAccountButtonStyle())
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
            if let mark = OddAccountBrand.mark {
                Image(nsImage: mark).resizable().interpolation(.high).scaledToFit()
                    .frame(width: 40, height: 40).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text("Odd Community").font(OddAccountBrand.heading(22))
                Text("ONE ACCOUNT. ALL ODD APPS.").font(OddAccountBrand.bold(10)).tracking(1.2)
                    .foregroundStyle(OddAccountBrand.muted)
            }
            Spacer()
        }
    }

    private var signIn: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.codeSent ? "You’re almost here." : "Make yourself at home.").font(OddAccountBrand.heading(21))
            TextField("Email address", text: $model.email).textFieldStyle(OddAccountFieldStyle())
                .accessibilityIdentifier("odd-email")
                .disabled(model.codeSent)
            if !model.codeSent { Toggle("Create a new Odd account", isOn: $model.createAccount) }
            if model.createAccount && !model.codeSent {
                Toggle("I agree to the Odd Terms and have read the Privacy Policy", isOn: $model.acceptTerms)
                HStack {
                    Link("Terms", destination: URL(string: "https://odd.community/terms")!)
                    Link("Privacy Policy", destination: URL(string: "https://odd.community/privacy")!)
                }.font(OddAccountBrand.body(12)).buttonStyle(.plain).foregroundStyle(OddAccountBrand.link)
            }
            if model.codeSent {
                SecureField("Email code", text: $model.code).textFieldStyle(OddAccountFieldStyle()).accessibilityIdentifier("odd-code")
                Button { Task { await model.perform(.init(action: "verifyCode", email: model.email, code: model.code)) } } label: {
                    HStack { Text("Verify and continue"); Spacer(); Image(systemName: "arrow.up.right") }
                }
                .buttonStyle(OddAccountButtonStyle(primary: true))
                .disabled(!(6...10).contains(model.code.count))
                HStack {
                    Button("Send another code") { Task { await requestCode() } }
                    Spacer()
                    Button("Use another email") { model.codeSent = false; model.code = ""; model.message = "" }
                }.font(OddAccountBrand.body(12)).buttonStyle(.plain).foregroundStyle(OddAccountBrand.link)
            } else {
                Button { Task { await requestCode() } } label: {
                    HStack { Text("Email me a code"); Spacer(); Image(systemName: "arrow.up.right") }
                }
                    .buttonStyle(OddAccountButtonStyle(primary: true))
                    .disabled(model.email.isEmpty || (model.createAccount && !model.acceptTerms))
            }
            Text("Signing in does not upload history or enable backup.")
                .font(OddAccountBrand.body(12)).foregroundStyle(OddAccountBrand.muted)
        }
    }

    private func requestCode() async {
        await model.perform(.init(action: "requestCode", email: model.email,
                                  createAccount: model.createAccount, acceptTerms: model.acceptTerms))
    }

    private var account: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                Text(model.email).font(OddAccountBrand.bold(15))
                    .lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                Spacer()
                Button("Sign out") { Task { await model.perform(.init(action: "logout")) } }
            }
            if !model.backupAvailable {
                Text("Cloud backup isn’t available in this build yet. Your local history is available below.").foregroundStyle(OddAccountBrand.muted)
            } else if model.backupEnabled {
                Label("Encrypted cloud backup enabled", systemImage: "checkmark.shield")
                if let at = model.lastBackupAt { Text("Last completed backup: \(at)").font(OddAccountBrand.body(12)).foregroundStyle(OddAccountBrand.muted) }
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
                Link("Manage Odd account", destination: URL(string: "https://odd.community/account")!)
                Link("Delete Odd account…", destination: URL(string: "https://odd.community/account/delete")!)
            }.font(OddAccountBrand.body(12)).buttonStyle(.plain).foregroundStyle(OddAccountBrand.link)
        }
    }

    @ViewBuilder private var backupButtons: some View {
        Button("Back up now") { Task { await model.perform(.init(action: "backup")) } }
        Button("Pause backup") { Task { await model.perform(.init(action: "disable")) } }
        Button("Load cloud devices") { Task { await model.perform(.init(action: "devices")) } }
    }

    private var recovery: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Private backup").font(OddAccountBrand.heading(21))
            Text("Saves daily spending estimates, provider/token totals and estimated AI running time. No prompts, code, project names, file paths or credentials. History is encrypted on this Mac before upload; our servers cannot read it.")
                .font(OddAccountBrand.body(14))
            if !model.generatedPhrase.isEmpty {
                Text("Save your new Odd recovery phrase privately. Use this same phrase in your other Odd apps.").font(OddAccountBrand.bold(14))
                Text(model.generatedPhrase).font(.system(.body, design: .monospaced)).textSelection(.enabled)
            }
            SecureField("Your 24-word Odd recovery phrase", text: $model.phrase).textFieldStyle(OddAccountFieldStyle())
            Toggle("Enable encrypted backup of my Watcher history", isOn: $model.consent)
            HStack {
                Button("Enable private backup") {
                    Task { await model.perform(.init(action: "enable", phrase: model.phrase, confirm: model.consent)) }
                }.buttonStyle(OddAccountButtonStyle(primary: true))
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
            Text("Month (optional)").font(OddAccountBrand.bold(12))
            HStack(spacing: 10) {
                TextField("YYYY-MM · blank for all time", text: $model.month).textFieldStyle(OddAccountFieldStyle())
                Button("View history") { Task { await model.loadHistory() } }
            }
            if let history = model.history {
                Text(history.apiEquivalentUSD, format: .currency(code: "USD")).font(OddAccountBrand.bold(36))
                Text("Recorded API-equivalent cost · \(history.calls) calls").foregroundStyle(OddAccountBrand.muted)
                ForEach(history.providers) { provider in
                    HStack { Text(provider.provider); Spacer(); Text(provider.apiEquivalentUSD, format: .currency(code: "USD")) }
                }
                if let ms = history.timing?.aiRunningMs {
                    Text("AI running time: \(ms / 3_600_000, specifier: "%.1f") hours").font(OddAccountBrand.heading(21))
                    Text("Partial timing coverage; includes estimates. This is agent runtime, not human time saved.").font(OddAccountBrand.body(12)).foregroundStyle(OddAccountBrand.muted)
                }
                if history.partial { Text("Some dates or providers have incomplete coverage.").font(OddAccountBrand.body(12)).foregroundStyle(OddAccountBrand.muted) }
            }
            Text("Costs are estimates, not invoices. Device histories stay separate so copied logs are not counted twice. Restored views preserve your current local logs and costs.")
                .font(OddAccountBrand.body(12)).foregroundStyle(OddAccountBrand.muted)
        }
    }
}
