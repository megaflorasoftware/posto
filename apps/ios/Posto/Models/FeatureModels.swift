import Foundation
import Observation

extension PublishModel: Identifiable {
    nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }
}

/// The Publish sheet: change list, CDN media plan, credentials, progress.
@MainActor
@Observable
final class PublishModel {
    unowned let repo: RepoModel
    private(set) var view: PublishView?
    /// Must match the backend's fallback commit message in publish().
    var message = "Site updates"
    private(set) var loading = true
    private var poll: Task<Void, Never>?

    init(repo: RepoModel) {
        self.repo = repo
    }

    var engine: Engine { repo.engine }

    func load() async {
        loading = true
        await repo.document?.flush()
        view = try? await engine.call("git.loadChanges")
        loading = false
    }

    /// The list to show: what the publish will commit after media rewrites.
    var shownChanges: [ChangedFile]? { view?.previewChanges ?? view?.changes }

    /// Revert is offered only for real working-tree changes.
    func canRevert(_ file: ChangedFile) -> Bool {
        view?.changes?.contains(file) == true
    }

    var canPublish: Bool {
        guard let view, !view.publishing, !view.planning, view.blockers.isEmpty else { return false }
        let hasChanges = !(view.changes ?? []).isEmpty || view.hasMediaWork
        return hasChanges && !message.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// The engine reports publish-state changes outside a call (the media
    /// plan finishing after a revert, say) only as repo events; re-read the
    /// sheet's view on each one.
    func engineChanged() {
        guard !loading else { return }
        Task {
            if let next: PublishView = try? await engine.call("git.publishView") { view = next }
        }
    }

    func revert(_ file: ChangedFile) async {
        view = try? await engine.call("git.revert", ["file": try JSONValue(encoding: file)])
        await repo.document?.reload()
    }

    /// Publishes; true when the sheet can close. A publish starts a deploy,
    /// so the repository's deployment status then watches for its run.
    func publish() async -> Bool {
        let deployments = repo.deployments
        let sinceRunId = deployments.status?.latestRun?.id
        let publishedAt = Date()
        startPolling()
        defer { stopPolling() }
        do {
            let result: JSONValue = try await engine.call("git.publish", ["message": .string(message)])
            view = try? result["view"]?.decode(as: PublishView.self)
            let published = result["published"]?.boolValue == true
            if published { deployments.expectNewRun(since: sinceRunId, publishedAt: publishedAt) }
            return published
        } catch {
            return false
        }
    }

    /// Stage and credential prompts change mid-publish; the engine's repo
    /// events don't carry them, so poll the sheet's view while publishing.
    private func startPolling() {
        poll?.cancel()
        poll = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(300))
                if let next: PublishView = try? await engine.call("git.publishView") { view = next }
            }
        }
    }

    private func stopPolling() {
        poll?.cancel()
        poll = nil
    }

    func submitCredential(_ credential: JSONValue?) async {
        try? await engine.run("git.submitCredential", ["credential": credential ?? .null])
        if let next: PublishView = try? await engine.call("git.publishView") { view = next }
    }

    func close() {
        stopPolling()
        Task { try? await engine.run("git.closeChanges") }
    }
}

extension RepoModel {
    /// This repository's deployment status, kept for as long as it's open.
    var deployments: DeploymentModel { DeploymentModel.model(for: self) }
}

/// A repository's GitHub Actions runs and the ring the desktop app shows.
/// One per open repository (`repo.deployments`), polled every 15 seconds
/// while something shows it, for as long as a deploy runs, and a few times
/// right after a publish until that publish's run appears (the desktop
/// app's `expectNewRun`).
@MainActor
@Observable
final class DeploymentModel {
    @ObservationIgnored private(set) weak var repo: RepoModel?
    private(set) var status: DeploymentStatus?
    private(set) var ring: DeploymentRing?
    /// Why the status couldn't load at all. Runs that couldn't be listed
    /// arrive as `status.error`, with the links.
    private(set) var error: String?
    @ObservationIgnored private var watchers = 0
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var lastPoll = Date.distantPast
    @ObservationIgnored private var expectation: Expectation?

    private struct Expectation {
        let sinceRunId: Int?
        let publishedAt: Date
        /// When to look again, as the desktop app does: 3, 8 and 15 seconds
        /// after publishing.
        var checks: [Date]
    }

    /// The models of open repositories. A model outlives its repository only
    /// until the next lookup; its polling stops as soon as the repository
    /// closes.
    private static var models: [ObjectIdentifier: DeploymentModel] = [:]

    static func model(for repo: RepoModel) -> DeploymentModel {
        let key = ObjectIdentifier(repo)
        if let model = models[key], model.repo === repo { return model }
        models = models.filter { $0.value.repo != nil && $0.key != key }
        let model = DeploymentModel(repo: repo)
        models[key] = model
        return model
    }

