import SwiftUI

/// Resolves an image value (site path, document-relative path, or CDN URL)
/// to something displayable, through the engine's media rules.
struct FieldImagePreview: View {
    let document: DocumentModel
    let path: [PathKey]
    let value: String
    @State private var preview: ImagePreview?

    var body: some View {
        Thumbnail(path: preview?.path, url: preview?.url, maxPixels: 300)
            .task(id: value) {
                preview = try? await document.engine.call("doc.imagePreview", ["path": path.json, "value": .string(value)])
            }
    }
}

/// An image field: the current image with a picker over the field's media
/// folder.
struct ImageFieldRow: View {
    let document: DocumentModel
    let field: FieldView
    let path: [PathKey]
    let value: String
    let label: String
    @State private var picking = false

    var body: some View {
        Button {
            picking = true
        } label: {
            HStack(spacing: 12) {
                FieldImagePreview(document: document, path: path, value: value)
                    .frame(width: 64, height: 64)
                    .clipShape(.rect(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 2) {
                    Text(label.isEmpty ? field.label : label).foregroundStyle(.primary)
                    Text(value.isEmpty ? "Choose image" : value.lastPathComponent)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .buttonStyle(.plain)
        .disabled(field.locked)
        .sheet(isPresented: $picking) {
            ImageChoiceSheet(document: document, path: path, hasValue: !value.isEmpty) { picked in
                Task { await document.edit(path, picked.map(JSONValue.string)) }
            }
        }
    }
}

/// The photo button beside text fields named like images (`src`, `image`).
struct ImageChooserButton: View {
    let document: DocumentModel
    let path: [PathKey]
    let onPick: (String?) -> Void
    @State private var picking = false

    var body: some View {
        Button {
            picking = true
        } label: {
            Image(systemName: "photo.badge.plus")
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Choose image")
        .sheet(isPresented: $picking) {
            ImageChoiceSheet(document: document, path: path, hasValue: true, onPick: onPick)
        }
    }
}

/// A grid of the images in a field's media folder.
struct ImageChoiceSheet: View {
    let document: DocumentModel
    let path: [PathKey]
    let hasValue: Bool
    let onPick: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var choices: ImageChoices?
    @State private var error: String?
    @State private var showingCdn = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let source = choices?.cdnSource {
                    Picker("Source", selection: $showingCdn) {
                        Text("On This Device").tag(false)
                        Text(source["label"]?.stringValue ?? source["name"]?.stringValue ?? "CDN").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .padding()
                }
                if showingCdn, let source = choices?.cdnSource {
                    CdnBrowser(engine: document.engine, source: source) { url in
                        onPick(url)
                        dismiss()
                    }
                } else {
                    localGrid
                }
            }
            .navigationTitle(choices?.media?.label ?? "Choose Image")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                if hasValue {
                    ToolbarItem(placement: .destructiveAction) {
                        Button("Clear", role: .destructive) {
                            onPick(nil)
                            dismiss()
                        }
                    }
                }
            }
            .task {
                do {
                    choices = try await document.engine.call("doc.imageChoices", ["path": path.json])
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
    }

    private var localGrid: some View {
        ScrollView {
            if let choices, !choices.files.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 8)], spacing: 8) {
                    ForEach(choices.files) { file in
                        Button {
                            onPick(file.value)
                            dismiss()
                        } label: {
                            VStack(spacing: 4) {
                                Thumbnail(path: file.path, maxPixels: 300)
                                    .aspectRatio(1, contentMode: .fit)
                                    .clipShape(.rect(cornerRadius: 8))
                                Text(file.name).font(.caption2).lineLimit(1).foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding()
            }
        }
        .overlay {
            if let error {
                ContentUnavailableView("Couldn't read images", systemImage: "exclamationmark.triangle", description: Text(error))
            } else if choices == nil {
                ProgressView()
            } else if choices?.media == nil {
                ContentUnavailableView("No media folder", systemImage: "photo", description: Text("This field has no media folder configured."))
            } else if choices?.files.isEmpty == true {
                ContentUnavailableView("No images yet", systemImage: "photo", description: Text("Add images to \(choices?.media?.input ?? "the media folder") from the Media screen."))
            }
        }
    }
}

/// Browses images already on a CDN source and picks one by its public URL,
/// asking for the storage password first when this device has none.
struct CdnBrowser: View {
    let engine: Engine
    let source: JSONValue
    let onPick: (String) -> Void
    @State private var folder: CdnFolder?
    @State private var prefix: String?
    @State private var error: String?
    @State private var credentialError: String?

    var body: some View {
        Group {
            if let folder, folder.needsCredential, let request = credentialRequest {
                Form {
                    CredentialFormSection(request: request, purpose: .browse) { credential in
                        guard let credential else { return }
                        Task { await save(credential) }
                    }
                }
            } else if let folder {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 8)], spacing: 8) {
                        if folder.prefix != folder.root {
                            Button {
                                let parent = folder.prefix.contains("/") ? String(folder.prefix[..<folder.prefix.lastIndex(of: "/")!]) : ""
                                prefix = parent.count >= folder.root.count ? parent : folder.root
                            } label: {
                                cell(name: "..", symbol: "arrow.turn.left.up")
                            }
                            .buttonStyle(.plain)
                        }
                        ForEach(folder.directories) { directory in
                            Button { prefix = directory.key } label: { cell(name: directory.name, symbol: "folder.fill") }
                                .buttonStyle(.plain)
                        }
                        ForEach(folder.images) { image in
                            Button {
                                onPick(image.url)
                            } label: {
                                VStack(spacing: 4) {
                                    Thumbnail(url: image.url)
                                        .aspectRatio(1, contentMode: .fit)
                                        .clipShape(.rect(cornerRadius: 8))
                                    Text(image.name).font(.caption2).lineLimit(1).foregroundStyle(.secondary)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding()
                }
                .overlay {
                    if folder.images.isEmpty && folder.directories.isEmpty {
                        ContentUnavailableView("No images on the CDN yet", systemImage: "icloud")
                    }
                }
            } else if let error {
                ContentUnavailableView {
                    Label("Couldn't list CDN images", systemImage: "icloud.slash")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try Again") { Task { await load() } }
                }
            } else {
                ProgressView().frame(maxHeight: .infinity)
            }
        }
        .task(id: prefix) { await load() }
    }

    private var credentialRequest: CredentialRequest? {
        guard let decoded = try? source.decode(as: CdnSource.self) else { return nil }
        return CredentialRequest(source: decoded, error: credentialError)
    }

    private func cell(name: String, symbol: String) -> some View {
        VStack(spacing: 4) {
            ZStack {
                RoundedRectangle(cornerRadius: 8).fill(.quaternary)
                Image(systemName: symbol).font(.title).foregroundStyle(.tint)
            }
            .aspectRatio(1, contentMode: .fit)
            Text(name).font(.caption2).lineLimit(1).foregroundStyle(.secondary)
        }
    }

    private func load() async {
        error = nil
        do {
            folder = try await engine.call("cdn.list", ["source": source, "prefix": JSONValue(prefix)])
        } catch {
            folder = nil
            self.error = error.localizedDescription
        }
    }

    private func save(_ credential: JSONValue) async {
        do {
            try await engine.run("cdn.saveCredential", ["source": source, "credential": credential])
            credentialError = nil
            await load()
        } catch {
            credentialError = error.localizedDescription
        }
    }
}

/// A reference to another entry: a menu of the collection's entries, or an
/// image picker when the reference targets an image library.
struct ReferenceFieldRow: View {
    let document: DocumentModel
    let field: FieldView
    let path: [PathKey]
    let value: String
    let label: String
    @State private var options: ReferenceOptions?
    @State private var pickingAsset = false
    @State private var creating = false
    @State private var editingDetails: LibraryDetails?

    var body: some View {
        if let library = field.imageLibrary {
            Button {
                pickingAsset = true
            } label: {
                HStack(spacing: 12) {
                    LibraryAssetThumbnail(document: document, library: library, entryId: value)
                        .frame(width: 64, height: 64)
                        .clipShape(.rect(cornerRadius: 8))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(label.isEmpty ? field.label : label).foregroundStyle(.primary)
                        Text(value.isEmpty ? "Choose image" : value).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
            .contextMenu {
                if !value.isEmpty {
                    Button {
                        Task { await editDetails(library: library) }
                    } label: {
                        Label("Edit Image Details", systemImage: "slider.horizontal.3")
                    }
                }
            }
            .swipeActions {
                if !value.isEmpty {
                    Button {
                        Task { await editDetails(library: library) }
                    } label: {
                        Label("Details", systemImage: "slider.horizontal.3")
                    }
                    .tint(.accentColor)
                }
            }
            .sheet(item: $editingDetails, onDismiss: { Task { await document.reload() } }) { details in
                AssetEditorSheet(media: details.media, item: details.item)
            }
            .sheet(isPresented: $pickingAsset) {
                LibraryAssetPicker(engine: document.engine, library: library, allowClear: !value.isEmpty && !field.required) { entryId in
                    Task { await document.edit(path, entryId.map(JSONValue.string)) }
                }
            }
        } else {
            let known = options?.options.contains { $0.value == value } ?? true
            HStack {
                Picker(selection: Binding(
                    get: { value },
                    set: { next in Task { await document.edit(path, next.isEmpty ? nil : .string(next)) } }
                )) {
                    if !field.required || value.isEmpty { Text("None").tag("") }
                    if !value.isEmpty && !known { Text("\(value) (missing)").tag(value) }
                    ForEach(options?.options ?? []) { option in
                        Text(option.label).tag(option.value)
                    }
                } label: {
                    Text(label.isEmpty ? field.label : label)
                }
                .pickerStyle(.navigationLink)
                if options?.collection != nil {
                    Button {
                        creating = true
                    } label: {
                        Image(systemName: "plus.circle")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Create \(options?.collection?.label ?? "entry")")
                }
            }
            .task(id: field.referenceCollection) {
                options = try? await document.engine.call("doc.referenceOptions", ["path": path.json])
            }
            .sheet(isPresented: $creating, onDismiss: {
                Task { options = try? await document.engine.call("doc.referenceOptions", ["path": path.json]) }
            }) {
                ReferenceDraftSheet(document: document, path: path)
            }
        }
    }
}

/// The library entry a reference points at, opened in the asset editor.
struct LibraryDetails: Identifiable {
    let media: MediaModel
    let item: MediaItem
    var id: String { item.id }
}

extension ReferenceFieldRow {
    /// Image-library references edit the chosen image's metadata (alt text,
    /// captions…) in the same editor the Media screen uses.
    func editDetails(library: String) async {
        let assets: [LibraryAsset] = (try? await document.engine.call("media.libraryAssets", ["library": .string(library)])) ?? []
        guard let asset = assets.first(where: { $0.entryId == value }) else { return }
        let media = MediaModel(repo: document.repo)
        media.selectTabWithoutLoading(library)
        editingDetails = LibraryDetails(
            media: media,
            item: MediaItem(id: asset.metadataPath, name: asset.name, imagePath: asset.imagePath, imageUrl: asset.imageUrl, kind: "image", problem: nil)
        )
    }
}

struct LibraryAssetThumbnail: View {
    let document: DocumentModel
    let library: String
    let entryId: String
    @State private var asset: LibraryAsset?

    var body: some View {
        Thumbnail(path: asset?.imagePath, url: asset?.imageUrl, maxPixels: 300)
            .task(id: entryId) {
                let assets: [LibraryAsset] = (try? await document.engine.call("media.libraryAssets", ["library": .string(library)])) ?? []
                asset = assets.first { $0.entryId == entryId }
            }
    }
}

/// Every usable image in a library, searchable, for picking an entry id.
struct LibraryAssetPicker: View {
    let engine: Engine
    let library: String
    let allowClear: Bool
    let onPick: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var assets: [LibraryAsset]?
    @State private var query = ""

    var body: some View {
        NavigationStack {
            let shown = (assets ?? []).filter { query.isEmpty || $0.entryId.localizedCaseInsensitiveContains(query) }
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 8)], spacing: 8) {
                    ForEach(shown) { asset in
                        Button {
                            onPick(asset.entryId)
                            dismiss()
                        } label: {
                            VStack(spacing: 4) {
                                Thumbnail(path: asset.imagePath, url: asset.imageUrl, maxPixels: 300)
                                    .aspectRatio(1, contentMode: .fit)
                                    .clipShape(.rect(cornerRadius: 8))
                                Text(asset.name).font(.caption2).lineLimit(1).foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding()
            }
            .overlay {
                if assets == nil { ProgressView() }
                else if shown.isEmpty { ContentUnavailableView.search(text: query) }
            }
            .searchable(text: $query)
            .navigationTitle(library)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                if allowClear {
                    ToolbarItem(placement: .destructiveAction) {
                        Button("Clear", role: .destructive) {
                            onPick(nil)
                            dismiss()
                        }
                    }
                }
            }
            .task { assets = (try? await engine.call("media.libraryAssets", ["library": .string(library)])) ?? [] }
        }
    }
}

/// Creates an entry in the referenced collection, then points the field at
/// it (or appends it, for reference lists).
struct ReferenceDraftSheet: View {
    let document: DocumentModel
    let path: [PathKey]
    @Environment(\.dismiss) private var dismiss
    @State private var form: MetadataFormModel?
    @State private var title = "New Entry"
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let form, let state = form.formState() {
                    FieldSections(sink: form, state: state, fields: form.fields)
                }
            }
            .overlay { if form == nil && error == nil { ProgressView() } }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        Task { try? await document.engine.run("reference.cancel") }
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton {
                        do {
                            let next: DocumentView = try await document.engine.call("reference.finish")
                            document.apply(next)
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    } label: {
                        Text("Save").bold()
                    }
                    .disabled(form?.valid != true)
                }
            }
            .task {
                do {
                    let draft: JSONValue = try await document.engine.call("reference.start", ["path": path.json])
                    let fields = try draft["fields"]?.decode(as: [FieldView].self) ?? []
                    form = MetadataFormModel(
                        engine: document.engine,
                        target: "reference",
                        fields: fields,
                        values: draft["values"] ?? .object([:]),
                        errors: (try? draft["errors"]?.decode(as: [String: String].self)) ?? [:],
                        dates: (try? draft["dates"]?.decode(as: [String: DateControl].self)) ?? [:]
                    )
                    title = "New \(draft["collection"]?["label"]?.stringValue ?? "Entry")"
                } catch {
                    self.error = error.localizedDescription
                }
            }
            .errorAlert($error)
        }
    }
}
