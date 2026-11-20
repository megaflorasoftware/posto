import Foundation

// Shapes produced by the Rust commands (snake_case, like the Tauri app's
// TypeScript types in @posto/ipc).

struct GitHubUser: Codable, Hashable, Sendable {
    let id: Int
    let login: String
    let name: String
    let avatarURL: String
    let commitEmail: String

    enum CodingKeys: String, CodingKey {
        case id, login, name
        case avatarURL = "avatar_url"
        case commitEmail = "commit_email"
    }
}

struct AuthStatus: Codable, Sendable {
    let signedIn: Bool
    let user: GitHubUser?

    enum CodingKeys: String, CodingKey {
        case signedIn = "signed_in"
        case user
    }
}

struct DeviceAuthorization: Codable, Hashable, Sendable {
    let userCode: String
    let verificationURI: String
    let expiresIn: Int

    enum CodingKeys: String, CodingKey {
        case userCode = "user_code"
        case verificationURI = "verification_uri"
        case expiresIn = "expires_in"
    }
}

struct GitHubRepo: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let owner: String
    let name: String
    let fullName: String
    let isPrivate: Bool
    let cloneURL: String
    let defaultBranch: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, owner, name
        case fullName = "full_name"
        case isPrivate = "private"
        case cloneURL = "clone_url"
        case defaultBranch = "default_branch"
        case updatedAt = "updated_at"
    }
}

struct ManagedRepo: Codable, Hashable, Sendable {
    let owner: String
    let name: String
    let root: String
    let url: String

    var fullName: String { "\(owner)/\(name)" }
}

struct CloneProgress: Codable, Hashable, Sendable {
    var receivedObjects: Int = 0
    var totalObjects: Int = 0
    var indexedObjects: Int = 0
    var receivedBytes: Int = 0
    var checkoutCompleted: Int = 0
    var checkoutTotal: Int = 0
    var phase: String = "downloading"

    enum CodingKeys: String, CodingKey {
        case receivedObjects = "received_objects"
        case totalObjects = "total_objects"
        case indexedObjects = "indexed_objects"
        case receivedBytes = "received_bytes"
        case checkoutCompleted = "checkout_completed"
        case checkoutTotal = "checkout_total"
        case phase
    }

    var checkingOut: Bool { phase == "checking_out" }

    /// 0–1, with a small floor so the bar shows activity before totals arrive.
    var fraction: Double {
        if checkingOut {
            return checkoutTotal > 0 ? min(1, Double(checkoutCompleted) / Double(checkoutTotal)) : 0.04
        }
        return totalObjects > 0 ? min(1, Double(receivedObjects) / Double(totalObjects)) : 0.04
    }
}

struct BranchInfo: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let current: Bool
    let local: Bool
    var id: String { name }
}

struct ChangedFile: Codable, Hashable, Identifiable, Sendable {
    let status: String
    let path: String
    var id: String { "\(status) \(path)" }

    var badge: (label: String, isNew: Bool) {
        if status == "??" { return ("new", true) }
        switch status.first {
        case "M": return ("modified", false)
        case "A": return ("added", true)
        case "D": return ("deleted", false)
        case "R": return ("renamed", false)
        default: return (status, false)
        }
    }
}

// Shapes produced by the engine (apps/ios/engine), camelCase.

struct RepoIdentity: Codable, Hashable, Sendable {
    let owner: String
    let name: String
    let cloneUrl: String
    let defaultBranch: String
}

struct TreeFile: Codable, Hashable, Identifiable, Sendable {
    let key: String
    let path: String
    let name: String
    let label: String
    let pinned: Bool
    var id: String { key }
}

struct TreeNode: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let label: String
    let path: String
    let kind: String?
    let canCreate: Bool
    let collection: CollectionRef?
    let defaultOpen: Bool
    let files: [TreeFile]
    let children: [TreeNode]

    var isData: Bool { kind == "data" }
    var dataCollection: String? {
        guard isData, let hash = id.lastIndex(of: "#") else { return nil }
        return String(id[id.index(after: hash)...])
    }
}

struct CollectionRef: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let label: String
    var id: String { name }
}

struct WorkspaceCandidate: Codable, Hashable, Identifiable, Sendable {
    let dir: String
    let label: String
    let type: String
    var id: String { dir }
}

struct StatusNotice: Codable, Hashable, Sendable {
    let id: Int
    let message: String
    let severity: String
    var isError: Bool { severity == "error" }
}

