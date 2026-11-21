import SwiftUI

/// Picks which project directory of a multi-site repository to edit.
struct WorkspaceChooserView: View {
    let repo: RepoModel
    /// Nil loads the candidates (opened from Settings).
    let candidates: [WorkspaceCandidate]?
    let dismissible: Bool
    @State private var loaded: [WorkspaceCandidate]?
    @Environment(\.dismiss) private var dismiss

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
            if shown == nil {
                ProgressView()
            } else if shown?.isEmpty == true {
                ContentUnavailableView("No projects found", systemImage: "questionmark.folder", description: Text("No supported project markers were found in the workspace."))
            }
        }
        .navigationTitle("Choose Project")
        .toolbar {
            #if os(iOS)
            // Back to the repository list; the macOS app has none (it opens
            // folders), so there it would just close the folder.
            if candidates != nil {
                ToolbarItem(placement: .barLeading) {
                    Button {
                        Task { await repo.app.closeRepo() }
                    } label: {
                        Label("Repositories", systemImage: "chevron.backward")
                    }
                }
            }
            #endif
        }
        .task {
            guard candidates == nil else { return }
            await repo.showWorkspaceChooser()
            loaded = repo.view?.workspaceCandidates ?? []
        }
    }
}

/// Lazily browses the repository's folders to pick any directory as the
/// project root.
struct DirectoryBrowserView: View {
    let repo: RepoModel
    let directory: String
    @State private var children: [String]?

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
            if children == nil { ProgressView() }
        }
        .navigationTitle(directory == repo.repoRoot ? "Repository root" : directory.lastPathComponent)
        .task { children = await repo.childDirectories(of: directory) }
    }
}