    private init(repo: RepoModel) {
        self.repo = repo
    }

    var running: Bool { status?.running == true }
    /// Whether there's a run to draw a ring for.
    var hasRuns: Bool { status?.latestRun != nil }

    /// Something on screen shows the status: poll while it does.
    func watch() {
        watchers += 1
        startLoop()
    }

    func unwatch() {
        watchers = max(0, watchers - 1)
    }

    /// Looks for the run a publish just started. `sinceRunId` is the newest
    /// run before publishing (nil when none was known: then any run created
    /// since the publish counts).
    func expectNewRun(since sinceRunId: Int?, publishedAt: Date) {
        expectation = Expectation(
            sinceRunId: sinceRunId,
            publishedAt: publishedAt,
            checks: [3, 8, 15].map { publishedAt.addingTimeInterval($0) }
        )
        startLoop()
    }

    func refresh() async {
        lastPoll = Date()
        await load()
    }

    private var isOpen: Bool {
        guard let repo else { return false }
        return repo.hasRemote && repo.app.repo === repo
    }

    private var needed: Bool { watchers > 0 || running || expectation != nil }

    private func startLoop() {
        guard loop == nil else { return }
        loop = Task {
            while !Task.isCancelled, isOpen, needed {
                await step()
                try? await Task.sleep(for: .seconds(1))
            }
            loop = nil
        }
    }

    private func step() async {
        let now = Date()
        var due = (watchers > 0 || running) && now.timeIntervalSince(lastPoll) >= 15
        if var expected = expectation, let next = expected.checks.first, now >= next {
            expected.checks.removeFirst()
            expectation = expected
            due = true
        }
        if due {
            lastPoll = now
            await load()
            if let expected = expectation, expected.checks.isEmpty || foundRun(after: expected) {
                expectation = nil
            }
        } else if running, let status, let repo {
            // Between polls the ring keeps filling from the run's history.
            if let next: DeploymentRing = try? await repo.engine.call("deploy.ring", ["runs": status.runs]) {
                ring = next
            }
        }
    }

    private func foundRun(after expected: Expectation) -> Bool {
        guard let latest = status?.latestRun else { return false }
        if let since = expected.sinceRunId { return latest.id > since }
        guard let created = ISO8601DateFormatter().date(from: latest.createdAt) else { return false }
        // GitHub's clock and this device's can disagree by a little.
        return created >= expected.publishedAt.addingTimeInterval(-60)
    }

