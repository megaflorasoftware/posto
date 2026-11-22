import Foundation
import Observation

/// One open repository, rendered from the engine's `repo` view. Owns the
/// open document and the sheets reached from the sidebar.
@MainActor
@Observable
final class RepoModel {
    unowned let app: AppModel
    let engine: Engine
    let github: GitHubRepo
    let repoRoot: String

    private(set) var view: RepoView?
    private(set) var document: DocumentModel?
    var openError: String?
    /// The editor column is showing (iPhone pushes it; iPad shows it beside).
    var selectedKey: String?
    var publish: PublishModel?
    var branchesOpen = false
    private(set) var branches: [BranchInfo] = []
    /// Why the branch list couldn't be read, if it couldn't.
    private(set) var branchesError: String?
    var settingsOpen = false
    var collectionSettings: CollectionRef?
    var collectionOrderOpen = false
    /// Folders opened or closed in the sidebar this session, by tree node
    /// id, so a section keeps its state when it scrolls away and back.
    var expandedNodes: [String: Bool] = [:]
    /// Bumped to put the cursor in the sidebar's search field (⌘O).
    private(set) var findFileRequests = 0
    private(set) var componentSchemaVersion = 0
    private(set) var siteUrlVersion = 0
    private(set) var mediaVersion = 0
    /// A storage password the Media screen's validation is waiting for.
    var mediaCredential: CredentialRequest?
    var mediaProgress: (done: Int, total: Int)?

    /// A folder opened on this Mac rather than a managed clone.
    let local: Bool
    /// Whether `github` names a real GitHub remote.
    let hasRemote: Bool

    init(app: AppModel, engine: Engine, github: GitHubRepo, repoRoot: String, local: Bool = false, hasRemote: Bool = true) {
        self.app = app
        self.engine = engine
        self.github = github
        self.repoRoot = repoRoot
        self.local = local
        self.hasRemote = hasRemote
    }

    var name: String { github.name }

    // MARK: Lifecycle

    func open() async {
        do {
            let identity: JSONValue = hasRemote ? [
                "owner": .string(github.owner),
                "name": .string(github.name),
                "cloneUrl": .string(github.cloneURL),
                "defaultBranch": .string(github.defaultBranch),
            ] : .null
            view = try await engine.call("repo.open", [
                "repoRoot": .string(repoRoot),
                "repo": identity,
                "local": .bool(local),
                "developerMode": .bool(app.developerMode),
            ])
        } catch {
            openError = error.localizedDescription
        }
    }

    /// The open file's debounced typing goes first: once the session
    /// closes it has nowhere to go. An open still in flight loses.
    func close() async {
        openingFile += 1
        openingKey = nil
        await document?.flush()
        try? await engine.run("repo.close")
    }

    func setDeveloperMode(_ enabled: Bool) async {
        if let next: RepoView = try? await engine.call("repo.setDeveloperMode", ["enabled": .bool(enabled)]) {
            view = next
        }
    }

    // MARK: Engine events

    func engineEvent(_ name: String, payloadJSON: String) {
        let data = Data(payloadJSON.utf8)
        switch name {
        case "repo":
            if let next = try? JSONDecoder().decode(RepoView.self, from: data) { view = next }
            publish?.engineChanged()
        case "document":
            // A file opened since belongs to the model that replaces this one:
            // taking on its session would let this one's edits land in it.
            if let next = try? JSONDecoder().decode(DocumentView.self, from: data), next.session == document?.view.session {
                document?.apply(next)
            }
        case "component-schemas-changed":
            componentSchemaVersion += 1
        case "site-url-changed":
            siteUrlVersion += 1
        case "media-changed":
            mediaVersion += 1
        case "media-credential":
            mediaCredential = try? JSONDecoder().decode(CredentialRequest.self, from: data)
        case "media-progress":
            if let value = try? JSONDecoder().decode(JSONValue.self, from: data) {
                mediaProgress = (Int(value["done"]?.doubleValue ?? 0), Int(value["total"]?.doubleValue ?? 0))
            }
        default:
            break
        }
    }

    // MARK: Content

    func refresh() async {
        if let next: RepoView = try? await engine.call("repo.refresh") { view = next }
    }

    func chooseWorkspace(_ dir: String?) async {
        openingFile += 1
        await document?.flush()
        selectedKey = nil
        document = nil
        do {
            view = try await engine.call("repo.chooseWorkspace", ["dir": JSONValue(dir)])
        } catch {
            openError = error.localizedDescription
        }
    }

    func showWorkspaceChooser() async {
        do {
            view = try await engine.call("repo.showWorkspaceChooser")
        } catch {
            openError = error.localizedDescription
        }
    }

    func cancelWorkspaceChooser() async {
        if let next: RepoView = try? await engine.call("repo.cancelWorkspaceChooser") { view = next }
    }