struct SchemaDiagnostic: Codable, Hashable, Sendable {
    let feature: String
    let collection: String?
    let code: String
    let message: String
}

struct GitStatus: Codable, Hashable, Sendable {
    let behindUpstream: Bool
    let pulling: Bool
    let publishing: Bool
    let canPublish: Bool
    let checkingChanges: Bool
}

struct BranchConflict: Codable, Hashable, Sendable {
    let branch: String
    let files: [String]
}

struct RepoView: Codable, Sendable {
    let repoRoot: String
    let root: String
    let repo: RepoIdentity?
    let loading: Bool
    let projectDirectory: String
    let canSwitchProject: Bool
    let workspaceCandidates: [WorkspaceCandidate]?
    let projectDiagnostic: String?
    let projectType: String
    let error: String?
    let repairError: String?
    let status: StatusNotice?
    let looseFiles: [TreeFile]
    let tree: [TreeNode]
    let fileCount: Int
    let mediaLibraryCount: Int
    let hasMediaLibraries: Bool
    let showSourceMedia: Bool
    let orderableCollections: [CollectionRef]
    let diagnostics: [SchemaDiagnostic]
    let git: GitStatus
    let branch: String?
    let branchSwitching: Bool
    let branchConflict: BranchConflict?
    let documentKey: String?
}

struct SelectOption: Codable, Hashable, Identifiable, Sendable {
    let value: String
    let label: String
    var id: String { value }
}

struct FieldTemplate: Codable, Hashable, Sendable {
    let template: String?
    let controlled: Bool
    let rows: Int?
}

/// A schema field with the widget decisions the engine made for it.
struct FieldView: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let type: String
    let label: String
    let showLabel: Bool
    let description: String?
    let required: Bool
    let hidden: Bool
    let list: Bool
    let listMin: Int?
    let listMax: Int?
    let schemaPath: String
    let fields: [FieldView]
    let locked: Bool
    let template: FieldTemplate?
    let selectValues: [SelectOption]
    let numberMin: Double?
    let numberMax: Double?
    let dateTime: Bool
    let chooseImage: Bool
    let referenceCollection: String?
    let imageLibrary: String?
    let newItem: JSONValue?

    var id: String { schemaPath }
    var displayLabel: String { required ? "\(label) *" : label }
    var controlled: Bool { template?.controlled == true && template?.template != nil }
    var disabled: Bool { locked || controlled }
}

/// Date controls for each date value, keyed by dotted path.
struct DateControl: Codable, Hashable, Sendable {
    let date: String
    let dateTime: String
    let hasTime: Bool
}

struct FormState: Codable, Hashable, Sendable {
    var parseError: String?
    var missing: Bool?
    var fields: [FieldView]
    var values: JSONValue
    var errors: [String: String]
    var dates: [String: DateControl]
}

struct FilenameState: Codable, Hashable, Sendable {
    let value: String
    let readOnly: Bool
    let refreshTemplate: String?
}

struct BodyState: Codable, Hashable, Sendable {
    let kind: String
    let text: String
    let componentBlocks: Bool
    var isMarkdown: Bool { kind != "plain" }
}

struct DocumentView: Codable, Sendable {
    let key: String
    let path: String
    let name: String
    let isData: Bool
    let tabs: [String]
    let tab: String
    var saveState: String
    /// Bumped when the content changed underneath the editor.
    let revision: Int
    let collectionLabel: String?
    let filename: FilenameState
    let configError: String?
    let form: FormState?
    let body: BodyState?
    let raw: String?
}

/// What a metadata form edit returns (assets, import drafts, components).
struct FormValues: Codable, Sendable {
    let values: JSONValue
    let errors: [String: String]
    let dates: [String: DateControl]
}

struct ImagePreview: Codable, Hashable, Sendable {
    let path: String?
    let url: String?
}

struct ImageChoice: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let path: String
    let value: String
    var id: String { path }
}

struct ImageChoices: Codable, Sendable {
    struct Media: Codable, Hashable, Sendable {
        let name: String
        let label: String?
        let input: String
    }
    let media: Media?
    let files: [ImageChoice]
    /// The whole source object, passed back to the engine to browse it.
    let cdnSource: JSONValue?
}

struct CdnFolder: Codable, Sendable {
    struct Directory: Codable, Hashable, Identifiable, Sendable {
        let key: String
        let name: String
        var id: String { key }
    }

