import AppKit
import SwiftUI

struct MacRootView: View {
    let window: MacWindowState

    var body: some View {
        // A ZStack, not a Group: modifiers on a Group attach to each child,
        // so swapping the welcome screen for the workspace would cancel the
        // startup task halfway through opening a folder.
        ZStack {
            if let repo = window.app.repo {
                MacWorkspaceView(window: window, repo: repo)
                    .id(ObjectIdentifier(repo))
            } else {
                WelcomeView(window: window)
            }
        }
        .task {
            await window.app.startLocal()
            #if DEBUG
            if let path = MacDebugRemote.openPath {
                await window.open(path)
            }
            #endif
            await window.syncPreview()
        }
        // However the folder closes (Close Folder, the project chooser, a
        // failed open), its dev server and route sync stop with it.
        .onChange(of: window.app.repo == nil) { _, closed in
            if closed { Task { await window.preview.stop() } }
        }
        #if DEBUG
        .task { await MacDebugRemote.run(window: window) }
        #endif
        // GitHub sign-in and other links open in the default browser.
        .onChange(of: window.app.browserURL) { _, url in
            guard let url else { return }
            NSWorkspace.shared.open(url)
        }
        .errorAlert(Binding(get: { window.app.error }, set: { window.app.error = $0 }))
    }
}

/// One open folder in the Tauri desktop app's layout: the files or media
/// sidebar, the editor, and the site preview beside it. The full-screen
/// editor covers all of it, with Files and Media floating over its edges.
struct MacWorkspaceView: View {
    @Bindable var window: MacWindowState
    @Bindable var repo: RepoModel

