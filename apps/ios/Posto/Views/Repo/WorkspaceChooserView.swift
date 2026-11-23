import SwiftUI

/// Picks which project directory of a multi-site repository to edit.
struct WorkspaceChooserView: View {
    let repo: RepoModel
    /// Nil loads the candidates (opened from Settings), leaving the open
    /// project in place until one is picked: backing out returns to it.
    let candidates: [WorkspaceCandidate]?
    /// The chooser was opened over a project it can go back to.
    let dismissible: Bool
    @State private var loaded: [WorkspaceCandidate]?
    @State private var loadError: String?

    var body: some View {
        let shown = candidates ?? loaded
        List {
            Section {
                ForEach(shown ?? []) { candidate in
                    Button {
                        Task {
                            await repo.chooseWorkspace(candidate.dir)
                            repo.settingsOpen = false
                        }
                    } label: {
                        HStack {
                            Label(candidate.label, systemImage: "folder")
                                .foregroundStyle(.primary)
                            Spacer()
                            if candidate.type != "generic" {
                                Text(candidate.type.capitalized)
                                    .font(.caption.weight(.medium))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(.tint.opacity(0.15), in: .capsule)
                            }
                        }
                    }
                }
            } header: {
                Text("Choose a site in this repository")
            } footer: {
                Text("Posto edits and publishes one project directory at a time.")
            }
            Section {
                NavigationLink {
                    DirectoryBrowserView(repo: repo, directory: repo.repoRoot)
                } label: {
                    Label("Browse inside this repository", systemImage: "folder.badge.gearshape")
                }
            }
        }
        .overlay {
            if let loadError, shown == nil {
                ContentUnavailableView {
                    Label("Couldn't look for projects", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(loadError)
                } actions: {
                    Button("Try Again") { Task { await load() } }
                        .glassActionStyle()
                }
            } else if shown == nil {
                ProgressView()
            } else if shown?.isEmpty == true {
                ContentUnavailableView("No projects found", systemImage: "questionmark.folder", description: Text("No supported project markers were found in the workspace."))
            }
        }
        .navigationTitle("Choose Project")
        .toolbar {
            if candidates != nil && dismissible {
                // Opened over a project (the Mac's Open Sibling Project):
                // back to it.
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        Task { await repo.cancelWorkspaceChooser() }
                    }
                }
            }
            #if os(iOS)
            // Back to the repository list (iPhone's stack has a back button
            // of its own); the macOS app has none (it opens folders), so
            // there it would just close the folder.
            if candidates != nil && !dismissible && !PhoneNavigation.isActive {
                ToolbarItem(placement: .barLeading) {
                    Button {
                        repo.app.leaveRepo()
                    } label: {
                        Label("Repositories", systemImage: "chevron.backward")
                    }
                }
            }
            #endif
        }
        .task {
            guard candidates == nil, loaded == nil else { return }
            await load()
        }
    }

    private func load() async {
        loadError = nil
        do {
            loaded = try await repo.workspaceCandidates()
        } catch {
            loadError = error.localizedDescription
        }
    }
}

/// Lazily browses the repository's folders to pick any directory as the
/// project root.
struct DirectoryBrowserView: View {
    let repo: RepoModel
    let directory: String
    @State private var children: [String]?
    @State private var loadError: String?

    var body: some View {
        List {
            Section {
                Button {
                    Task {
                        await repo.chooseWorkspace(directory)
                        repo.settingsOpen = false
                    }
                } label: {
                    Label("Use This Folder", systemImage: "checkmark.circle")
                }
            } footer: {
                Text(directory == repo.repoRoot ? "Repository root" : String(directory.dropFirst(repo.repoRoot.count + 1)))
            }
            Section("Folders") {
                if let loadError {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Couldn't list the folders here", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                        Text(loadError).font(.footnote)
                        AsyncButton("Try Again") { await load() }
                    }
                }
                ForEach(children ?? [], id: \.self) { child in
                    NavigationLink {
                        DirectoryBrowserView(repo: repo, directory: child)
                    } label: {
                        Label(child.lastPathComponent, systemImage: "folder")
                    }
                }
            }
        }
        .overlay {
            if children == nil && loadError == nil { ProgressView() }
        }
        .navigationTitle(directory == repo.repoRoot ? "Repository root" : directory.lastPathComponent)
        .task {
            guard children == nil else { return }
            await load()
        }
    }

    private func load() async {
        loadError = nil
        do {
            children = try await repo.childDirectories(of: directory)
        } catch {
            loadError = error.localizedDescription
        }
    }
}