    /// The repository's projects, leaving the open one in place until one
    /// is picked (the chooser Settings opens).
    func workspaceCandidates() async throws -> [WorkspaceCandidate] {
        try await engine.call("repo.listWorkspaceCandidates")
    }

    func childDirectories(of dir: String) async throws -> [String] {
        try await engine.call("repo.listChildDirectories", ["dir": .string(dir)])
    }

    func dismissStatus(_ status: StatusNotice) async {
        if let next: RepoView = try? await engine.call("repo.dismissStatus", ["id": .number(Double(status.id))]) {
            view = next
        }
    }

    // MARK: Sidebar

    func isExpanded(_ node: TreeNode, default open: Bool) -> Bool {
        expandedNodes[node.id] ?? open
    }

    func setExpanded(_ node: TreeNode, _ expanded: Bool) {
        expandedNodes[node.id] = expanded
    }

    /// Where New File goes from the menu bar: the nearest folder of the open
    /// file that can take one, else the first section that can.
    var newFileTarget: TreeNode? {
        guard let view else { return nil }
        func folders(to key: String, in nodes: [TreeNode]) -> [TreeNode]? {
            for node in nodes {
                if node.files.contains(where: { $0.key == key }) { return [node] }
                if let inner = folders(to: key, in: node.children) { return [node] + inner }
            }
            return nil
        }
        if let key = document?.key, let node = folders(to: key, in: view.tree)?.last(where: \.canCreate) { return node }
        return view.tree.first { $0.canCreate }
    }

    func requestFindFile() {
        findFileRequests += 1
    }

    // MARK: Documents

    /// Bumped by each open, close or create, so only the latest selection
    /// takes effect when several overlap (arrowing through the sidebar).
    private var openingFile = 0
    /// The file an open in flight is fetching.
    private var openingKey: String?
    private var creatingFile = false

    /// Another file is on its way in (opening or newly created): the
    /// editor shows it loading rather than the previous file.
    var isOpeningAnotherFile: Bool {
        creatingFile || (openingKey != nil && openingKey != document?.key)
    }

    func openFile(_ key: String) async {
        // Already open (or opening): nothing to do. While another open is in
        // flight, returning here would let that one win over this choice.
        if (openingKey ?? document?.key) == key { return }
        openingFile += 1
        let opening = openingFile
        openingKey = key
        defer { if opening == openingFile { openingKey = nil } }
        // Debounced typing goes to the file it was typed into, before the
        // engine switches documents.
        await document?.flush()
        do {
            let opened: DocumentView = try await engine.call("doc.open", ["key": .string(key)])
            guard opening == openingFile else { return }
            document = DocumentModel(repo: self, view: opened)
            selectedKey = opened.key
        } catch {
            guard opening == openingFile else { return }
            // The engine closes the open file before reading the next, so a
            // failed open can leave nothing open. The selection goes back to
            // what is, so tapping the same row again tries again.
            if let current: RepoView = try? await engine.call("repo.view") {
                guard opening == openingFile else { return }
                view = current
                if current.documentKey != document?.key { document = nil }
            }
            openingKey = nil
            selectedKey = document?.key
            openError = error.localizedDescription
        }
    }

    /// Flushes the open file and refreshes the publish state, as backing out
    /// of the editor does on the Tauri app.
    func closeFile() async {
        guard let closing = document else { return }
        openingFile += 1
        openingKey = nil
        await closing.flush()
        document = nil
        selectedKey = nil
        if let next: RepoView = try? await engine.call("doc.close") { view = next }
    }

    func createFile(in node: TreeNode) async {
        // The current file's debounced typing goes to it first, as on open.
        openingFile += 1
        openingKey = nil
        creatingFile = true
        defer { creatingFile = false }
        await document?.flush()
        do {
            let created: DocumentView = try await engine.call("repo.createFile", [
                "groupPath": .string(node.path),
                "dataCollection": JSONValue(node.dataCollection),
            ])
            document = DocumentModel(repo: self, view: created)
            selectedKey = created.key
        } catch {
            try? await engine.run("repo.setStatus", ["message": .string("Create failed: \(error.localizedDescription)"), "severity": "error"])
        }
    }

    func createRootFile() async {
        guard let view else { return }
        let root = TreeNode(id: "root", label: "", path: view.root, kind: nil, canCreate: true, collection: nil, defaultOpen: true, files: [], children: [])
        await createFile(in: root)
    }

    func deleteOpenFile() async {
        guard let key = document?.key else { return }
        await deleteFile(key)
    }