    private func load() async {
        guard let repo else { return }
        do {
            var next: DeploymentStatus = try await repo.engine.call("deploy.status")
            // A poll that couldn't list runs keeps the last ones it could.
            if next.error != nil, let previous = status, previous.latestRun != nil {
                next = next.keepingRuns(of: previous)
            }
            status = next
            ring = next.ring
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The ring's state in words, as the Tauri apps label it.
func deploymentStateText(_ state: String?, unavailable: Bool = false) -> String {
    switch state {
    case "running": return "Deploying…"
    case "queued": return "Queued"
    case "success": return "Deployed"
    case "failure": return "Deployment failed"
    case nil: return "Checking…"
    default: return unavailable ? "Deployments unavailable" : "No recent deployments"
    }
}

/// The Media screen's navigation and selection for one tab.
@MainActor
@Observable
final class MediaModel {
    unowned let repo: RepoModel
    private(set) var tabs: [MediaTab] = []
    var tab: String = "" {
        didSet {
            guard oldValue != tab, !suppressLoads else { return }
            directory = ""
            clearSelection()
            Task { await load() }
        }
    }
    var directory = "" {
        didSet { if oldValue != directory && !suppressLoads { clearSelection(); Task { await load() } } }
    }
    private(set) var listing: MediaListing?
    private(set) var loading = false
    var error: String?
    var selecting = false
    var selectedItems: Set<String> = []
    var selectedFolders: Set<String> = []

    init(repo: RepoModel) {
        self.repo = repo
    }

    var engine: Engine { repo.engine }
    var currentTab: MediaTab? { tabs.first { $0.id == tab } }
    var isLibrary: Bool { currentTab?.kind == "library" }
    var isPublic: Bool { currentTab?.kind == "public" }
    var readOnly: Bool { currentTab?.kind == "source" }
    var hasSelection: Bool { !selectedItems.isEmpty || !selectedFolders.isEmpty }

    /// Lists the tabs and the first folder. A picker can keep to one image
    /// library (`only`, for an image-library reference) and open at a folder
    /// on disk (`folder`, an image field's media folder).
    func start(only library: String? = nil, at folder: String? = nil) async {
        var listed: [MediaTab] = (try? await engine.call("media.tabs")) ?? []
        if let library { listed = listed.filter { $0.id == library } }
        tabs = listed
        var located: MediaLocation?
        if let folder {
            located = (try? await engine.call("media.locate", ["folder": .string(folder)], as: MediaLocation?.self)) ?? nil
            if let found = located, !tabs.contains(where: { $0.id == found.tab }) { located = nil }
        }
        let first = located?.tab ?? (tabs.contains(where: { $0.id == tab }) ? tab : tabs.first?.id ?? "")
        withoutLoading {
            tab = first
            directory = located?.directory ?? ""
        }
        await load()
    }

    func load(reload: Bool = false) async {
        guard !tab.isEmpty else { return }
        loading = true
        defer { loading = false }
        do {
            listing = try await engine.call("media.list", [
                "tab": .string(tab), "directory": .string(directory), "reload": .bool(reload),
            ])
            error = listing?.error
        } catch {
            self.error = error.localizedDescription
        }
    }

    func clearSelection() {
        selectedItems = []
        selectedFolders = []
    }

    /// Points at a tab for a one-off sheet (the asset editor) without
    /// listing it.
    func selectTabWithoutLoading(_ id: String) {
        tabs = [MediaTab(id: id, label: id, kind: "library")]
        listing = nil
        withoutLoading { tab = id }
    }

    private var suppressLoads = false

    private func withoutLoading(_ change: () -> Void) {
        suppressLoads = true
        change()
        suppressLoads = false
    }

    var visibleSelectable: (items: [String], folders: [String]) {
        guard let listing else { return ([], []) }
        return (listing.items.filter { $0.problem == nil }.map(\.id), listing.folders.map(\.path))
    }

    var everythingSelected: Bool {
        let visible = visibleSelectable
        return !(visible.items.isEmpty && visible.folders.isEmpty)
            && Set(visible.items).isSubset(of: selectedItems)
            && Set(visible.folders).isSubset(of: selectedFolders)
    }

    func toggleAll() {
        if everythingSelected {
            clearSelection()
        } else {
            let visible = visibleSelectable
            selectedItems.formUnion(visible.items)
            selectedFolders.formUnion(visible.folders)
        }
    }

    func toggle(item: MediaItem) {
        guard item.problem == nil else { return }
        if selectedItems.contains(item.id) { selectedItems.remove(item.id) } else { selectedItems.insert(item.id) }
    }

    func toggle(folder: MediaFolder) {
        if selectedFolders.contains(folder.path) {
            selectedFolders.remove(folder.path)
        } else {
            selectedFolders = selectedFolders.filter { !$0.hasPrefix(folder.path + "/") }
            selectedFolders.insert(folder.path)
        }
    }

    private func perform(_ method: String, _ args: [String: JSONValue]) async -> Bool {
        do {
            try await engine.run(method, args)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    func createFolder(named name: String) async {
        if await perform("media.createFolder", ["tab": .string(tab), "directory": .string(directory), "name": .string(name)]) {
            await load(reload: true)
        }
    }

    func deleteSelection() async {
        let ok = await perform("media.deleteItems", [
            "tab": .string(tab),
            "ids": .array(selectedItems.map(JSONValue.string)),
            "folders": .array(selectedFolders.map(JSONValue.string)),
        ])
        if ok { selecting = false; clearSelection() }
        await load(reload: true)
    }

    func moveTargets() async -> [String] {
        (try? await engine.call("media.moveTargets", ["tab": .string(tab)])) ?? [""]
    }

    func moveSelection(to destination: String) async {
        let ok = await perform("media.moveItems", [
            "tab": .string(tab),
            "ids": .array(selectedItems.map(JSONValue.string)),
            "folders": .array(selectedFolders.map(JSONValue.string)),
            "destination": .string(destination),
        ])
        if ok { selecting = false; clearSelection() }
        await load(reload: true)
    }

    func validateSelection() async -> ValidationResult? {
        do {
            let result: ValidationResult? = try await engine.call("media.validate", [
                "tab": .string(tab),
                "ids": .array(selectedItems.map(JSONValue.string)),
                "folders": .array(selectedFolders.map(JSONValue.string)),
            ])
            repo.mediaProgress = nil
            await load(reload: true)
            return result
        } catch {
            repo.mediaProgress = nil
            self.error = error.localizedDescription
            return nil
        }
    }

    func importPublic(_ paths: [String]) async {
        if await perform("media.importPublic", ["directory": .string(directory), "sources": .array(paths.map(JSONValue.string))]) {
            await load(reload: true)
        }
    }

    func renamePublic(_ item: MediaItem, to filename: String) async -> String? {
        do {
            try await engine.run("media.renamePublic", ["path": .string(item.id), "filename": .string(filename)])
            await load(reload: true)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func deletePublic(_ item: MediaItem) async {
        if await perform("media.deleteItems", ["tab": .string(tab), "ids": [.string(item.id)], "folders": []]) {
            await load(reload: true)
        }
    }
}
