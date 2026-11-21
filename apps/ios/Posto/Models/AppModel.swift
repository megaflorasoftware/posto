import Foundation
import Observation

/// App-level state: sign-in, the repository list, downloads, settings, and
/// the open repository. Mirrors the mobile app's `App`/`Onboarding` stages.
@MainActor
@Observable
final class AppModel {
    enum Stage: Equatable {
        case loading
        case signedOut
        case authorizing
        case repositories
    }

    enum CloneState: Equatable {
        case idle
        case cloning(GitHubRepo)
        case failed(GitHubRepo, String)
    }

    private(set) var stage: Stage = .loading
    private(set) var user: GitHubUser?
    private(set) var device: DeviceAuthorization?
    private(set) var repos: [GitHubRepo] = []
    private(set) var managed: [ManagedRepo] = []
    private(set) var reposLoading = false
    private(set) var reposLoaded = false
    var error: String?
    private(set) var cloneState: CloneState = .idle
    private(set) var cloneProgress = CloneProgress()
    private(set) var developerMode = false
    private(set) var signingOut = false
    var settingsOpen = false
    /// The verification page to show in an in-app browser.
    var browserURL: URL?
    private(set) var repo: RepoModel?
    let demo: Bool

    let engine: Engine?
    let backend: Backend
    let startupError: String?

    private static let cacheKey = "posto.native.repositories.v1"

    init(demo: Bool) {
        self.demo = demo
        let services = Self.makeServices(demo: demo)
        engine = services.engine
        backend = services.backend
        startupError = services.error
        restoreCache()
        if let demoBackend = backend as? DemoBackend { demoBackend.engine = engine }
        backend.setEventHandler { [weak self] name, payload in
            Task { @MainActor in self?.backendEvent(name, payloadJSON: payload) }
        }
    }

    private static func makeServices(demo: Bool) -> (engine: Engine?, backend: Backend, error: String?) {
        let events: @Sendable (String, String) -> Void = { name, payload in
            Task { @MainActor in AppModel.current?.engineEvent(name, payloadJSON: payload) }
        }
        do {
            if demo {
                let backend = DemoBackend()
                let engine = try Engine(backend: UnavailableBackend(), onEvent: events)
                return (engine, backend, nil)
            }
            #if DEBUG
            if let socket = LaunchOptions.backendSocket {
                let backend = SocketBackend(socket: socket)
                return (try Engine(backend: backend, onEvent: events), backend, nil)
            }
            #endif
            let backend = try RustBackend()
            let engine = try Engine(backend: backend, onEvent: events)
            return (engine, backend, nil)
        } catch {
            return (nil, UnavailableBackend(), error.localizedDescription)
        }
    }

    /// The live model, for events that arrive from engine threads.
    static weak var current: AppModel?

    // MARK: Startup

    func start() async {
        Self.current = self
        if let startupError {
            error = startupError
            stage = .signedOut
            return
        }
        if demo { try? await engine?.run("engine.useDemo") }
        #if DEBUG
        if let open = LaunchOptions.openRepository {
            // Previews of a real site skip sign-in and open it directly.
            stage = .repositories
            reposLoaded = true
            let repo = GitHubRepo(
                id: 0, owner: open.owner, name: open.name, fullName: "\(open.owner)/\(open.name)",
                isPrivate: true, cloneURL: "https://github.com/\(open.owner)/\(open.name).git",
                defaultBranch: open.branch, updatedAt: ""
            )
            repos = [repo]
            managed = [ManagedRepo(owner: open.owner, name: open.name, root: open.root, url: repo.cloneURL)]
            await self.open(repo: repo, root: open.root)
            return
        }
        #endif
        do {
            developerMode = try await backend.call("get_developer_mode", as: Bool.self)
        } catch {
            self.error = error.localizedDescription
        }
        do {
            let status = try await backend.call("auth_status", as: AuthStatus.self)
            user = status.user
            if status.signedIn {
                stage = .repositories
                await loadRepos()
            } else {
                stage = .signedOut
            }
        } catch {
            self.error = error.localizedDescription
            stage = .signedOut
        }
    }

    // MARK: Events

    private func backendEvent(_ name: String, payloadJSON: String) {
        let data = Data(payloadJSON.utf8)
        switch name {
        case "auth-device-code":
            device = try? JSONDecoder().decode(DeviceAuthorization.self, from: data)
        case "clone-progress":
            if let progress = try? JSONDecoder().decode(CloneProgress.self, from: data) {
                cloneProgress = progress
            }
        default:
            break
        }
        // Rust events the engine also needs (channels, fs-changed).
        if !demo { engine?.backendEvent(name, payloadJSON: payloadJSON) }
    }

