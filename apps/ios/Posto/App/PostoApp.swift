import SwiftUI

@main
struct PostoApp: App {
    @State private var root = RootModel()

    var body: some Scene {
        WindowGroup {
            RootView(app: root.app, switchDemo: root.setDemo)
                .id(ObjectIdentifier(root.app))
        }
        .commands { PostoCommands(root: root) }
    }
}

/// Holds the app model; demo mode swaps in a model backed by the engine's
/// in-memory fixture backend instead of the Rust bridge.
@MainActor
@Observable
final class RootModel {
    private static let demoKey = "posto.native.demo"
    private(set) var app: AppModel

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let demo = arguments.contains("-PostoDemo") || UserDefaults.standard.bool(forKey: Self.demoKey)
        app = AppModel(demo: demo)
    }

    func setDemo(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: Self.demoKey)
        Task {
            await app.closeRepo()
            app = AppModel(demo: enabled)
        }
    }
}

/// The iPad menu bar and hardware-keyboard shortcuts: the desktop app's
/// file and site commands (the Mac app's MacCommands), for the open
/// repository.
struct PostoCommands: Commands {
    let root: RootModel
    @FocusedValue(\.workspaceCommands) private var workspace

    var body: some Commands {
        let repo = root.app.repo
        // A sheet the workspace presents can't open over another one.
        let presenting = repo.map { $0.settingsOpen || $0.publish != nil || $0.branchesOpen || $0.collectionSettings != nil || $0.collectionOrderOpen } ?? false
        CommandGroup(replacing: .newItem) {
            Button("New File") {
                guard let repo, let target = repo.newFileTarget else { return }
                Task { await repo.createFile(in: target) }
            }
            .keyboardShortcut("n")
            .disabled(repo?.newFileTarget == nil || presenting)
            Button("Find File…") { workspace?.findFile() }
                .keyboardShortcut("o")
                .disabled(workspace == nil || presenting)
        }
        CommandGroup(replacing: .sidebar) {
            Button("Toggle Sidebar") { workspace?.toggleSidebar() }
                .keyboardShortcut("s", modifiers: [.command, .control])
                .disabled(workspace == nil)
        }
        CommandGroup(replacing: .appSettings) {
            if let repo {
                Button("Site Settings…") { repo.settingsOpen = true }
                    .keyboardShortcut(",")
                    .disabled(presenting)
            } else {
                Button("Settings…") { root.app.settingsOpen = true }
                    .keyboardShortcut(",")
                    .disabled(root.app.stage != .repositories)
            }
        }
        CommandMenu("Site") {
            Button("Publish…") { repo?.openPublish() }
                .keyboardShortcut("p", modifiers: [.command, .shift])
                .disabled(repo?.view?.git.canPublish != true || presenting)
            Button("Pull") { Task { await repo?.pull() } }
                .disabled(repo?.view?.git.behindUpstream != true || repo?.view?.git.pulling == true)
            Button("Switch Branch…") { repo?.branchesOpen = true }
                .keyboardShortcut("b", modifiers: [.command, .shift])
                .disabled(repo?.view?.branch == nil || presenting)
        }
    }
}
