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

    /// Publishes; true when the sheet can close.
    func publish() async -> Bool {
        startPolling()
        defer { stopPolling() }
        do {
            let result: JSONValue = try await engine.call("git.publish", ["message": .string(message)])
            view = try? result["view"]?.decode(as: PublishView.self)
            return result["published"]?.boolValue == true
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

/// The Deployments page: polls GitHub Actions and recomputes the ring.
@MainActor
@Observable
final class DeploymentModel {
    unowned let repo: RepoModel
    private(set) var status: DeploymentStatus?
    private(set) var ring: DeploymentRing?
    private(set) var error: String?
    private var task: Task<Void, Never>?

    init(repo: RepoModel) {
        self.repo = repo
    }

    func start() {
        task?.cancel()
        task = Task {
            var lastPoll = Date.distantPast
            while !Task.isCancelled {
                if Date().timeIntervalSince(lastPoll) >= 15 {
                    lastPoll = Date()
                    await load()
                } else if let status, status.running {
                    // Between polls the ring keeps filling from the run's history.
                    ring = try? await repo.engine.call("deploy.ring", ["runs": status.runs])
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func load() async {
        do {
            let next: DeploymentStatus = try await repo.engine.call("deploy.status")
            status = next
            ring = next.ring
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
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
