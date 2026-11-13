// Layer 3: UI Smoke Tests via macOS Accessibility APIs
//
// These tests launch the real app binary, interact with it through AXUIElement
// (the same accessibility tree XCUITest uses), and verify the popover works.
//
// Requirements:
//   - App must be built first: `swift build` from mac/
//   - System Preferences > Privacy & Security > Accessibility must include
//     your terminal app (Terminal.app, iTerm, etc.) for AX queries to work.
//   - Not suitable for headless CI — requires a display and accessibility perms.
//
// Run with: cd mac && swift test --filter ExeWatcherUITests
// Set EXE_WATCHER_UI_TEST_BINARY to qualify an exact packaged app. By default
// these launch and terminate their own current debug binary without touching installed apps.

import AppKit
import Foundation
import Testing

private let binaryName = "ExeWatcherMenubar"
private let launchTimeout: TimeInterval = 15
private let uiTimeout: TimeInterval = 10

// MARK: - AX Helpers

/// Thin wrapper around AXUIElement for readable test code.
private struct AXNode {
    let element: AXUIElement

    var role: String? { attribute(kAXRoleAttribute) }
    var title: String? { attribute(kAXTitleAttribute) }
    var value: String? { attribute(kAXValueAttribute) }
    var label: String? { attribute(kAXDescriptionAttribute) ?? attribute("AXLabel") }
    var identifier: String? { attribute(kAXIdentifierAttribute) }
    var subrole: String? { attribute(kAXSubroleAttribute) }
    var selected: Bool { attribute("AXSelected") ?? false }

    func attribute<T>(_ name: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
            return nil
        }
        return value as? T
    }

    var children: [AXNode] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
              let array = value as? [AXUIElement] else { return [] }
        return array.map { AXNode(element: $0) }
    }

    /// Recursively find all descendants matching a predicate.
    func findAll(where predicate: (AXNode) -> Bool) -> [AXNode] {
        var results: [AXNode] = []
        if predicate(self) { results.append(self) }
        for child in children {
            results.append(contentsOf: child.findAll(where: predicate))
        }
        return results
    }

    /// Find first descendant matching a predicate.
    func findFirst(where predicate: (AXNode) -> Bool) -> AXNode? {
        if predicate(self) { return self }
        for child in children {
            if let found = child.findFirst(where: predicate) { return found }
        }
        return nil
    }

    /// Perform AX press action (click).
    func press() {
        AXUIElementPerformAction(element, kAXPressAction as CFString)
    }

    /// All text content visible in the subtree (for debugging).
    func allText() -> [String] {
        findAll { node in
            node.role == kAXStaticTextRole as String
        }.compactMap { $0.value ?? $0.title ?? $0.label }
    }
}

// MARK: - Process management

/// Test the current debug build by default. Release QA can select an exact packaged binary
/// instead of accidentally exercising an old .build/dist or installed app.
private func findBinaryPath() -> String? {
    if let override = ProcessInfo.processInfo.environment["EXE_WATCHER_UI_TEST_BINARY"],
       FileManager.default.isExecutableFile(atPath: override) { return override }
    let sourceFileURL = URL(fileURLWithPath: #filePath)
    let testsDir = sourceFileURL.deletingLastPathComponent()
    let macDir = testsDir.deletingLastPathComponent()
                         .deletingLastPathComponent()
    let candidates = [
        macDir.appendingPathComponent(".build/arm64-apple-macosx/debug/\(binaryName)").path,
        macDir.appendingPathComponent(".build/arm64-apple-macosx/release/\(binaryName)").path,
        macDir.appendingPathComponent(".build/dist/Watcher by EXE.app/Contents/MacOS/\(binaryName)").path,
    ]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}

/// Launch the selected executable directly so its PID and accessibility tree are unambiguous.
private func launchApp(path: String) -> (process: Process?, pid: pid_t) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = ["--menu-bar-preview"]
    process.environment = ProcessInfo.processInfo.environment
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try! process.run()
    return (process, process.processIdentifier)
}

/// Check whether this process has Accessibility API permission.
private func hasAccessibilityPermission() -> Bool {
    // Try reading AX children of any running app. If we get kAXErrorAPIDisabled (-25211)
    // then we don't have permission.
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    guard let app = apps.first else { return false }
    let el = AXUIElementCreateApplication(app.processIdentifier)
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &value)
    return result != .apiDisabled
}

