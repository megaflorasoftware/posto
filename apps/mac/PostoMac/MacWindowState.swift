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
    /// The sidebar as it was before the full-screen editor hid it.
    private var columnsBeforeFullscreen: NavigationSplitViewVisibility = .all
    var fullscreenEditor = false
    /// The full-screen editor's floating Files and Media panels (Cmd-\).
    var floatingSidebars = false
    /// The editor's share of the editor and preview split; the desktop app
    /// opens at 40/60 and doesn't keep a dragged split either.
    var editorFraction: CGFloat = 0.4
    var quickOpen = false
    var recentOpen = false
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

    /// The full-screen editor covers the window: the sidebar column closes
    /// (and comes back as it was), the preview collapses, and Files and
    /// Media float over the editor on hover or Cmd-\.
    func toggleFullscreenEditor() {
        guard app.repo != nil else { return }
        withAnimation(.snappy) {
            if fullscreenEditor {
                columns = columnsBeforeFullscreen
            } else {
                columnsBeforeFullscreen = columns
                columns = .detailOnly
            }
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
        exitFullscreen()
        await app.openLocal(root: root)
        await syncPreview()
    }

    func close() async {
        await preview.stop()
        exitFullscreen()
        await app.closeRepo()
    }

    private func exitFullscreen() {
        if fullscreenEditor { columns = columnsBeforeFullscreen }
        fullscreenEditor = false
        floatingSidebars = false
    }

    /// Runs the preview for the project that's open: not while the project
    /// chooser is up (in a monorepo the repository root isn't the site), and
    /// again when a different project is chosen.
    func syncPreview() async {
        guard let repo = app.repo, let view = repo.view, view.workspaceCandidates == nil,
              view.error == nil, !view.loading
        else { return }
        if preview.root == view.root, preview.state != .idle { return }
        await preview.stop()
        await preview.start(root: view.root)
    }
}