    /// Deletes a file (or data entry) from the sidebar. The open file
    /// closes with it; an open entry of the same data file is reloaded.
    func deleteFile(_ key: String) async {
        if document?.key == key {
            // Its unsent typing is dropped with it, and an open in flight
            // loses to the delete.
            openingFile += 1
            openingKey = nil
        } else {
            // An open entry of the same data file saves the whole file:
            // its typing goes first.
            await document?.flush()
        }
        do {
            let next: RepoView = try await engine.call("repo.deleteFile", ["key": .string(key)])
            view = next
            if next.documentKey != document?.key {
                document = nil
                selectedKey = nil
            }
        } catch {
            openError = "Could not delete the file: \(error.localizedDescription)"
        }
    }

    // MARK: Git

    func pull() async {
        if let next: RepoView = try? await engine.call("git.pull") { view = next }
    }

    func openPublish() {
        let model = PublishModel(repo: self)
        publish = model
        Task { await model.load() }
    }

    func loadBranches() async {
        branchesError = nil
        do {
            branches = try await engine.call("branch.load")
            branchesError = nil
        } catch {
            branches = []
            branchesError = error.localizedDescription
        }
    }

    /// A failed switch comes back as the engine's error notice.
    func switchBranch(_ name: String, create: Bool) async {
        await document?.flush()
        do {
            let result: JSONValue = try await engine.call("branch.switch", ["name": .string(name), "create": .bool(create)])
            if let next = try? result["view"]?.decode(as: RepoView.self) { view = next }
            await document?.reload()
        } catch {
            openError = error.localizedDescription
        }
    }

    func forceSwitchBranch() async {
        do {
            let result: JSONValue = try await engine.call("branch.force")
            if let next = try? result["view"]?.decode(as: RepoView.self) { view = next }
            await document?.reload()
        } catch {
            openError = error.localizedDescription
        }
    }

    func clearBranchConflict() async {
        if let next: RepoView = try? await engine.call("branch.clearConflict") { view = next }
    }

    // MARK: Media

    func submitMediaCredential(_ credential: JSONValue?) async {
        mediaCredential = nil
        try? await engine.run("media.submitCredential", ["credential": credential ?? .null])
    }
}

/// The open file: form fields, body, raw source, and save state.
@MainActor
@Observable
final class DocumentModel {
    /// Weak: a flush or save can still be running once the repository has
    /// closed (leaving it, signing out). The model reaches the engine
    /// through its own reference.
    @ObservationIgnored private weak var owner: RepoModel?
    let engine: Engine
    private(set) var view: DocumentView
    /// Body and raw text as the editor shows them. The engine bumps
    /// `revision` when content changes underneath (pull, branch switch, raw
    /// edits); only then is local text replaced, so typing is never undone.
    var bodyText: String
    var rawText: String
    var renameError: String?
    private var pendingBody: String?
    private var pendingRaw: String?
    private var bodyTask: Task<Void, Never>?
    private var rawTask: Task<Void, Never>?

    init(repo: RepoModel, view: DocumentView) {
        owner = repo
        engine = repo.engine
        self.view = view
        bodyText = view.body?.text ?? ""
        rawText = view.raw ?? ""
    }

    /// The repository, for views: they show a document only while its
    /// repository is open, which keeps it alive.
    var repo: RepoModel {
        guard let owner else { preconditionFailure("The document's repository was closed") }
        return owner
    }

    var key: String { view.key }

    func apply(_ next: DocumentView) {
        // A rename (a filename template) keeps the session: the text typed
        // since stays. Another document or new content replaces it.
        let replaced = next.revision != view.revision || next.session != view.session || next.tab != view.tab
        view = next
        if replaced {
            bodyText = next.body?.text ?? ""
            rawText = next.raw ?? ""
        }
    }

    func reload() async {
        if let next: DocumentView = try? await engine.call("doc.view") { apply(next) }
    }

    /// Sends any debounced text and waits for the write.
    func flush() async {
        bodyTask?.cancel()
        rawTask?.cancel()
        await sendBody()
        await sendRaw()
        try? await engine.run("doc.flush")
    }

    func setTab(_ tab: String) async {
        await flush()
        if let next: DocumentView = try? await engine.call("doc.setTab", ["tab": .string(tab)]) { apply(next) }
    }

