import SwiftUI

/// The repository home: notices, the collection/folder tree, and Publish.
struct RepoSidebarView: View {
    @Bindable var repo: RepoModel
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// Find a file (iOS): filters every file by title and path.
    @State private var query = ""
    @State private var searchPresented = false

    var body: some View {
        List(selection: $repo.selectedKey) {
            // Nothing but the loading state until the files are listed: a
            // half-opened repository's notices would read as broken.
            if let view = repo.view, !view.loading {
                notices
                if let results = searchResults(view) {
                    Section {
                        ForEach(results) { item in
                            FileRow(repo: repo, file: item.file, subtitle: item.subtitle)
                        }
                    }
                } else {
                    let looseFiles = listedLooseFiles(view)
                    if !looseFiles.isEmpty {
                        Section {
                            ForEach(looseFiles) { file in
                                FileRow(repo: repo, file: file)
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
        }
        .listStyle(.sidebar)
        .navigationTitle(repo.name)
        .inlineNavigationTitle()
        .refreshable { await repo.refresh() }
        .overlay { emptyState }
        #if os(iOS)
        .searchable(text: $query, isPresented: $searchPresented, placement: .alwaysVisible, prompt: "Find a file")
        .onChange(of: repo.findFileRequests) { searchPresented = true }
        // The engine's notices float over whichever column is in use; the
        // editor shows them while a file is open (RepoWorkspaceView).
        .safeAreaInset(edge: .top, spacing: 0) {
            if repo.document == nil { StatusBanner(repo: repo) }
        }
        #endif
        #if os(iOS)
        // The macOS app keeps Publish and these controls in its window toolbar.
        .softBottomScrollEdge()
        .safeAreaInset(edge: .bottom) {
            PublishButton(repo: repo)
                .padding(.horizontal)
                .padding(.vertical, 10)
                .floatingBarBackground()
        }
        .toolbar {
            ToolbarItem(placement: .barLeading) {
                Button {
                    Task { await repo.app.leaveRepo() }
                } label: {
                    Label("Repositories", systemImage: "chevron.backward")
                }
            }
            ToolbarItem(placement: .barTrailing) {
                Button {
                    repo.settingsOpen = true
                } label: {
                    Label("Site Settings", systemImage: "gearshape")
                }
            }
        }
        #endif
    }

    /// iOS opens the README from Settings, so the list leaves it out; the
    /// macOS app keeps it with the other files.
    private func listedLooseFiles(_ view: RepoView) -> [TreeFile] {
        #if os(iOS)
        view.looseFilesWithoutReadme
        #else
        view.looseFiles
        #endif
    }

    /// The files the list shows, without the search.
    private func listedFileCount(_ view: RepoView) -> Int {
        #if os(iOS)
        view.fileCount - (view.readme == nil ? 0 : 1)
        #else
        view.fileCount
        #endif
    }

    /// The matches while searching (every file, the README included), or
    /// nil for the tree.
    private func searchResults(_ view: RepoView) -> [SearchableFile]? {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return nil }
        return view.searchableFiles.filter { $0.matches(needle) }
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
                            await redownload()
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
                            .glassActionStyle()
                            .disabled(view.git.pulling)
                    }
                } footer: {
                    Text("Pull the latest changes before editing.")
                }
            }
            #if os(macOS)
            // iOS shows these in a banner over the column in use.
            if let status = view.status {
                Section {
                    HStack(alignment: .top) {
                        NoticeRow(
                            message: status.message,
                            systemImage: status.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill",
                            tint: status.isError ? .red : .green
                        )
                        Spacer(minLength: 0)
                        Button {
                            Task { await repo.dismissStatus(status) }
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Dismiss")
                    }
                }
                .id(status.id)
            }
            #endif
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

    /// Removes the damaged copy and downloads it again. The repository
    /// closes first, so a failed removal shows on the repository list.
    private func redownload() async {
        let app = repo.app
        do {
            try await app.redownload(repo.github, root: repo.repoRoot)
        } catch {
            app.error = "Could not remove \(repo.name) from this device: \(error.localizedDescription)"
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if let view = repo.view, !view.loading {
            if let results = searchResults(view) {
                if results.isEmpty { ContentUnavailableView.search(text: query) }
            } else if listedFileCount(view) == 0, view.error == nil, view.repairError == nil, view.workspaceCandidates == nil {
                #if os(iOS)
                let readme = view.readme
                #else
                let readme: TreeFile? = nil
                #endif
                ContentUnavailableView {
                    Label("No editable files found", systemImage: "doc.text.magnifyingglass")
                } description: {
                    Text(readme == nil
                         ? "Markdown, MDX, text, and stylesheet files will appear here."
                         : "Markdown, MDX, text, and stylesheet files will appear here. The project's README is in Settings.")
                } actions: {
                    if let readme {
                        Button("Open README") { repo.selectedKey = readme.key }
                            .glassActionStyle()
                    }
                }
            }
        } else {
            LoadingView("Loading files…")
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

/// A spinner with what it's waiting for. With a delay, quick loads show
/// nothing rather than a flash of spinner.
struct LoadingView: View {
    let title: String
    let delay: Duration
    @State private var delayed = false

    init(_ title: String, delay: Duration = .zero) {
        self.title = title
        self.delay = delay
    }

    var body: some View {
        VStack(spacing: 12) {
            if delay == .zero || delayed {
                ProgressView()
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            guard delay > .zero else { return }
            try? await Task.sleep(for: delay)
            delayed = true
        }
    }
}

/// A collection or top-level folder: a collapsible section with its files
/// and nested folders.
private struct TreeSection: View {
    let repo: RepoModel
    let node: TreeNode

    var body: some View {
        Section(isExpanded: Binding(
            get: { repo.isExpanded(node, default: node.defaultOpen) },
            set: { repo.setExpanded(node, $0) }
        )) {
            ForEach(node.files) { file in
                FileRow(repo: repo, file: file)
            }
            ForEach(node.children) { child in
                FolderRow(repo: repo, node: child)
            }
        } header: {
            HStack {
                Text(node.label)
                Spacer()
                NodeActions(repo: repo, node: node)
            }
        }
    }
}

/// A nested folder: the same New File and (developer mode) collection
/// settings buttons as a section, as the Tauri file tree has on every
/// folder.
private struct FolderRow: View {
    let repo: RepoModel
    let node: TreeNode

    var body: some View {
        DisclosureGroup(isExpanded: Binding(
            get: { repo.isExpanded(node, default: node.defaultOpen) },
            set: { repo.setExpanded(node, $0) }
        )) {
            ForEach(node.files) { file in
                FileRow(repo: repo, file: file)
            }
            ForEach(node.children) { child in
                FolderRow(repo: repo, node: child)
            }
        } label: {
            HStack {
                Label(node.label, systemImage: "folder")
                Spacer()
                NodeActions(repo: repo, node: node)
                    .buttonStyle(.borderless)
            }
            .contextMenu {
                if node.canCreate {
                    Button {
                        Task { await repo.createFile(in: node) }
                    } label: {
                        Label("New File", systemImage: "doc.badge.plus")
                    }
                }
                if let collection = node.collection {
                    Button {
                        repo.collectionSettings = collection
                    } label: {
                        Label("Collection Settings", systemImage: "slider.horizontal.3")
                    }
                }
            }
        }
    }
}

/// A folder's buttons: collection settings (developer mode) and New File.
private struct NodeActions: View {
    let repo: RepoModel
    let node: TreeNode

    var body: some View {
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

/// A file: opens on tap; swipe or the context menu deletes it, after
/// confirming, as the desktop list's delete button does.
private struct FileRow: View {
    let repo: RepoModel
    let file: TreeFile
    /// Where it sits, in search results.
    var subtitle: String?
    @State private var confirmingDelete = false

    var body: some View {
        NavigationLink(value: file.key) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.label).lineLimit(1)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            } icon: {
                Image(systemName: file.pinned ? "pin" : "doc.text")
            }
        }
        // Not a destructive role: that would take the row out before the
        // deletion is confirmed.
        .swipeActions(edge: .trailing) {
            Button {
                confirmingDelete = true
            } label: {
                Label("Delete", systemImage: "trash")
            }
            .tint(.red)
        }
        .contextMenu {
            Button(role: .destructive) {
                confirmingDelete = true
            } label: {
                Label("Delete…", systemImage: "trash")
            }
        }
        .confirmationDialog("Delete \(file.label)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button(isDataEntry ? "Delete Entry" : "Delete File", role: .destructive) {
                Task { await repo.deleteFile(file.key) }
            }
        } message: {
            Text(isDataEntry
                 ? "The entry \(file.name) will be removed from \(file.path.lastPathComponent)."
                 : "\(file.name) will be permanently deleted.")
        }
        .tag(file.key)
    }

    /// An entry of a data file (its key adds the entry to the file's path).
    private var isDataEntry: Bool { file.key != file.path }
}

struct PublishButton: View {
    let repo: RepoModel

    var body: some View {
        let git = repo.view?.git
        let busy = git?.publishing == true || git?.checkingChanges == true
        return Button {
            repo.openPublish()
        } label: {
            HStack(spacing: 8) {
                if busy { ProgressView() }
                Text(title(git))
            }
            .frame(maxWidth: .infinity)
        }
        .prominentActionStyle()
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
