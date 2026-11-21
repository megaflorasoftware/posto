import AppKit
import Observation
import SwiftUI

/// The window's layout state, as the Tauri desktop app keeps it: which
/// sidebar shows (files or media) and whether it's open, the full-screen
/// editor and its floating sidebars, and the panels reached from menus.
@MainActor
@Observable
final class MacWindowState {
    static let shared = MacWindowState()

    enum SidebarMode: String, CaseIterable, Identifiable {
        case files, media
        var id: String { rawValue }
        var title: String { self == .files ? "Files" : "Media" }
        var symbol: String { self == .files ? "doc.on.doc" : "photo.on.rectangle" }
    }

    let app = AppModel(demo: false)
    let preview: PreviewModel
    var sidebarMode: SidebarMode = .files
    var columns: NavigationSplitViewVisibility = .all
    var fullscreenEditor = false
    /// The full-screen editor's floating Files and Media panels (Cmd-\).
    var floatingSidebars = false
    var quickOpen = false
    var deploymentsOpen = false

    private init() {
        preview = PreviewModel(app: app)
    }

    var sidebarVisible: Bool { columns != .detailOnly }

    func toggleSidebar() {
        if fullscreenEditor {
            floatingSidebars.toggle()
        } else {
            withAnimation { columns = sidebarVisible ? .detailOnly : .all }
        }
    }

    func showSidebar(_ mode: SidebarMode) {
        sidebarMode = mode
        if fullscreenEditor {
            floatingSidebars = true
        } else {
            withAnimation { columns = .all }
        }
    }

    func toggleFullscreenEditor() {
        guard app.repo != nil else { return }
        withAnimation(.snappy) {
            fullscreenEditor.toggle()
            floatingSidebars = false
        }
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open"
        panel.message = "Choose a site's folder (a git repository) to edit."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await open(url.path) }
    }

    func open(_ root: String) async {
        await preview.stop()
        fullscreenEditor = false
        await app.openLocal(root: root)
        if let repo = app.repo, repo.view?.error == nil {
            await preview.start(root: repo.view?.root ?? root)
        }
    }

    func close() async {
        await preview.stop()
        fullscreenEditor = false
        await app.closeRepo()
    }
}
