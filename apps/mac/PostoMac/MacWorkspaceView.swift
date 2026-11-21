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
            await window.startPreviewIfOpen()
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

extension MacWindowState {
    /// The folder restored at launch gets its preview server too.
    func startPreviewIfOpen() async {
        if let repo = app.repo, repo.view?.error == nil, preview.state == .idle {
            await preview.start(root: repo.view?.root ?? repo.repoRoot)
        }
    }
}

/// One open folder in the Tauri desktop app's layout: the files or media
/// sidebar, the editor, and the site preview beside it. The full-screen
/// editor hides both, with the sidebars floating over it on Cmd-\.
struct MacWorkspaceView: View {
    @Bindable var window: MacWindowState
    @Bindable var repo: RepoModel

    var body: some View {
        NavigationSplitView(columnVisibility: $window.columns) {
            MacSidebar(window: window, repo: repo)
                .navigationSplitViewColumnWidth(min: 220, ideal: 270, max: 420)
        } detail: {
            Group {
                if window.fullscreenEditor {
                    fullscreenEditor
                } else if let view = repo.view, view.workspaceCandidates != nil {
                    NavigationStack {
                        WorkspaceChooserView(repo: repo, candidates: view.workspaceCandidates ?? [], dismissible: view.fileCount > 0 || !view.tree.isEmpty)
                    }
                } else {
                    HSplitView {
                        editorPane
                            .frame(minWidth: 380, idealWidth: 560, maxWidth: .infinity, maxHeight: .infinity)
                        PreviewPane(window: window, preview: window.preview)
                            .frame(minWidth: 320, idealWidth: 700, maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        .onChange(of: window.fullscreenEditor) { _, fullscreen in
            // The sidebar column stays put; full screen covers it.
            if !fullscreen { window.columns = .all }
        }
        .modifier(WorkspaceSheets(window: window, repo: repo))
    }

    // MARK: Panes

    @ViewBuilder
    private var editorPane: some View {
        if let document = repo.document {
            NavigationStack {
                EditorView(document: document)
            }
            .id(document.key)
        } else {
            ContentUnavailableView(
                "Select a file",
                systemImage: "doc.text",
                description: Text("Choose a page or post from the sidebar, or press ⌘P.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var fullscreenEditor: some View {
        ZStack {
            editorPane
                .frame(maxWidth: 860)
                .frame(maxWidth: .infinity)
            if window.floatingSidebars {
                HStack(alignment: .top) {
                    floatingPanel("Files", symbol: "doc.on.doc") {
                        RepoSidebarView(repo: repo)
                    }
                    Spacer()
                    floatingPanel("Media", symbol: "photo.on.rectangle") {
                        MediaView(repo: repo)
                    }
                }
                .padding(12)
                .transition(.opacity)
            }
        }
    }

    private func floatingPanel<Content: View>(_ title: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            Label(title, systemImage: symbol)
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            Divider()
            NavigationStack { content() }
        }
        .frame(width: 300)
        .frame(maxHeight: .infinity)
        .glassPanel(cornerRadius: 14, fallback: AnyShapeStyle(.regularMaterial))
        .shadow(radius: 12, y: 4)
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
                        Label("Deployments", systemImage: "antenna.radiowaves.left.and.right")
                    }
                    .help("Deployments")
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
            .sheet(item: $repo.publish, onDismiss: { repo.publish?.close() }) { publish in
                PublishSheet(model: publish)
                    .frame(minWidth: 520, minHeight: 480)
            }
            .sheet(isPresented: $repo.branchesOpen) {
                BranchPickerView(repo: repo)
                    .frame(minWidth: 420, minHeight: 420)
            }
            .sheet(isPresented: $repo.settingsOpen) {
                SiteSettingsView(repo: repo)
                    .frame(minWidth: 480, minHeight: 440)
            }
            .sheet(item: $repo.collectionSettings) { collection in
                CollectionSettingsView(repo: repo, collection: collection)
                    .frame(minWidth: 480, minHeight: 440)
            }
            .sheet(isPresented: $repo.collectionOrderOpen) {
                CollectionOrderView(repo: repo)
                    .frame(minWidth: 380, minHeight: 420)
            }
            .sheet(isPresented: $window.deploymentsOpen) {
                NavigationStack {
                    DeploymentsView(repo: repo)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) { CloseButton("Done") { window.deploymentsOpen = false } }
                        }
                }
                .frame(minWidth: 420, minHeight: 460)
            }
            .sheet(isPresented: $window.quickOpen) {
                QuickOpenView(repo: repo) { key in
                    window.quickOpen = false
                    repo.selectedKey = key
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

/// Cmd-P: find a file by name and open it.
struct QuickOpenView: View {
    let repo: RepoModel
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var highlighted = 0
    @FocusState private var focused: Bool

    private var files: [TreeFile] {
        func collect(_ nodes: [TreeNode]) -> [TreeFile] {
            nodes.flatMap { $0.files + collect($0.children) }
        }
        let all = (repo.view?.looseFiles ?? []) + collect(repo.view?.tree ?? [])
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return Array(all.prefix(50)) }
        return all.filter { $0.label.lowercased().contains(needle) || $0.path.lowercased().contains(needle) }
            .prefix(50).map { $0 }
    }

    var body: some View {
        VStack(spacing: 0) {
            TextField("Open a file", text: $query)
                .textFieldStyle(.plain)
                .font(.title3)
                .padding(14)
                .focused($focused)
                .onSubmit {
                    if files.indices.contains(highlighted) { onOpen(files[highlighted].key) }
                }
                .onKeyPress(.downArrow) { highlighted = min(highlighted + 1, max(files.count - 1, 0)); return .handled }
                .onKeyPress(.upArrow) { highlighted = max(highlighted - 1, 0); return .handled }
                .onKeyPress(.escape) { dismiss(); return .handled }
            Divider()
            ScrollViewReader { proxy in
                List(Array(files.enumerated()), id: \.element.key) { index, file in
                    Button {
                        onOpen(file.key)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(file.label)
                            Text(file.path.replacingOccurrences(of: repo.repoRoot + "/", with: ""))
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
