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
                // The shared views' forms scroll: macOS's default (columns)
                // style doesn't, so a long body sat centered and clipped.
                .formStyle(.grouped)
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
    /// Set once the open file is saved and the dev server stopped.
    private var readyToQuit = false
    private var preparing = false

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// The first quit waits for the open file's last edits to be written
    /// and the dev server to stop, then quits again. Both need the main
    /// actor, which a deferred quit (terminateLater) never services.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if readyToQuit { return .terminateNow }
        guard !preparing else { return .terminateCancel }
        preparing = true
        let quit = { [weak self] in
            guard let self, !self.readyToQuit else { return }
            self.readyToQuit = true
            sender.terminate(nil)
        }
        Task { @MainActor in
            let window = MacWindowState.shared
            await window.app.repo?.document?.flush()
            await window.preview.stop()
            quit()
        }
        // A save or a server that hangs doesn't keep the app open.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { quit() }
        return .terminateCancel
    }

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
        // The desktop app's File menu: Open File (Cmd-O, a palette of the
        // site's files), Open Repository, Open Recent (Shift-Cmd-O, a
        // palette), Open Sibling Project.
        CommandGroup(replacing: .newItem) {
            Button("Open File…") { window.quickOpen = true }
                .keyboardShortcut("o")
                .disabled(window.app.repo == nil)
            Button("Open Folder…") { window.chooseFolder() }
            Button("Open Recent…") { window.recentOpen = true }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(window.app.recentRoots.isEmpty)
            Button("Open Sibling Project…") { Task { await window.app.repo?.showWorkspaceChooser() } }
                .disabled(window.app.repo?.view?.canSwitchProject != true)
            Divider()
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
        // Read until the second marker, not to end of file: a login script
        // that leaves a background job holding stdout would never close it.
        // An interactive shell that waits on something doesn't hold up
        // launch past 4 seconds either.
        let collected = LockedData()
        let done = DispatchSemaphore(value: 0)
        let handle = output.fileHandleForReading
        handle.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty || collected.append(chunk, until: marker) {
                handle.readabilityHandler = nil
                done.signal()
            }
        }
        if done.wait(timeout: .now() + 4) == .timedOut { handle.readabilityHandler = nil }
        if process.isRunning { process.terminate() }
        let data = collected.data
        guard let text = String(data: data, encoding: .utf8),
              let start = text.range(of: marker),
              let end = text.range(of: marker, range: start.upperBound..<text.endIndex)
        else { return }
        let path = String(text[start.upperBound..<end.lowerBound])
        if !path.isEmpty { setenv("PATH", path, 1) }
    }

    private final class LockedData: @unchecked Sendable {
        private let lock = NSLock()
        private var buffer = Data()

        var data: Data { lock.withLock { buffer } }

        /// Appends; true once the output holds the marker twice.
        func append(_ chunk: Data, until marker: String) -> Bool {
            lock.withLock {
                buffer.append(chunk)
                let text = String(decoding: buffer, as: UTF8.self)
                return text.components(separatedBy: marker).count >= 3
            }
        }
    }
}
