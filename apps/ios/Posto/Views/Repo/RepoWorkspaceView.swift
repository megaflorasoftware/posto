import SwiftUI

/// One repository on iPad: the file tree as a sidebar and the editor as
/// the detail. A narrow window collapses this to a stack (files, then the
/// editor). iPhone's stack starts at the repository list instead
/// (PhoneNavigation).
struct RepoWorkspaceView: View {
    let repo: RepoModel
    @State private var columns = NavigationSplitViewVisibility.all
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        Group {
            if repo.choosingWorkspace {
                NavigationStack {
                    RepoHomeView(repo: repo)
                }
            } else {
                NavigationSplitView(columnVisibility: $columns) {
                    RepoSidebarView(repo: repo)
                        .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 420)
                } detail: {
                    RepoDetailView(repo: repo)
                }
                .navigationSplitViewStyle(.balanced)
            }
        }
        .modifier(OpensSelectedFile(repo: repo))
        .focusedSceneValue(\.workspaceCommands, WorkspaceCommands(
            toggleSidebar: {
                columns = columns == .detailOnly ? .all : .detailOnly
            },
            findFile: {
                // A collapsed split view: back to the list, where the
                // search field is.
                if sizeClass == .compact {
                    repo.selectedKey = nil
                } else if columns == .detailOnly {
                    columns = .all
                }
                repo.requestFindFile()
            }
        ))
        .modifier(RepoPresentations(repo: repo))
    }
}

extension RepoModel {
    /// The repository is a folder of projects waiting for one to be picked
    /// (unless Settings, which has a chooser of its own, is open).
    var choosingWorkspace: Bool {
        view?.workspaceCandidates != nil && !settingsOpen
    }
}

/// The repository's own page: its files, or the project chooser while it
/// waits for one to be picked.
struct RepoHomeView: View {
    let repo: RepoModel

    var body: some View {
        if let view = repo.view, let candidates = view.workspaceCandidates, !repo.settingsOpen {
            WorkspaceChooserView(repo: repo, candidates: candidates, dismissible: view.canCancelWorkspaceChooser)
        } else {
            RepoSidebarView(repo: repo)
        }
    }
}

/// Opens the file whose row is chosen; navigating back clears the choice,
/// which closes the file: that flushes the save and refreshes the publish
/// state.
struct OpensSelectedFile: ViewModifier {
    /// Nil (iPhone, at the repository list) opens nothing: a repository
    /// that's leaving saves its open file as it closes.
    let repo: RepoModel?

    func body(content: Content) -> some View {
        content.onChange(of: repo?.selectedKey) { _, key in
            guard let repo else { return }
            Task {
                if let key { await repo.openFile(key) } else { await repo.closeFile() }
            }
        }
    }
}

/// The open file; a spinner while one is on its way in (rather than the
/// empty state, then the file popping in); else the empty state.
struct RepoDetailView: View {
    let repo: RepoModel
    /// iPad's detail column needs a stack of its own for the editor's pages
    /// (list items, reference pickers, the full-screen body); on iPhone they
    /// go onto the one stack.
    var ownsStack = true
    /// iPhone: the file the page shows. Back closes the file while its page
    /// is still sliding away; the page keeps showing it rather than flashing
    /// to the empty state.
    @State private var shown: DocumentModel?

    var body: some View {
        content
            .onChange(of: repo.document.map(ObjectIdentifier.init), initial: true) {
                if !ownsStack, let document = repo.document { shown = document }
            }
    }

    private var document: DocumentModel? {
        if let document = repo.document { return document }
        return ownsStack || repo.selectedKey != nil ? nil : shown
    }

    @ViewBuilder
    private var content: some View {
        if let document, !repo.isOpeningAnotherFile {
            editor(document)
                // The open document, not its path: a template rename
                // keeps the editor (keyboard, sheets) in place.
                .id(ObjectIdentifier(document))
        } else if repo.isOpeningAnotherFile || repo.selectedKey != nil {
            // A row was just chosen (a page is pushed before the open
            // starts) or a file is opening.
            LoadingView("Opening…", delay: .milliseconds(200))
        } else if repo.view?.loading ?? true {
            LoadingView("Loading files…")
        } else {
            ContentUnavailableView(
                "Select a file",
                systemImage: "doc.text",
                description: Text("Choose a page or post from the sidebar to edit it.")
            )
        }
    }

