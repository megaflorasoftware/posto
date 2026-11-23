#if os(iOS)
import SwiftUI
import UIKit

/// iPhone: one navigation stack from the repository list to a repository's
/// files and on to the editor, so each slides in as it opens and Back (or a
/// swipe from the screen's edge) slides it away again. iPad keeps the split
/// view (RepoWorkspaceView) in place of the list.
struct PhoneNavigation: View {
    let app: AppModel
    let switchDemo: (Bool) -> Void

    /// Whether the app navigates this way: on iPhone, at any width (a large
    /// iPhone held sideways is a regular width, which would otherwise swap
    /// the stack for the split view and lose the editor's place).
    static var isActive: Bool {
        UIDevice.current.userInterfaceIdiom == .phone
    }

    var body: some View {
        NavigationStack(path: path) {
            RepositoryList(app: app)
                .navigationDestination(for: PhoneRoute.self) { route in
                    // The page's repository is its own, not the app's open
                    // one: a page sliding away after Back keeps showing the
                    // repository that closed as it went.
                    switch route.page {
                    case .repository: RepoHomeView(repo: route.repo)
                    case .editor: RepoDetailView(repo: route.repo, ownsStack: false)
                    }
                }
        }
        .modifier(OpensSelectedFile(repo: app.repo))
        .focusedSceneValue(\.workspaceCommands, app.repo.map { repo in
            WorkspaceCommands(
                toggleSidebar: {},
                findFile: {
                    // Back to the files, where the search field is.
                    repo.selectedKey = nil
                    repo.requestFindFile()
                }
            )
        })
        .modifier(RepoPresentations(repo: app.repo))
        .modifier(RepositorySheets(app: app, switchDemo: switchDemo))
    }

    /// The stack follows the models: the open repository, then its open
    /// file. Going back clears them, which closes them.
    private var path: Binding<[PhoneRoute]> {
        Binding {
            guard let repo = app.repo else { return [] }
            let home = PhoneRoute(page: .repository, repo: repo)
            guard let key = repo.selectedKey else { return [home] }
            return [home, PhoneRoute(page: .editor, repo: repo, key: key)]
        } set: { path in
            guard let repo = app.repo else { return }
            guard let home = path.first, home.repo === repo else {
                app.leaveRepo()
                return
            }
            let key = path.dropFirst().first?.key
            if repo.selectedKey != key { repo.selectedKey = key }
        }
    }
}

/// A page on the iPhone stack past the repository list.
struct PhoneRoute: Hashable {
    enum Page: Hashable {
        /// The repository's files (or its project chooser).
        case repository
        /// The open file.
        case editor
    }

    let page: Page
    let repo: RepoModel
    /// The file an editor page opens. Not part of the page's identity: a
    /// template rename changes the open file's key, and the editor stays
    /// where it is rather than being pushed again.
    var key: String?

    static func == (left: PhoneRoute, right: PhoneRoute) -> Bool {
        left.page == right.page && left.repo === right.repo
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(page)
        hasher.combine(ObjectIdentifier(repo))
    }
}
#endif