/// Wait for the app's AX tree to become available.
private func waitForAppReady(pid: pid_t, timeout: TimeInterval) -> Bool {
    guard pid > 0 else { return false }
    let appElement = AXUIElementCreateApplication(pid)
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(appElement, kAXChildrenAttribute as CFString, &value)
        if result == .success, let children = value as? [AXUIElement], !children.isEmpty {
            return true
        }
        // If AX is disabled system-wide, don't keep waiting
        if result == .apiDisabled { return false }
        if kill(pid, 0) != 0 { return false }
        Thread.sleep(forTimeInterval: 0.5)
    }
    return false
}

/// Wait for a condition with polling.
private func waitUntil(timeout: TimeInterval = uiTimeout, interval: TimeInterval = 0.3, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        Thread.sleep(forTimeInterval: interval)
    }
    return false
}

// MARK: - Tests

@Suite("UI Smoke Tests", .serialized)
struct ExeWatcherUITests {
    /// Shared state across tests — launch once, reuse.
    /// Using .serialized ensures tests run in order.

    /// Launch the app and return its PID + AX node. Throws on failure.
    /// Returns `nil` appNode if accessibility permission is missing (tests should skip).
    private func launchAndGetApp() throws -> (pid: pid_t, appNode: AXNode?) {
        guard let binaryPath = findBinaryPath() else {
            throw AppLaunchError.binaryNotFound
        }

        let (_, pid) = launchApp(path: binaryPath)
        guard pid > 0 else {
            throw AppLaunchError.didNotRegister
        }

        // Check if we even have accessibility permission
        if !hasAccessibilityPermission() {
            // App launched but we can't inspect it — tests will skip AX-dependent checks
            Thread.sleep(forTimeInterval: 2.0)  // give app time to start
            return (pid, nil)
        }

        // Wait for the AX tree to become available (status item rendered)
        guard waitForAppReady(pid: pid, timeout: launchTimeout) else {
            kill(pid, SIGTERM)
            throw AppLaunchError.noAccessibility
        }

        let appElement = AXUIElementCreateApplication(pid)
        let appNode = AXNode(element: appElement)

        Thread.sleep(forTimeInterval: 1.5)

        return (pid, appNode)
    }

    /// Menu extras belong to the launching app's accessibility tree, not the system-wide tree.
    private func findStatusItem(appNode: AXNode) -> AXNode? {
        appNode.findFirst { node in
            let text = (node.title ?? "") + (node.value ?? "") + (node.label ?? "")
            return node.role == kAXMenuBarItemRole as String && node.subrole == "AXMenuExtra"
                && text.contains("Watcher") && text.contains("$")
        }
    }

    /// Find the popover window after clicking the status item.
    private func findPopoverWindow(appNode: AXNode) -> AXNode? {
        // After clicking, the popover creates a window. Look for it.
        return appNode.findFirst { node in
            node.role == kAXWindowRole as String || node.role == kAXSheetRole as String || node.role == "AXPopover"
        }
    }

    private func openPopover(appNode: AXNode, statusItem: AXNode) -> AXNode? {
        for _ in 0..<3 {
            statusItem.press()
            var found: AXNode?
            _ = waitUntil(timeout: 3) {
                found = findPopoverWindow(appNode: appNode)
                return found != nil
            }
            if let found { return found }
        }
        return nil
    }

    /// Run a test body that requires AX. If AX is unavailable, wraps the test
    /// in `withKnownIssue` so it doesn't count as a failure.
    private func withAX(body: (AXNode) throws -> Void) throws {
        let (pid, appNode) = try launchAndGetApp()
        defer { kill(pid, SIGTERM) }

        if let node = appNode {
            try body(node)
        } else {
            withKnownIssue("Accessibility permission not granted") {
                #expect(Bool(false), "Grant Accessibility in System Settings > Privacy & Security")
            }
        }
    }

    // ------------------------------------------------------------------
    // 1. App Launches (no AX needed — just check the process is alive)
    // ------------------------------------------------------------------
    @Test("app launches without crash and stays running for 2 seconds")
    func appLaunches() throws {
        let (pid, _) = try launchAndGetApp()
        defer { kill(pid, SIGTERM) }

        // Verify the process is still alive after launch
        #expect(kill(pid, 0) == 0, "Process should be running")

        // Wait 2 seconds and check it didn't crash
        Thread.sleep(forTimeInterval: 2.0)
        #expect(kill(pid, 0) == 0, "Process should still be running after 2 seconds")
    }

    // ------------------------------------------------------------------
    // 2. Status Item Exists (requires AX)
    // ------------------------------------------------------------------
    @Test("status bar item appears with a dollar cost label")
    func statusItemExists() throws {
        try withAX { node in
            let found = waitUntil(timeout: uiTimeout) {
                findStatusItem(appNode: node) != nil
            }
            #expect(found, "Status bar item with '$' cost should appear in the menu bar")
        }
    }