    func bodyChanged(_ text: String) {
        guard text != bodyText || pendingBody != nil else { return }
        bodyText = text
        pendingBody = text
        view.saveState = "saving"
        bodyTask?.cancel()
        bodyTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await sendBody()
        }
    }

    private func sendBody() async {
        guard let text = pendingBody else { return }
        pendingBody = nil
        if let result: JSONValue = try? await engine.call("doc.setBody", ["session": .number(Double(view.session)), "text": .string(text)]),
           let state = result["saveState"]?.stringValue {
            view.saveState = state
        }
    }

    func rawChanged(_ text: String) {
        guard text != rawText || pendingRaw != nil else { return }
        rawText = text
        pendingRaw = text
        view.saveState = "saving"
        rawTask?.cancel()
        rawTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await sendRaw()
        }
    }

    private func sendRaw() async {
        guard let text = pendingRaw else { return }
        pendingRaw = nil
        if let result: JSONValue = try? await engine.call("doc.setRaw", ["session": .number(Double(view.session)), "text": .string(text)]),
           let state = result["saveState"]?.stringValue {
            view.saveState = state
        }
    }

    func rename(to filename: String) async {
        renameError = nil
        do {
            let result: JSONValue = try await engine.call("doc.rename", ["filename": .string(filename)])
            renameError = result["error"]?.stringValue
            if let next = try? result["view"]?.decode(as: DocumentView.self) {
                apply(next)
                owner?.selectedKey = next.key
            }
        } catch {
            renameError = error.localizedDescription
        }
    }

    func refreshFilename() async {
        do {
            let result: JSONValue = try await engine.call("doc.refreshFilename")
            renameError = result["error"]?.stringValue
            if let next = try? result["view"]?.decode(as: DocumentView.self) {
                apply(next)
                owner?.selectedKey = next.key
            }
        } catch {
            renameError = error.localizedDescription
        }
    }

    func bodyMediaValue(for absolutePath: String) async -> String? {
        try? await engine.call("doc.bodyMediaValue", ["absolutePath": .string(absolutePath)])
    }
}

/// Field edits for any engine form: the open document, an image's
/// metadata, an import draft, or a component's props.
@MainActor
protocol FormSink: AnyObject {
    var engine: Engine { get }
    var formTarget: String { get }
    /// The open document's session, for its own fields: the engine drops an
    /// edit that arrives after a file switch rather than apply it to the
    /// next file.
    var formSession: Int? { get }
    func formState() -> FormState?
    func applyFormResult(_ result: JSONValue)
}

extension FormSink {
    /// Image fields open the media picker: the document's own fields, a
    /// component's props (resolved against the document, as on desktop) and
    /// a new referenced entry (resolved against its collection). Forms with
    /// no document behind them keep a text field.
    var picksImages: Bool { formTarget == "document" || formTarget == "component" || formTarget == "reference" }

    var formSession: Int? { nil }

    func perform(_ method: String, _ args: [String: JSONValue]) async {
        var payload = args
        payload["form"] = .string(formTarget)
        if let formSession { payload["session"] = .number(Double(formSession)) }
        if let result: JSONValue = try? await engine.call(method, payload) { applyFormResult(result) }
    }

    func edit(_ path: [PathKey], _ value: JSONValue?) async {
        await perform("form.edit", ["path": path.json, "value": value ?? .null])
    }

    func editDate(_ path: [PathKey], control: String?, time: Bool) async {
        await perform("form.editDate", ["path": path.json, "control": JSONValue(control), "time": .bool(time)])
    }

    /// Without a value, the engine builds the list's new item from the
    /// schema, keeping its key order (a Swift dictionary has none).
    func listAppend(_ path: [PathKey], _ value: JSONValue? = nil) async {
        var args: [String: JSONValue] = ["path": path.json]
        if let value { args["value"] = value }
        await perform("form.listAppend", args)
    }

    func regenerate(_ path: [PathKey]) async {
        await perform("form.regenerate", ["path": path.json])
    }

    func listRemove(_ path: [PathKey], _ index: Int) async {
        await perform("form.listRemove", ["path": path.json, "index": .number(Double(index))])
    }

    func listMove(_ path: [PathKey], from: Int, to: Int) async {
        await perform("form.listMove", ["path": path.json, "from": .number(Double(from)), "to": .number(Double(to))])
    }
}

extension DocumentModel: FormSink {
    var formTarget: String { "document" }
    var formSession: Int? { view.session }
    func formState() -> FormState? { view.form }
    func applyFormResult(_ result: JSONValue) {
        if let next = try? result.decode(as: DocumentView.self) { apply(next) }
    }
}

/// A metadata form held locally (asset editor, import draft, component).
@MainActor
@Observable
final class MetadataFormModel: FormSink {
    let engine: Engine
    let formTarget: String
    var fields: [FieldView]
    var values: JSONValue
    var errors: [String: String]
    var dates: [String: DateControl]

    init(engine: Engine, target: String, fields: [FieldView], values: JSONValue, errors: [String: String], dates: [String: DateControl]) {
        self.engine = engine
        formTarget = target
        self.fields = fields
        self.values = values
        self.errors = errors
        self.dates = dates
    }

    var valid: Bool { errors.isEmpty }

    func formState() -> FormState? {
        FormState(parseError: nil, missing: false, fields: fields, values: values, errors: errors, dates: dates)
    }

    func applyFormResult(_ result: JSONValue) {
        guard let next = try? result.decode(as: FormValues.self) else { return }
        values = next.values
        errors = next.errors
        dates = next.dates
    }
}