    fileprivate func engineEvent(_ name: String, payloadJSON: String) {
        if name == "backend-event", let demoBackend = backend as? DemoBackend {
            guard let event = try? JSONDecoder().decode(JSONValue.self, from: Data(payloadJSON.utf8)),
                  let eventName = event["event"]?.stringValue
            else { return }
            demoBackend.deliver(eventName, payloadJSON: (event["payload"] ?? .null).jsonString())
            return
        }
        if name == "open-url", let url = (try? JSONDecoder().decode(JSONValue.self, from: Data(payloadJSON.utf8)))?["url"]?.stringValue {
            browserURL = URL(string: url)
            return
        }
        repo?.engineEvent(name, payloadJSON: payloadJSON)
    }

    // MARK: Local folders (macOS)

    /// Folders opened on this Mac, newest first.
    private(set) var recentRoots: [String] = []
    /// The latest openLocal call; an earlier one that finishes later bows out.
    private var openingRoot = 0

    /// The macOS app's startup: settings and the GitHub session (without
    /// the iOS repository list), then the folder that was open last.
    func startLocal() async {
        Self.current = self
        if let startupError {
            error = startupError
            return
        }
        developerMode = (try? await backend.call("get_developer_mode", as: Bool.self)) ?? false
        stage = .repositories
        // The session is in the login Keychain, shared with the Tauri app;
        // reading it can wait on an access prompt, so it doesn't hold up
        // opening the folder.
        Task { user = (try? await backend.call("auth_status", as: AuthStatus.self))?.user }
        await loadRecentRoots()
        if let last = (try? await backend.call("get_last_root", as: String?.self)) ?? nil {
            await openLocal(root: last)
        }
    }

    func loadRecentRoots() async {
        recentRoots = (try? await backend.call("get_recent_roots", as: [String].self)) ?? []
    }

    /// Opens a folder on this Mac, named for its GitHub remote when it has
    /// one. The engine watches it for changes made outside the app.
    func openLocal(root requested: String) async {
        guard let engine else { return }
        openingRoot += 1
        let opening = openingRoot
        // The watcher reports real paths (/private/tmp for /tmp), so the
        // folder is opened by its real path too.
        let root = Self.realPath(requested)
        await closeRepo()
        let remote = (try? await backend.call("github_remote", ["root": .string(root)], as: GitHubSlug?.self)) ?? nil
        guard opening == openingRoot else { return }
        let folder = URL(fileURLWithPath: root).lastPathComponent
        let owner = remote?.owner ?? ""
        let name = remote?.name ?? folder
        let repo = GitHubRepo(
            id: 0, owner: owner, name: name, fullName: remote == nil ? folder : "\(owner)/\(name)",
            isPrivate: true, cloneURL: remote == nil ? "" : "https://github.com/\(owner)/\(name).git",
            defaultBranch: "main", updatedAt: ""
        )
        let model = RepoModel(app: self, engine: engine, github: repo, repoRoot: root, local: true, hasRemote: remote != nil)
        self.repo = model
        try? await backend.run("set_last_root", ["root": .string(root)])
        await loadRecentRoots()
        await model.open()
    }

