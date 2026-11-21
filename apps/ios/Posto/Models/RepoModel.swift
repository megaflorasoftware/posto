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
    var settingsOpen = false
    var collectionSettings: CollectionRef?
    var collectionOrderOpen = false
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

    func close() async {
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
            if let next = try? JSONDecoder().decode(DocumentView.self, from: data) { document?.apply(next) }
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

    func childDirectories(of dir: String) async -> [String] {
        (try? await engine.call("repo.listChildDirectories", ["dir": .string(dir)], as: [String].self)) ?? []
    }

    // MARK: Documents

    /// Bumped by each openFile, so only the latest selection takes effect
    /// when several opens overlap (arrowing through the sidebar).
    private var openingFile = 0

    func openFile(_ key: String) async {
        if document?.key == key { return }
        openingFile += 1
        let opening = openingFile
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
            openError = error.localizedDescription
        }
    }

    /// Flushes the open file and refreshes the publish state, as backing out
    /// of the editor does on the Tauri app.
    func closeFile() async {
        guard let closing = document else { return }
        openingFile += 1
        await closing.flush()
        document = nil
        selectedKey = nil
        if let next: RepoView = try? await engine.call("doc.close") { view = next }
    }

    func createFile(in node: TreeNode) async {
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
        do {
            view = try await engine.call("doc.delete")
            document = nil
            selectedKey = nil
        } catch {
            openError = error.localizedDescription
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
        branches = (try? await engine.call("branch.load")) ?? []
    }

    func switchBranch(_ name: String, create: Bool) async {
        await document?.flush()
        do {
            let result: JSONValue = try await engine.call("branch.switch", ["name": .string(name), "create": .bool(create)])
            if let next = try? result["view"]?.decode(as: RepoView.self) { view = next }
            if let message = result["error"]?.stringValue {
                try? await engine.run("repo.setStatus", ["message": .string(message), "severity": "error"])
            }
            await document?.reload()
        } catch {
            openError = error.localizedDescription
        }
    }

    func forceSwitchBranch() async {
        let result: JSONValue? = try? await engine.call("branch.force")
        if let next = try? result?["view"]?.decode(as: RepoView.self) { view = next }
        await document?.reload()
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
    unowned let repo: RepoModel
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
        self.repo = repo
        self.view = view
        bodyText = view.body?.text ?? ""
        rawText = view.raw ?? ""
    }

    var key: String { view.key }
    var engine: Engine { repo.engine }

    func apply(_ next: DocumentView) {
        let replaced = next.revision != view.revision || next.key != view.key || next.tab != view.tab
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
        if let result: JSONValue = try? await engine.call("doc.setBody", ["key": .string(key), "text": .string(text)]),
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
        if let result: JSONValue = try? await engine.call("doc.setRaw", ["key": .string(key), "text": .string(text)]),
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
                repo.selectedKey = next.key
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
                repo.selectedKey = next.key
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
    func formState() -> FormState?
    func applyFormResult(_ result: JSONValue)
}

extension FormSink {
    /// Image fields open the media picker: the document's own fields, and a
    /// component's props (resolved against the document, as on desktop).
    /// Forms with no document behind them keep a text field.
    var picksImages: Bool { formTarget == "document" || formTarget == "component" }

    func perform(_ method: String, _ args: [String: JSONValue]) async {
        var payload = args
        payload["form"] = .string(formTarget)
        if let result: JSONValue = try? await engine.call(method, payload) { applyFormResult(result) }
    }

    func edit(_ path: [PathKey], _ value: JSONValue?) async {
        await perform("form.edit", ["path": path.json, "value": value ?? .null])
    }

    func editDate(_ path: [PathKey], control: String?, time: Bool) async {
        await perform("form.editDate", ["path": path.json, "control": JSONValue(control), "time": .bool(time)])
    }

    func listAppend(_ path: [PathKey], _ value: JSONValue) async {
        await perform("form.listAppend", ["path": path.json, "value": value])
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