    struct Image: Codable, Hashable, Identifiable, Sendable {
        let key: String
        let name: String
        let url: String
        var id: String { key }
    }

    let needsCredential: Bool
    let root: String
    let prefix: String
    let directories: [Directory]
    let images: [Image]
}

struct ReferenceOptions: Codable, Sendable {
    let options: [SelectOption]
    let collection: CollectionRef?
}

struct CdnSource: Codable, Hashable, Sendable {
    let name: String
    let label: String?
    let provider: String
    let bucket: String
    var displayName: String { label ?? name }
}

struct CredentialRequest: Codable, Hashable, Identifiable, Sendable {
    let source: CdnSource
    let error: String?
    var id: String { "\(source.name)|\(error ?? "")" }
}

struct PublishStageView: Codable, Hashable, Sendable {
    let label: String
    let progress: Double?
}

struct PublishView: Codable, Sendable {
    let changes: [ChangedFile]?
    let previewChanges: [ChangedFile]?
    let changesError: String?
    let planning: Bool
    let planError: String?
    let uploadNotes: [String]
    let deleteNote: String?
    let blockers: [String]
    let keptNotes: [String]
    let publishing: Bool
    let stage: PublishStageView?
    let credentialRequest: CredentialRequest?
    let publishError: String?
    let scopeLabel: String?

    var hasMediaWork: Bool { !uploadNotes.isEmpty || deleteNote != nil }
}

struct DeploymentRing: Codable, Hashable, Sendable {
    let value: Double
    let state: String
    let done: Bool
    let success: Bool
}

struct DeploymentStatus: Codable, Sendable {
    let owner: String
    let name: String
    let branch: String
    let running: Bool
    let ring: DeploymentRing
    let runs: JSONValue
    let siteUrl: String?
    let actionsUrl: String
}

struct MediaTab: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let label: String
    let kind: String
}

struct MediaFolder: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let path: String
    let previews: [String]
    var id: String { path }
}

struct MediaItem: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let name: String
    let imagePath: String?
    let imageUrl: String?
    let kind: String
    let problem: String?
}

struct MediaListing: Codable, Sendable {
    let tab: String
    let rootDirectory: String
    let directory: String
    let folders: [MediaFolder]
    let items: [MediaItem]
    let error: String?
    let readOnly: Bool
}

struct AssetEditorView: Codable, Sendable {
    let id: String
    let entryId: String
    let imagePath: String?
    let imageUrl: String?
    let filename: String?
    let `extension`: String
    let fields: [FieldView]
    let values: JSONValue
    let errors: [String: String]
    let dates: [String: DateControl]
}

struct ImportDraftView: Codable, Hashable, Sendable {
    let sourceImagePath: String
    let filename: String
    let `extension`: String
    let metadataExtension: String?
    let values: JSONValue
    let errors: [String: String]
    let dates: [String: DateControl]
}

struct ImportView: Codable, Sendable {
    let tab: String
    let library: String
    let folder: String
    let metadataExtensions: [String]
    let drafts: [ImportDraftView]
    let fields: [FieldView]
    let canImport: Bool
}

struct ValidationResult: Codable, Sendable {
    let skipped: String?
    let updated: Int
    let unchanged: Int
    let failed: [Failure]

    struct Failure: Codable, Hashable, Sendable {
        let entryId: String
        let message: String
    }
}

struct LibraryAsset: Codable, Hashable, Identifiable, Sendable {
    /// The entry's metadata file, which the asset editor opens by.
    let metadataPath: String
    let entryId: String
    let name: String
    let imagePath: String?
    let imageUrl: String?
    var id: String { entryId }

    enum CodingKeys: String, CodingKey {
        case metadataPath = "id"
        case entryId, name, imagePath, imageUrl
    }
}

struct ComponentRef: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let path: String
    let relativePath: String
    var id: String { path }
}

struct ComponentList: Codable, Sendable {
    let components: [ComponentRef]
    let directories: [String]
}

struct ComponentFormView: Codable, Sendable {
    let name: String
    let fields: [FieldView]
    let values: JSONValue
    let errors: [String: String]
    let dates: [String: DateControl]
    let slots: [String]
    let hasDefaultSlot: Bool
}

struct CollectionSettings: Codable, Sendable {
    let name: String
    let label: String
    var displayName: String
    var entryName: String
    var sortBy: String?
    var sortDirection: String
    var pinned: [String]
    let sortOptions: [SelectOption]
    let fileNames: [String]
}
