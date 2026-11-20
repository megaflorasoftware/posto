import SwiftUI

/// The repository home: notices, the collection/folder tree, and Publish.
struct RepoSidebarView: View {
    @Bindable var repo: RepoModel
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        List(selection: $repo.selectedKey) {
            notices
            if let view = repo.view {
                if !view.looseFiles.isEmpty {
                    Section {
                        ForEach(view.looseFiles) { file in
                            FileRow(file: file)
                        }
                    }
                }
                ForEach(view.tree) { node in
                    TreeSection(repo: repo, node: node)
                }
                if repo.app.developerMode {
                    developerSection(view)
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle(repo.name)
        .refreshable { await repo.refresh() }
        .overlay { emptyState }
        .safeAreaInset(edge: .bottom) {
            PublishButton(repo: repo)
                .padding(.horizontal)
                .padding(.vertical, 10)
                .background(.bar)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    Task { await repo.app.closeRepo() }
                } label: {
                    Label("Repositories", systemImage: "chevron.backward")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    repo.settingsOpen = true
                } label: {
                    Label("Site Settings", systemImage: "gearshape")
                }
            }
        }
    }

    @ViewBuilder
    private var notices: some View {
        if let view = repo.view {
            if let repair = view.repairError {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("This repository needs to be downloaded again", systemImage: "exclamationmark.triangle.fill")
                            .font(.headline)
                            .foregroundStyle(.red)
                        Text(repair).font(.footnote)
                        Text("Remove the damaged local copy and download a clean copy from GitHub. Files that have not been published may be lost.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        AsyncButton(role: .destructive) {
                            try? await repo.app.redownload(repo.github, root: repo.repoRoot)
                        } label: {
                            Text("Remove and Redownload")
                        }
                        .buttonStyle(.bordered)
                    }
                    .padding(.vertical, 4)
                }
            }
            if view.git.behindUpstream {
                Section {
                    HStack {
                        Label("Updates are available", systemImage: "icloud.and.arrow.down")
                        Spacer()
                        AsyncButton("Pull") { await repo.pull() }
                            .buttonStyle(.bordered)
                            .disabled(view.git.pulling)
                    }
                } footer: {
                    Text("Pull the latest changes before editing.")
                }
            }
            if let status = view.status {
                Section {
                    NoticeRow(
                        message: status.message,
                        systemImage: status.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill",
                        tint: status.isError ? .red : .green
                    )
                }
                .id(status.id)
            }
            if let diagnostic = view.projectDiagnostic {
                Section("Project adapter fallback") {
                    NoticeRow(message: diagnostic, systemImage: "exclamationmark.triangle", tint: .orange)
                }
            }
            if let error = view.error {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Files could not be loaded", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                        Text(error).font(.footnote)
                        AsyncButton("Try Again") { await repo.refresh() }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if let view = repo.view, !view.loading, view.fileCount == 0, view.error == nil, view.repairError == nil {
            ContentUnavailableView(
                "No editable files found",
                systemImage: "doc.text.magnifyingglass",
                description: Text("Markdown, MDX, text, and stylesheet files will appear here.")
            )
        } else if repo.view == nil || repo.view?.loading == true {
            ProgressView()
        }
    }

    @ViewBuilder
    private func developerSection(_ view: RepoView) -> some View {
        if view.orderableCollections.count > 1 || !view.diagnostics.isEmpty {
            Section("Developer") {
                if view.orderableCollections.count > 1 {
                    Button {
                        repo.collectionOrderOpen = true
                    } label: {
                        Label("Collection Order", systemImage: "slider.horizontal.3")
                    }
                }
                if !view.diagnostics.isEmpty {
                    DisclosureGroup {
                        ForEach(Array(view.diagnostics.enumerated()), id: \.offset) { _, diagnostic in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(diagnostic.collection.map { "\($0) · \(diagnostic.feature)" } ?? diagnostic.feature)
                                    .font(.caption.weight(.semibold))
                                Text(diagnostic.message).font(.caption)
                            }
                        }
                    } label: {
                        Label("\(view.diagnostics.count) schema \(view.diagnostics.count == 1 ? "notice" : "notices")", systemImage: "exclamationmark.triangle")
                    }
                }
            }
        }
    }
}

/// A collection or top-level folder: a collapsible section with its files
/// and nested folders.
private struct TreeSection: View {
    let repo: RepoModel
    let node: TreeNode
    @State private var expanded = true

    var body: some View {
        Section(isExpanded: $expanded) {
            ForEach(node.files) { file in
                FileRow(file: file)
            }
            ForEach(node.children) { child in
                FolderRow(repo: repo, node: child)
            }
        } header: {
            HStack {
                Text(node.label)
                Spacer()
                if let collection = node.collection {
                    Button {
                        repo.collectionSettings = collection
                    } label: {
                        Image(systemName: "slider.horizontal.3")
                    }
                    .accessibilityLabel("\(node.label) settings")
                }
                if node.canCreate {
                    Button {
                        Task { await repo.createFile(in: node) }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New file in \(node.label)")
                }
            }
        }
        .onAppear { expanded = node.defaultOpen }
    }
}

private struct FolderRow: View {
    let repo: RepoModel
    let node: TreeNode

    var body: some View {
        DisclosureGroup {
            ForEach(node.files) { file in
                FileRow(file: file)
            }
            ForEach(node.children) { child in
                FolderRow(repo: repo, node: child)
            }
        } label: {
            Label(node.label, systemImage: "folder")
                .contextMenu {
                    if node.canCreate {
                        Button {
                            Task { await repo.createFile(in: node) }
                        } label: {
                            Label("New File", systemImage: "doc.badge.plus")
                        }
                    }
                }
        }
    }
}

private struct FileRow: View {
    let file: TreeFile

    var body: some View {
        NavigationLink(value: file.key) {
            Label {
                Text(file.label).lineLimit(1)
            } icon: {
                Image(systemName: file.pinned ? "pin" : "doc.text")
            }
        }
        .tag(file.key)
    }
}

private struct PublishButton: View {
    let repo: RepoModel

    var body: some View {
        let git = repo.view?.git
        let busy = git?.publishing == true || git?.checkingChanges == true
        Button {
            repo.openPublish()
        } label: {
            HStack(spacing: 8) {
                if busy { ProgressView() }
                Text(title(git))
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(git?.canPublish != true || busy)
    }

    private func title(_ git: GitStatus?) -> String {
        guard let git else { return "Publish…" }
        if git.publishing { return "Publishing…" }
        if git.checkingChanges { return "Checking changes…" }
        return git.canPublish ? "Publish…" : "Up to date"
    }
}