    @ViewBuilder
    private func editor(_ document: DocumentModel) -> some View {
        let page = EditorView(document: document)
            // The engine's notices, where the user is editing.
            .safeAreaInset(edge: .top, spacing: 0) {
                StatusBanner(repo: repo)
            }
        if ownsStack {
            NavigationStack { page }
        } else {
            page
        }
    }
}

/// The repository's sheets and alerts, over all of its navigation.
struct RepoPresentations: ViewModifier {
    /// Nil (iPhone, at the repository list) presents nothing.
    let repo: RepoModel?

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: flag(\.settingsOpen)) {
                SheetRepo(repo) { SiteSettingsView(repo: $0) }
            }
            .sheet(item: Binding(get: { repo?.publish }, set: { repo?.publish = $0 })) { publish in
                PublishSheet(model: publish)
            }
            .sheet(isPresented: flag(\.branchesOpen)) {
                SheetRepo(repo) { BranchPickerView(repo: $0) }
            }
            .sheet(item: Binding(get: { repo?.collectionSettings }, set: { repo?.collectionSettings = $0 })) { collection in
                SheetRepo(repo) { CollectionSettingsView(repo: $0, collection: collection) }
            }
            .sheet(isPresented: flag(\.collectionOrderOpen)) {
                SheetRepo(repo) { CollectionOrderView(repo: $0) }
            }
            .alert(
                "Unpublished changes in the way",
                isPresented: Binding(
                    get: { repo?.view?.branchConflict != nil },
                    set: { if !$0, let repo { Task { await repo.clearBranchConflict() } } }
                ),
                presenting: repo?.view?.branchConflict
            ) { _ in
                Button("Cancel", role: .cancel) {
                    if let repo { Task { await repo.clearBranchConflict() } }
                }
                Button("Discard Changes and Switch", role: .destructive) {
                    if let repo { Task { await repo.forceSwitchBranch() } }
                }
            } message: { conflict in
                Text("Switching to \(conflict.branch) would overwrite your unpublished changes to:\n\n\(conflict.files.joined(separator: "\n"))\n\nPublish first to keep them, or discard them and switch.")
            }
            .errorAlert(Binding(get: { repo?.openError }, set: { repo?.openError = $0 }))
    }

    private func flag(_ key: ReferenceWritableKeyPath<RepoModel, Bool>) -> Binding<Bool> {
        Binding(get: { repo?[keyPath: key] ?? false }, set: { repo?[keyPath: key] = $0 })
    }
}

/// A sheet's repository, fixed as the sheet opens: when the repository
/// closes under it (Delete from Device in Site Settings), the sheet slides
/// away still showing it rather than going blank.
private struct SheetRepo<Content: View>: View {
    @State private var repo: RepoModel?
    let content: (RepoModel) -> Content

    init(_ repo: RepoModel?, @ViewBuilder content: @escaping (RepoModel) -> Content) {
        _repo = State(initialValue: repo)
        self.content = content
    }

    var body: some View {
        if let repo { content(repo) }
    }
}

/// The engine's latest notice in a floating banner: errors stay until
/// dismissed (as the Tauri app's error toasts do), others clear themselves.
struct StatusBanner: View {
    let repo: RepoModel

    var body: some View {
        Group {
            if let status = repo.view?.status {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Group {
                        switch status.severity {
                        case "error":
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                        case "progress":
                            ProgressView().controlSize(.small)
                        default:
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        }
                    }
                    Text(status.message)
                        .font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Button {
                        Task { await repo.dismissStatus(status) }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(4)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .glassPanel(cornerRadius: 16)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .id(status.id)
                .transition(.move(edge: .top).combined(with: .opacity))
                .accessibilityElement(children: .combine)
            }
        }
        .animation(.snappy, value: repo.view?.status?.id)
    }
}

/// The workspace's commands that act on its own layout, for the menu bar
/// (PostoCommands).
struct WorkspaceCommands {
    let toggleSidebar: () -> Void
    let findFile: () -> Void
}

extension FocusedValues {
    @Entry var workspaceCommands: WorkspaceCommands?
}