    /// What the preview runs for; a change starts it for the new project.
    private struct PreviewTarget: Equatable {
        let root: String?
        let choosing: Bool
        let loading: Bool
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $window.columns) {
            MacSidebar(window: window, repo: repo)
                .navigationSplitViewColumnWidth(min: 220, ideal: 240, max: 420)
                // Full screen has its own panels (Cmd-\); the system toggle
                // would bring the sidebar column back beside them. It's
                // removed from the sidebar column, where it's declared.
                .toolbar(removing: window.fullscreenEditor ? .sidebarToggle : nil)
        } detail: {
            detail
        }
        .navigationTitle(repo.name)
        .navigationSubtitle(repo.view?.branch ?? "")
        .toolbar { toolbar }
        .onChange(of: repo.selectedKey) { _, key in
            Task {
                if let key { await repo.openFile(key) } else { await repo.closeFile() }
            }
        }
        .onChange(of: repo.document?.key) { _, _ in
            Task { await window.preview.follow(repo: repo) }
        }
        .onChange(of: PreviewTarget(root: repo.view?.root, choosing: repo.view?.workspaceCandidates != nil, loading: repo.view?.loading ?? true)) {
            Task { await window.syncPreview() }
        }
        .onChange(of: repo.view?.branch) { old, new in
            // As on desktop: a checkout rewrote the working tree, so the dev
            // server restarts on the new code.
            guard let old, let new, old != new, window.preview.root == repo.view?.root else { return }
            Task { await window.preview.restart() }
        }
        .modifier(WorkspaceSheets(window: window, repo: repo))
    }

    // MARK: Panes

    @ViewBuilder
    private var detail: some View {
        if let view = repo.view, view.workspaceCandidates != nil {
            NavigationStack {
                WorkspaceChooserView(repo: repo, candidates: view.workspaceCandidates ?? [], dismissible: view.fileCount > 0 || !view.tree.isEmpty)
            }
        } else {
            // One layout for both modes, so entering or leaving the
            // full-screen editor keeps the editor (caret, undo, sheets) and
            // the preview's page: only sizes change.
            EditorPreviewSplit(fraction: $window.editorFraction, collapsed: window.fullscreenEditor) {
                editorPane
                    .frame(maxWidth: window.fullscreenEditor ? 760 : .infinity)
                    .frame(maxWidth: .infinity)
            } preview: {
                PreviewPane(window: window, preview: window.preview)
            }
            .overlay {
                if window.fullscreenEditor { fullscreenPanels }
            }
        }
    }

    @ViewBuilder
    private var editorPane: some View {
        if let document = repo.document {
            NavigationStack {
                EditorView(document: document)
            }
            .id(ObjectIdentifier(document))
        } else {
            ContentUnavailableView(
                "Select a file",
                systemImage: "doc.text",
                description: Text("Choose a page or post from the sidebar, or press ⌘O.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// The desktop app's full-screen rails: each edge reveals its panel on
    /// hover, Cmd-\ pins both, and Files stays pinned while no file is open.
    private var fullscreenPanels: some View {
        GeometryReader { proxy in
            let width = min(max((proxy.size.width - 760) / 2 - 24, 236), 320)
            HStack(spacing: 0) {
                FloatingRail(edge: .leading, title: "Files", symbol: "doc.on.doc", width: width,
                             pinned: window.floatingSidebars || repo.document == nil) {
                    RepoSidebarView(repo: repo)
                }
                Spacer(minLength: 0)
                FloatingRail(edge: .trailing, title: "Media", symbol: "photo.on.rectangle", width: width,
                             pinned: window.floatingSidebars) {
                    NavigationStack { MediaView(repo: repo) }
                }
            }
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button {
                window.toggleFullscreenEditor()
            } label: {
                Label(window.fullscreenEditor ? "Exit Full-Screen Editor" : "Full-Screen Editor",
                      systemImage: window.fullscreenEditor ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
            }
            .help("Full-screen editor (⇧⌘F)")
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if let git = repo.view?.git {
                if git.behindUpstream {
                    AsyncButton {
                        await repo.pull()
                    } label: {
                        Label("Pull", systemImage: "arrow.down.circle")
                    }
                    .help("Updates are available. Pull them before editing.")
                    .disabled(git.pulling)
                }
                Button {
                    repo.branchesOpen = true
                } label: {
                    Label(repo.view?.branch ?? "Branch", systemImage: "arrow.triangle.branch")
                        .labelStyle(.titleAndIcon)
                }
                .help("Switch or create a branch")
                if repo.view?.repo != nil {
                    Button {
                        window.deploymentsOpen = true
                    } label: {
                        DeploymentToolbarLabel(repo: repo)
                    }
                }
                Button {
                    repo.settingsOpen = true
                } label: {
                    Label("Site Settings", systemImage: "gearshape")
                }
                .help("Site settings")
                PublishButton(repo: repo)
                    .controlSize(.regular)
                    .frame(minWidth: 110)
            }
        }
    }
}

/// The workspace's sheets and alerts: publish, branches, settings,
/// deployments, quick open and the branch-conflict prompt.
private struct WorkspaceSheets: ViewModifier {
    @Bindable var window: MacWindowState
    @Bindable var repo: RepoModel

    func body(content: Content) -> some View {
        content
            .sheet(item: $repo.publish) { publish in
                PublishSheet(model: publish)
                    .frame(minWidth: 520, minHeight: 480)
                    .formStyle(.grouped)
            }
            .sheet(isPresented: $repo.branchesOpen) {
                BranchPickerView(repo: repo)
                    .frame(minWidth: 420, minHeight: 420)
                    .formStyle(.grouped)
            }
            .sheet(isPresented: $repo.settingsOpen) {
                SiteSettingsView(repo: repo)
                    .frame(minWidth: 480, minHeight: 440)
                    .formStyle(.grouped)
            }
            .sheet(item: $repo.collectionSettings) { collection in
                CollectionSettingsView(repo: repo, collection: collection)
                    .frame(minWidth: 480, minHeight: 440)
                    .formStyle(.grouped)
            }
            .sheet(isPresented: $repo.collectionOrderOpen) {
                CollectionOrderView(repo: repo)
                    .frame(minWidth: 380, minHeight: 420)
                    .formStyle(.grouped)
            }
            .sheet(isPresented: $window.deploymentsOpen) {
                NavigationStack {
                    DeploymentsView(repo: repo)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) { CloseButton("Done") { window.deploymentsOpen = false } }
                        }
                }
                .frame(minWidth: 420, minHeight: 460)
                .formStyle(.grouped)
            }
            .sheet(isPresented: $window.quickOpen) {
                QuickOpenView(repo: repo) { key in
                    window.quickOpen = false
                    repo.selectedKey = key
                }
            }
            .sheet(isPresented: $window.recentOpen) {
                RecentFoldersView(roots: window.app.recentRoots) { root in
                    window.recentOpen = false
                    Task { await window.open(root) }
                }
            }
            .alert(
                "Unpublished changes in the way",
                isPresented: Binding(get: { repo.view?.branchConflict != nil }, set: { if !$0 { Task { await repo.clearBranchConflict() } } }),
                presenting: repo.view?.branchConflict
            ) { _ in
                Button("Cancel", role: .cancel) { Task { await repo.clearBranchConflict() } }
                Button("Discard Changes and Switch", role: .destructive) { Task { await repo.forceSwitchBranch() } }
            } message: { conflict in
                Text("Switching to \(conflict.branch) would overwrite your unpublished changes to:\n\n\(conflict.files.joined(separator: "\n"))\n\nPublish first to keep them, or discard them and switch.")
            }
            .errorAlert($repo.openError)
    }
}

/// The sidebar: files or the media library, switched like the desktop app's
/// two header icons.
struct MacSidebar: View {
    @Bindable var window: MacWindowState
    let repo: RepoModel

    var body: some View {
        VStack(spacing: 0) {
            Picker("Sidebar", selection: $window.sidebarMode) {
                ForEach(MacWindowState.SidebarMode.allCases) { mode in
                    Label(mode.title, systemImage: mode.symbol).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            switch window.sidebarMode {
            case .files:
                RepoSidebarView(repo: repo)
            case .media:
                NavigationStack { MediaView(repo: repo) }
            }
        }
    }
}

/// Before a folder is open: Open Folder and the recent folders.
struct WelcomeView: View {
    let window: MacWindowState

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "doc.richtext")
                .font(.system(size: 54, weight: .light))
                .foregroundStyle(.tint)
            VStack(spacing: 6) {
                Text("Posto").font(.largeTitle.bold())
                Text("Open a site's folder to edit its pages and posts.")
                    .foregroundStyle(.secondary)
            }
            Button {
                window.chooseFolder()
            } label: {
                Label("Open Folder…", systemImage: "folder")
                    .frame(minWidth: 200)
            }
            .prominentActionStyle()
            .controlSize(.large)
            .keyboardShortcut("o")
            if !window.app.recentRoots.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Recent").font(.headline).foregroundStyle(.secondary)
                    ForEach(window.app.recentRoots.prefix(8), id: \.self) { root in
                        Button {
                            Task { await window.open(root) }
                        } label: {
                            HStack {
                                Image(systemName: "folder")
                                VStack(alignment: .leading) {
                                    Text(URL(fileURLWithPath: root).lastPathComponent)
                                    Text(root.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .padding(.vertical, 4)
                    }
                }
                .frame(width: 360)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Cmd-O: find a file by name and open it, as the desktop app's Open
/// File palette lists them ("Group · path").
struct QuickOpenView: View {
    let repo: RepoModel
    let onOpen: (String) -> Void

    var body: some View {
        PaletteView(placeholder: "Open a file", items: items, onOpen: onOpen)
    }

    private var items: [PaletteView.Item] {
        func collect(_ nodes: [TreeNode], group: String?) -> [PaletteView.Item] {
            nodes.flatMap { node in
                let name = group ?? node.label
                return node.files.map { file in
                    PaletteView.Item(id: file.key, title: file.label, subtitle: "\(name) · \(relative(file.path))")
                } + collect(node.children, group: name)
            }
        }
        let loose = (repo.view?.looseFiles ?? []).map { file in
            PaletteView.Item(id: file.key, title: file.label, subtitle: relative(file.path))
        }
        return loose + collect(repo.view?.tree ?? [], group: nil)
    }

    private func relative(_ path: String) -> String {
        path.replacingOccurrences(of: repo.repoRoot + "/", with: "")
    }
}

/// Shift-Cmd-O: the folders opened before, as the desktop app's Open
/// Recent palette.
struct RecentFoldersView: View {
    let roots: [String]
    let onOpen: (String) -> Void

    var body: some View {
        PaletteView(placeholder: "Open a recent folder", items: roots.map { root in
            PaletteView.Item(id: root, title: URL(fileURLWithPath: root).lastPathComponent,
                             subtitle: root.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
        }, onOpen: onOpen)
    }
}

/// A filterable list opened from the keyboard: type, arrow, Return.
struct PaletteView: View {
    struct Item: Identifiable {
        let id: String
        let title: String
        let subtitle: String
    }

    let placeholder: String
    let items: [Item]
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var highlighted = 0
    @FocusState private var focused: Bool

    private var shown: [Item] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return items }
        return items.filter { $0.title.lowercased().contains(needle) || $0.subtitle.lowercased().contains(needle) }
    }

    var body: some View {
        let shown = shown
        VStack(spacing: 0) {
            TextField(placeholder, text: $query)
                .textFieldStyle(.plain)
                .font(.title3)
                .padding(14)
                .focused($focused)
                .onSubmit {
                    if shown.indices.contains(highlighted) { onOpen(shown[highlighted].id) }
                }
                .onKeyPress(.downArrow) { highlighted = min(highlighted + 1, max(shown.count - 1, 0)); return .handled }
                .onKeyPress(.upArrow) { highlighted = max(highlighted - 1, 0); return .handled }
                .onKeyPress(.escape) { dismiss(); return .handled }
            Divider()
            ScrollViewReader { proxy in
                List(Array(shown.enumerated()), id: \.element.id) { index, item in
                    Button {
                        onOpen(item.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title)
                            Text(item.subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(index == highlighted ? Color.accentColor.opacity(0.18) : Color.clear)
                    .id(index)
                }
                .onChange(of: highlighted) { _, index in proxy.scrollTo(index) }
            }
        }
        .frame(width: 560, height: 420)
        .onAppear { focused = true }
        .onChange(of: query) { highlighted = 0 }
    }
}

/// Settings (Cmd-,): developer mode and the GitHub account used for
/// deployments, as in the desktop app.
struct MacSettingsView: View {
    let app: AppModel

    var body: some View {
        Form {
            Section("Editing") {
                Toggle("Developer mode", isOn: Binding(get: { app.developerMode }, set: { app.setDeveloperMode($0) }))
                Text("Shows raw files, collection settings and field templates.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("GitHub") {
                if app.stage == .authorizing {
                    DeviceCodeView(app: app)
                        .frame(height: 300)
                } else if let user = app.user {
                    LabeledContent("Signed in as", value: user.login)
                    AsyncButton("Sign Out", role: .destructive) { await app.signOut() }
                } else {
                    Text("Sign in to see deployments. Publishing uses this Mac's own git credentials.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    AsyncButton("Sign In with GitHub") { await app.signIn(loadsRepositories: false) }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .padding(.vertical, 8)
    }
}

/// The editor and the preview side by side, with a divider to drag. Each is
/// pinned to the space it's given: an HSplitView sized itself from the
/// editor's full height, so a long body pushed the panes past the window.
/// `collapsed` (the full-screen editor) gives the editor everything and
/// keeps the preview alive at zero width.
struct EditorPreviewSplit<Editor: View, Preview: View>: View {
    @Binding var fraction: CGFloat
    let collapsed: Bool
    @ViewBuilder let editor: Editor
    @ViewBuilder let preview: Preview
    @State private var dragStart: CGFloat?

    private let minEditor: CGFloat = 380
    private let minPreview: CGFloat = 320
    private let handle: CGFloat = 6

    var body: some View {
        GeometryReader { proxy in
            let total = proxy.size.width
            let editorWidth = collapsed ? total : editorWidth(in: total)
            HStack(spacing: 0) {
                editor
                    .frame(width: editorWidth, height: proxy.size.height)
                    .clipped()
                divider(total: total, editorWidth: editorWidth)
                    .frame(width: collapsed ? 0 : handle, height: proxy.size.height)
                    .opacity(collapsed ? 0 : 1)
                preview
                    .frame(width: max(total - editorWidth - (collapsed ? 0 : handle), 0), height: proxy.size.height)
                    .clipped()
                    .opacity(collapsed ? 0 : 1)
                    .allowsHitTesting(!collapsed)
            }
        }
    }

    private func editorWidth(in total: CGFloat) -> CGFloat {
        let wanted = (total - handle) * fraction
        guard total - handle > minEditor + minPreview else { return wanted.rounded() }
        return min(max(wanted, minEditor), total - handle - minPreview).rounded()
    }

    private func divider(total: CGFloat, editorWidth: CGFloat) -> some View {
        ZStack {
            Color.clear
            Rectangle()
                .fill(Color(nsColor: .separatorColor))
                .frame(width: 1)
        }
        .contentShape(.rect)
        .onContinuousHover { phase in
            switch phase {
            case .active: NSCursor.resizeLeftRight.set()
            case .ended: NSCursor.arrow.set()
            }
        }
        .gesture(
            DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { value in
                    let start = dragStart ?? editorWidth
                    if dragStart == nil { dragStart = editorWidth }
                    fraction = min(max((start + value.translation.width) / max(total - handle, 1), 0.15), 0.85)
                }
                .onEnded { _ in dragStart = nil }
        )
    }
}

/// One edge of the full-screen editor: a strip that reveals its panel on
/// hover, as the desktop app's rails do.
private struct FloatingRail<Content: View>: View {
    let edge: HorizontalEdge
    let title: String
    let symbol: String
    let width: CGFloat
    let pinned: Bool
    @ViewBuilder let content: Content
    @State private var overRail = false
    @State private var overPanel = false

    var body: some View {
        let shown = pinned || overRail || overPanel
        Color.clear
            .frame(width: 100)
            .frame(maxHeight: .infinity)
            .contentShape(.rect)
            .onHover { overRail = $0 }
            .overlay(alignment: edge == .leading ? .topLeading : .topTrailing) {
                if shown {
                    panel
                        .frame(width: width)
                        .frame(maxHeight: .infinity)
                        .padding(12)
                        .onHover { overPanel = $0 }
                        .transition(.opacity.combined(with: .offset(x: edge == .leading ? -12 : 12)))
                }
            }
            .animation(.easeOut(duration: 0.12), value: shown)
    }

    private var panel: some View {
        VStack(spacing: 0) {
            Label(title, systemImage: symbol)
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            Divider()
            NavigationStack { content }
        }
        .glassPanel(cornerRadius: 14, fallback: AnyShapeStyle(.regularMaterial))
        .shadow(radius: 12, y: 4)
    }
}
