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
                    WorkspaceChooserView(repo: repo, candidates: view.workspaceCandidates ?? [], dismissible: view.fileCount > 0 || view.tree.count > 0)
                }
            } else {
                NavigationSplitView(columnVisibility: $columns) {
                    RepoSidebarView(repo: repo)
                        .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 420)
                } detail: {
                    if let document = repo.document {
                        // The editor pushes pages of its own (list items,
                        // reference pickers, the full-screen body).
                        NavigationStack {
                            EditorView(document: document)
                        }
                        .id(document.key)
                    } else {
                        ContentUnavailableView(
                            "Select a file",
                            systemImage: "doc.text",
                            description: Text("Choose a page or post from the sidebar to edit it.")
                        )
                    }
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
        .sheet(item: $repo.publish, onDismiss: { repo.publish?.close() }) { publish in
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
}

extension PublishModel: Identifiable {
    nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }
}
