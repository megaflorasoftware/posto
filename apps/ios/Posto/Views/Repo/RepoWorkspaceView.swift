import SwiftUI

/// One repository: the file tree as a sidebar and the editor as the detail.
/// iPhone collapses this to the same stack the Tauri app used (files, then
/// the editor); iPad keeps both columns.
struct RepoWorkspaceView: View {
    @Bindable var repo: RepoModel
    @State private var columns = NavigationSplitViewVisibility.all

    var body: some View {
        Group {
            if let view = repo.view, view.workspaceCandidates != nil, !repo.settingsOpen {
                NavigationStack {
                    WorkspaceChooserView(repo: repo, candidates: view.workspaceCandidates ?? [], dismissible: view.canCancelWorkspaceChooser)
                }
            } else {
                NavigationSplitView(columnVisibility: $columns) {
                    RepoSidebarView(repo: repo)
                        .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 420)
                } detail: {
                    detail
                }
                .navigationSplitViewStyle(.balanced)
            }
        }
        .onChange(of: repo.selectedKey) { _, key in
            // Selecting a row opens it; navigating back (iPhone) closes it,
            // which flushes the save and refreshes the publish state.
            Task {
                if let key { await repo.openFile(key) } else { await repo.closeFile() }
            }
        }
        .sheet(isPresented: $repo.settingsOpen) {
            SiteSettingsView(repo: repo)
        }
        .sheet(item: $repo.publish) { publish in
            PublishSheet(model: publish)
        }
        .sheet(isPresented: $repo.branchesOpen) {
            BranchPickerView(repo: repo)
        }
        .sheet(item: $repo.collectionSettings) { collection in
            CollectionSettingsView(repo: repo, collection: collection)
        }
        .sheet(isPresented: $repo.collectionOrderOpen) {
            CollectionOrderView(repo: repo)
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

    /// The open file; a spinner while one is on its way in (rather than
    /// the empty state, then the file popping in); else the empty state.
    @ViewBuilder
    private var detail: some View {
        if let document = repo.document, !repo.isOpeningAnotherFile {
            // The editor pushes pages of its own (list items,
            // reference pickers, the full-screen body).
            NavigationStack {
                EditorView(document: document)
                    // The engine's notices, where the user is editing.
                    .safeAreaInset(edge: .top, spacing: 0) {
                        StatusBanner(repo: repo)
                    }
            }
            // The open document, not its path: a template rename
            // keeps the editor (keyboard, sheets) in place.
            .id(ObjectIdentifier(document))
        } else if repo.isOpeningAnotherFile || repo.selectedKey != nil {
            // A row was just chosen (iPhone pushes this before the open
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
