import AppKit
import SwiftUI

/// The native macOS prototype: the iOS app's engine, models and views in the
/// Tauri desktop app's layout (files and media sidebar, editor, preview), on
/// the desktop build of the Rust backend.
@main
struct PostoMacApp: App {
    @NSApplicationDelegateAdaptor private var delegate: AppDelegate
    @State private var window: MacWindowState

    init() {
        // Before the backend starts: the dev server needs node and the
        // package manager on PATH.
        LoginShell.adoptPath()
        _window = State(initialValue: .shared)
    }

    var body: some Scene {
        Window("Posto Native", id: "main") {
            MacRootView(window: window)
                .frame(minWidth: 900, minHeight: 560)
        }
        .defaultSize(width: 1440, height: 900)
        .commands { MacCommands(window: window) }

        Settings {
            MacSettingsView(app: window.app)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        // The dev server is a child process group; don't leave it running.
        let backend = MacWindowState.shared.app.backend
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            try? await backend.run("stop_dev_server")
            done.signal()
        }
        _ = done.wait(timeout: .now() + 2)
    }
}

/// The desktop app's menus: Open and Open Recent, Quick Open, the sidebar
/// and full-screen editor toggles, and the site commands.
struct MacCommands: Commands {
    let window: MacWindowState

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("Open Folder…") { window.chooseFolder() }
                .keyboardShortcut("o")
            Menu("Open Recent") {
                ForEach(window.app.recentRoots, id: \.self) { root in
                    Button(root.replacingOccurrences(of: NSHomeDirectory(), with: "~")) {
                        Task { await window.open(root) }
                    }
                }
            }
            .disabled(window.app.recentRoots.isEmpty)
            Divider()
            Button("Quick Open…") { window.quickOpen = true }
                .keyboardShortcut("p")
                .disabled(window.app.repo == nil)
            Button("Close Folder") { Task { await window.close() } }
                .keyboardShortcut("w", modifiers: [.command, .shift])
                .disabled(window.app.repo == nil)
        }
        CommandGroup(replacing: .sidebar) {
            Button(window.fullscreenEditor ? (window.floatingSidebars ? "Hide Sidebars" : "Show Sidebars") : (window.sidebarVisible ? "Hide Sidebar" : "Show Sidebar")) {
                window.toggleSidebar()
            }
            .keyboardShortcut("\\")
            Button("Files") { window.showSidebar(.files) }
                .keyboardShortcut("1")
            Button("Media") { window.showSidebar(.media) }
                .keyboardShortcut("2")
            Divider()
            Button(window.fullscreenEditor ? "Exit Full-Screen Editor" : "Full-Screen Editor") {
                window.toggleFullscreenEditor()
            }
            .keyboardShortcut("f", modifiers: [.command, .shift])
            .disabled(window.app.repo == nil)
            Divider()
        }
        CommandMenu("Site") {
            Button("Publish…") { window.app.repo?.openPublish() }
                .keyboardShortcut("p", modifiers: [.command, .shift])
                .disabled(window.app.repo?.view?.git.canPublish != true)
            Button("Pull") { Task { await window.app.repo?.pull() } }
                .disabled(window.app.repo?.view?.git.behindUpstream != true)
            Button("Switch Branch…") { window.app.repo?.branchesOpen = true }
                .keyboardShortcut("b", modifiers: [.command, .shift])
                .disabled(window.app.repo == nil)
            Divider()
            Button("Deployments") { window.deploymentsOpen = true }
                .disabled(window.app.repo?.view?.repo == nil)
            Button("Site Settings…") { window.app.repo?.settingsOpen = true }
                .disabled(window.app.repo == nil)
            Divider()
            Button("Restart Preview Server") { Task { await window.preview.restart() } }
                .disabled(window.app.repo == nil)
        }
    }
}

/// Apps opened from Finder get a minimal PATH. The Tauri app takes the login
/// shell's (fix-path-env), so node, pnpm and friends resolve for the dev
/// server; this does the same.
enum LoginShell {
    static func adoptPath() {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let marker = "__POSTO_PATH__"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-ilc", "printf '\(marker)%s\(marker)' \"$PATH\""]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return }
        // An interactive shell that waits on something shouldn't hold up launch.
        DispatchQueue.global().asyncAfter(deadline: .now() + 4) { if process.isRunning { process.terminate() } }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let text = String(data: data, encoding: .utf8),
              let start = text.range(of: marker),
              let end = text.range(of: marker, range: start.upperBound..<text.endIndex)
        else { return }
        let path = String(text[start.upperBound..<end.lowerBound])
        if !path.isEmpty { setenv("PATH", path, 1) }
    }
}
