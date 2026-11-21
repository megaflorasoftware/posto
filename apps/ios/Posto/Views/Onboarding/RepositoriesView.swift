import SwiftUI

/// The repository picker: downloaded sites first, then the rest of the
/// user's GitHub repositories, each downloading on first open.
struct RepositoriesView: View {
    let app: AppModel
    let switchDemo: (Bool) -> Void
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if let error = app.error, !app.repos.isEmpty {
                    Section {
                        NoticeRow(message: error, systemImage: "exclamationmark.triangle.fill", tint: .red)
                    }
                }
                let repos = app.sortedRepos(matching: query)
                ForEach(repos) { repo in
                    RepositoryRow(app: app, repo: repo)
                }
            }
            .groupedListStyle()
            .navigationTitle("Repositories")
            .searchable(text: $query, prompt: "Search repositories")
            .refreshable { await app.loadRepos() }
            .overlay {
                if app.repos.isEmpty {
                    if app.reposLoading || !app.reposLoaded {
                        ProgressView()
                    } else if app.error != nil {
                        ContentUnavailableView {
                            Label("Couldn't load repositories", systemImage: "wifi.exclamationmark")
                        } description: {
                            Text(app.error ?? "")
                        } actions: {
                            Button("Try Again") { Task { await app.loadRepos() } }
                                .glassActionStyle()
                        }
                    } else {
                        ContentUnavailableView("No repositories", systemImage: "folder", description: Text("Repositories you can access on GitHub appear here."))
                    }
                } else if !query.isEmpty && app.sortedRepos(matching: query).isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .toolbar {
                ToolbarItem(placement: .barTrailing) {
                    Button {
                        app.settingsOpen = true
                    } label: {
                        AvatarView(user: app.user)
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: Binding(get: { app.settingsOpen }, set: { app.settingsOpen = $0 })) {
                Group {
                    AppSettingsView(app: app, switchDemo: switchDemo)
                }
                .macSheetSizing()
            }
            .sheet(isPresented: Binding(
                get: { app.cloneState != .idle },
                set: { if !$0 { app.dismissCloneError() } }
            )) {
                Group {
                    CloneSheet(app: app)
                        .interactiveDismissDisabled(isCloning)
                }
                .macSheetSizing()
            }
        }
    }

    private var isCloning: Bool {
        if case .cloning = app.cloneState { return true }
        return false
    }
}

private struct RepositoryRow: View {
    let app: AppModel
    let repo: GitHubRepo

    var body: some View {
        let managed = app.managedRepo(for: repo)
        Button {
            Task { await app.choose(repo) }
        } label: {
            HStack(spacing: 14) {
                RepoIcon(root: managed?.root, isPrivate: repo.isPrivate)
                VStack(alignment: .leading, spacing: 2) {
                    Text(repo.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(repo.owner)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Image(systemName: managed == nil ? "icloud.and.arrow.down" : "chevron.right")
                    .font(managed == nil ? .body : .footnote.weight(.semibold))
                    .foregroundStyle(managed == nil ? Color.accentColor : Color.secondary.opacity(0.6))
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(app.cloneState != .idle)
        .swipeActions(edge: .trailing) {
            if let managed {
                Button(role: .destructive) {
                    Task { try? await app.removeRepo(root: managed.root) }
                } label: {
                    Label("Delete from device", systemImage: "trash")
                }
            }
        }
    }
}

/// A downloaded site's favicon when it has one, else a lock or folder.
private struct RepoIcon: View {
    let root: String?
    let isPrivate: Bool

    /// favicon.svg is Astro's default (the Tauri app looks for it too).
    private static let candidates = ["favicon.svg", "favicon.png", "favicon.ico", "apple-touch-icon.png"]

    var body: some View {
        let favicon = root.flatMap { root in
            Self.candidates.map { "\(root)/public/\($0)" }.first { FileManager.default.fileExists(atPath: $0) }
        }
        ZStack {
            RoundedRectangle(cornerRadius: 8).fill(.quaternary)
            if let favicon {
                Thumbnail(path: favicon, maxPixels: 96, placeholder: isPrivate ? "lock" : "folder")
                    .clipShape(.rect(cornerRadius: 8))
            } else {
                Image(systemName: isPrivate ? "lock.fill" : "folder.fill")
                    .foregroundStyle(isPrivate ? Color.accentColor : .secondary)
            }
        }
        .frame(width: 36, height: 36)
    }
}

struct AvatarView: View {
    let user: GitHubUser?

    var body: some View {
        Group {
            if let url = user.flatMap({ URL(string: $0.avatarURL) }) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Image(systemName: "person.crop.circle.fill").resizable()
                }
            } else {
                Image(systemName: "person.crop.circle.fill").resizable()
            }
        }
        .frame(width: 30, height: 30)
        .clipShape(.circle)
    }
}

/// Download progress, then the interrupted-download recovery screen.
private struct CloneSheet: View {
    let app: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                switch app.cloneState {
                case .cloning(let repo):
                    progress(repo)
                case .failed(let repo, let message):
                    failure(repo, message)
                case .idle:
                    EmptyView()
                }
            }
            .padding(24)
            .frame(maxWidth: 480)
            .inlineNavigationTitle()
        }
        .presentationDetents([.medium, .large])
    }

    private func progress(_ repo: GitHubRepo) -> some View {
        let progress = app.cloneProgress
        let megabytes = Double(progress.receivedBytes) / 1_048_576
        let detail: String
        if progress.checkingOut {
            detail = progress.checkoutTotal > 0 ? "\(progress.checkoutCompleted) of \(progress.checkoutTotal) files" : "Preparing files"
        } else {
            detail = megabytes >= 0.1 ? String(format: "%.1f MB", megabytes) : "\(progress.receivedObjects) objects"
        }
        return VStack(spacing: 20) {
            Image(systemName: "icloud.and.arrow.down")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.tint)
                .symbolEffect(.pulse)
            VStack(spacing: 6) {
                Text(repo.name).font(.title2.bold())
                Text(progress.checkingOut ? "Preparing downloaded files…" : "Downloading the latest repository snapshot…")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            ProgressView(value: progress.fraction) {
                HStack {
                    Text("\(Int((progress.fraction * 100).rounded()))%").fontWeight(.semibold)
                    Spacer()
                    Text(detail).foregroundStyle(.secondary)
                }
                .font(.footnote)
            }
            Text("Keep Posto open until the repository is ready. Large media libraries may take several minutes.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private func failure(_ repo: GitHubRepo, _ message: String) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Download interrupted").font(.title2.bold())
            Text(repo.fullName).foregroundStyle(.secondary)
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .font(.callout)
            Text("Large repositories need enough free space for both Git data and checked-out files. Keep the app open on a stable connection while retrying.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                Button("Choose Another") { app.dismissCloneError() }
                    .glassActionStyle()
                Spacer()
                Button {
                    Task { await app.download(repo) }
                } label: {
                    Label("Try Again", systemImage: "arrow.clockwise")
                }
                .prominentActionStyle()
            }
        }
    }
}