    // ------------------------------------------------------------------
    // 3. Popover Opens (requires AX)
    // ------------------------------------------------------------------
    @Test("clicking the status item opens the popover with WATCHER header")
    func popoverOpens() throws {
        try withAX { node in
            guard let statusItem = findStatusItem(appNode: node),
                  let popover = openPopover(appNode: node, statusItem: statusItem) else {
                Issue.record("Could not open the Watcher popover")
                return
            }
            let allTexts = popover.allText()
            let hasWatcher = allTexts.contains { $0.uppercased().contains("WATCHER") }
            #expect(hasWatcher, "Popover should contain 'WATCHER' header. Found texts: \(allTexts.prefix(10))")
        }
    }

    // ------------------------------------------------------------------
    // 4. Cost Label Format (requires AX)
    // ------------------------------------------------------------------
    @Test("popover shows a cost label starting with '$'")
    func costLabelFormat() throws {
        try withAX { node in
            guard let statusItem = findStatusItem(appNode: node),
                  let popover = openPopover(appNode: node, statusItem: statusItem) else {
                Issue.record("Could not open the Watcher popover")
                return
            }
            let allTexts = popover.allText()
            let hasDollar = allTexts.contains { $0.hasPrefix("$") }
            #expect(hasDollar, "At least one text element should start with '$'. Found: \(allTexts.prefix(10))")
        }
    }

    // ------------------------------------------------------------------
    // 5. Period Buttons Exist (requires AX)
    // ------------------------------------------------------------------
    @Test("popover contains all five period tab buttons")
    func periodButtonsExist() throws {
        try withAX { node in
            guard let statusItem = findStatusItem(appNode: node),
                  let popover = openPopover(appNode: node, statusItem: statusItem) else {
                Issue.record("Could not open the Watcher popover")
                return
            }
            let expectedPeriods = ["Today", "7 Days", "30 Days", "Month", "All"]
            let buttons = popover.findAll { n in
                n.role == kAXButtonRole as String || n.role == kAXRadioButtonRole as String
            }
            let buttonTitles = buttons.compactMap { $0.title ?? $0.label ?? $0.value }
            for period in expectedPeriods {
                let found = buttonTitles.contains { $0 == period }
                #expect(found, "Period button '\(period)' should exist. Found buttons: \(buttonTitles.prefix(15))")
            }
        }
    }

    // ------------------------------------------------------------------
    // 6. Period Tab Switching (requires AX)
    // ------------------------------------------------------------------
    @Test("clicking each period tab selects it")
    func periodTabSwitching() throws {
        try withAX { node in
            guard let statusItem = findStatusItem(appNode: node),
                  openPopover(appNode: node, statusItem: statusItem) != nil else {
                Issue.record("Could not open the Watcher popover")
                return
            }
            for buttonLabel in ["7 Days", "30 Days", "Month", "All", "Today"] {
                var currentPopover: AXNode?
                _ = waitUntil {
                    currentPopover = findPopoverWindow(appNode: node)
                    return currentPopover != nil
                }
                guard let currentPopover else {
                    Issue.record("Popover closed before selecting '\(buttonLabel)'")
                    continue
                }
                let buttons = currentPopover.findAll { n in
                    (n.role == kAXButtonRole as String || n.role == kAXRadioButtonRole as String)
                    && (n.title == buttonLabel || n.label == buttonLabel || n.value == buttonLabel)
                }
                guard let button = buttons.first else {
                    Issue.record("Could not find button '\(buttonLabel)'")
                    continue
                }
                button.press()
                let selected = waitUntil {
                    guard let current = findPopoverWindow(appNode: node) else { return false }
                    return current.findAll { n in
                        (n.role == kAXButtonRole as String || n.role == kAXRadioButtonRole as String)
                        && (n.title == buttonLabel || n.label == buttonLabel || n.value == buttonLabel)
                    }.first?.selected == true
                }
                #expect(selected, "After clicking '\(buttonLabel)', it should expose the selected accessibility state")
            }
        }
    }
}


// MARK: - Errors

private enum AppLaunchError: Error, CustomStringConvertible {
    case binaryNotFound
    case didNotRegister
    case noAccessibility

    var description: String {
        switch self {
        case .binaryNotFound:
            return "Could not find \(binaryName) binary. Run `swift build` first."
        case .didNotRegister:
            return "\(binaryName) launched but did not register in NSWorkspace within \(launchTimeout)s."
        case .noAccessibility:
            return """
            \(binaryName) launched but accessibility tree is empty. \
            Grant accessibility permission to your terminal in \
            System Preferences > Privacy & Security > Accessibility.
            """
        }
    }
}