    private static func realPath(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    // MARK: Sign-in

    /// Signs in with a GitHub device code. The macOS app has no repository
    /// list to load afterwards.
    func signIn(loadsRepositories: Bool = true) async {
        error = nil
        device = nil
        stage = .authorizing
        do {
            user = try await backend.call("sign_in", as: GitHubUser.self)
            browserURL = nil
            stage = .repositories
            if loadsRepositories { await loadRepos() }
        } catch {
            browserURL = nil
            self.error = error.localizedDescription
            stage = .signedOut
        }
    }

    func cancelSignIn() {
        device = nil
        browserURL = nil
        stage = .signedOut
    }

    func signOut() async {
        error = nil
        signingOut = true
        defer { signingOut = false }
        do {
            await closeRepo()
            try await backend.run("sign_out")
            settingsOpen = false
            user = nil
            repos = []
            managed = []
            UserDefaults.standard.removeObject(forKey: Self.cacheKey)
            stage = .signedOut
        } catch {
            self.error = error.localizedDescription
        }
    }

    func setDeveloperMode(_ enabled: Bool) {
        developerMode = enabled
        Task {
            do {
                try await backend.run("set_developer_mode", ["enabled": .bool(enabled)])
                await repo?.setDeveloperMode(enabled)
            } catch {
                developerMode = !enabled
                self.error = "Could not save settings: \(error.localizedDescription)"
            }
        }
    }

    // MARK: Repositories

    func loadRepos() async {
        error = nil
        reposLoading = true
        defer {
            reposLoading = false
            reposLoaded = true
        }
        async let available = backend.call("list_user_repos", as: [GitHubRepo].self)
        async let downloaded = backend.call("list_repos", as: [ManagedRepo].self)
        do { repos = try await available } catch { self.error = error.localizedDescription }
        do { managed = try await downloaded } catch { self.error = self.error ?? error.localizedDescription }
        saveCache()
    }

    func managedRepo(for repo: GitHubRepo) -> ManagedRepo? {
        managed.first { $0.owner == repo.owner && $0.name == repo.name }
    }

    /// Downloaded repositories first, as on the Tauri app's picker.
    func sortedRepos(matching query: String) -> [GitHubRepo] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let matching = needle.isEmpty ? repos : repos.filter { $0.fullName.lowercased().contains(needle) }
        let downloaded = Set(managed.map(\.fullName))
        return matching.enumerated().sorted { left, right in
            let l = downloaded.contains(left.element.fullName), r = downloaded.contains(right.element.fullName)
            return l != r ? l : left.offset < right.offset
        }.map(\.element)
    }

    func choose(_ repo: GitHubRepo) async {
        error = nil
        if let existing = managedRepo(for: repo) {
            await open(repo: repo, root: existing.root)
        } else {
            await download(repo)
        }
    }

    func download(_ repo: GitHubRepo) async {
        cloneProgress = CloneProgress()
        cloneState = .cloning(repo)
        do {
            let root = try await backend.call("clone_repo", ["url": .string(repo.cloneURL)], as: String.self)
            managed.append(ManagedRepo(owner: repo.owner, name: repo.name, root: root, url: repo.cloneURL))
            saveCache()
            cloneState = .idle
            await open(repo: repo, root: root)
        } catch {
            cloneState = .failed(repo, error.localizedDescription)
        }
    }

    func dismissCloneError() {
        cloneState = .idle
    }

    private func open(repo: GitHubRepo, root: String) async {
        guard let engine else { return }
        let model = RepoModel(app: self, engine: engine, github: repo, repoRoot: root)
        self.repo = model
        Task { try? await backend.run("set_last_root", ["root": .string(root)]) }
        await model.open()
    }

    func closeRepo() async {
        guard let repo else { return }
        await repo.close()
        self.repo = nil
    }

    func removeRepo(root: String) async throws {
        await closeRepo()
        try await backend.run("remove_repo", ["root": .string(root)])
        managed.removeAll { $0.root == root }
        saveCache()
    }

    func redownload(_ repo: GitHubRepo, root: String) async throws {
        try await removeRepo(root: root)
        await download(repo)
    }

    // MARK: Cache

    private struct Cache: Codable {
        var repos: [GitHubRepo]
        var managed: [ManagedRepo]
    }

    private func restoreCache() {
        guard !demo, let data = UserDefaults.standard.data(forKey: Self.cacheKey),
              let cache = try? JSONDecoder().decode(Cache.self, from: data)
        else { return }
        repos = cache.repos
        managed = cache.managed
    }

    private func saveCache() {
        guard !demo, let data = try? JSONEncoder().encode(Cache(repos: repos, managed: managed)) else { return }
        UserDefaults.standard.set(data, forKey: Self.cacheKey)
    }
}

#if DEBUG
/// Debug launch arguments for previews and scripted tours.
enum LaunchOptions {
    private static var arguments: [String] { ProcessInfo.processInfo.arguments }

    private static func value(after flag: String) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    /// `-PostoBackendSocket <path>`: use Tools/BackendHost instead of the
    /// linked Rust bridge.
    static var backendSocket: String? { value(after: "-PostoBackendSocket") }

    /// `-PostoOpenRepo <root> -PostoRepo <owner/name> [-PostoBranch <name>]`:
    /// open a downloaded repository without signing in.
    static var openRepository: (root: String, owner: String, name: String, branch: String)? {
        guard let root = value(after: "-PostoOpenRepo"),
              let slug = value(after: "-PostoRepo"),
              let slash = slug.firstIndex(of: "/")
        else { return nil }
        return (root, String(slug[..<slash]), String(slug[slug.index(after: slash)...]), value(after: "-PostoBranch") ?? "main")
    }
}
#endif
