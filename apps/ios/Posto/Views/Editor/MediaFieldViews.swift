import SwiftUI

/// Resolves an image value (site path, document-relative path, or CDN URL)
/// to something displayable, through the engine's media rules. Works in
/// any form: a component's props resolve against the open document.
struct FieldImagePreview: View {
    let sink: any FormSink
    let path: [PathKey]
    let value: String
    @State private var preview: ImagePreview?

    var body: some View {
        Thumbnail(path: preview?.path, url: preview?.url, maxPixels: 300)
            .task(id: value) {
                preview = try? await sink.engine.call("form.imagePreview", [
                    "form": .string(sink.formTarget), "path": path.json, "value": .string(value),
                ])
            }
    }
}

/// An image field: the current image, and the app media picker (opening
/// at the field's media folder) to change it.
struct ImageFieldRow: View {
    let sink: any FormSink
    let repo: RepoModel
    let field: FieldView
    let path: [PathKey]
    let value: String
    let label: String
    @State private var picking = false
    @State private var error: String?

    var body: some View {
        Button {
            picking = true
        } label: {
            HStack(spacing: 12) {
                FieldImagePreview(sink: sink, path: path, value: value)
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
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(field.locked)
        .sheet(isPresented: $picking) {
            Group {
                ImageFieldPicker(sink: sink, repo: repo, path: path, value: value, onError: { error = $0 }) { picked in
                    Task { await sink.edit(path, picked.map(JSONValue.string)) }
                }
            }
            .macSheetSizing()
        }
        .errorAlert($error)
    }
}

/// The photo button beside text fields named like images (`src`, `image`),
/// the desktop editor's "Choose image".
struct ImageChooserButton: View {
    let sink: any FormSink
    let repo: RepoModel
    let path: [PathKey]
    let value: String
    let onPick: (String?) -> Void
    @State private var picking = false
    @State private var error: String?

    var body: some View {
        Button {
            picking = true
        } label: {
            Image(systemName: "photo.badge.plus")
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Choose image")
        .sheet(isPresented: $picking) {
            Group {
                ImageFieldPicker(sink: sink, repo: repo, path: path, value: value, onError: { error = $0 }, onPick: onPick)
            }
            .macSheetSizing()
        }
        .errorAlert($error)
    }
}

/// An image field's picker: the app media picker, opening at the media
/// folder of the field's current image (else the field's own), offering its
/// CDN when its images live on one, and writing the value the field stores.
struct ImageFieldPicker: View {
    let sink: any FormSink
    let repo: RepoModel
    let path: [PathKey]
    /// The field's current value: where the picker opens, and how a pick is
    /// written (as the desktop picker resolves the value's media folder).
    let value: String
    let onError: (String) -> Void
    let onPick: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var choices: ImageChoices?
    @State private var loaded = false

    var body: some View {
        if !loaded {
            ProgressView()
                .task {
                    choices = try? await sink.engine.call("form.imageChoices", [
                        "form": .string(sink.formTarget), "path": path.json, "value": .string(value),
                    ])
                    loaded = true
                }
        } else if choices?.media == nil {
            // As on desktop, where such a field's picker is disabled.
            NavigationStack {
                ContentUnavailableView("No media folder", systemImage: "photo",
                                       description: Text("This field has no media folder configured, so it can't pick images."))
                    .toolbar { ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } } }
            }
        } else {
            MediaPickerSheet(
                repo: repo,
                title: choices?.media?.label ?? "Choose Image",
                folder: mediaFolder,
                cdnSource: choices?.cdnSource,
                onClear: value.isEmpty ? nil : { onPick(nil) },
                imagesOnly: true
            ) { item, _ in
                if let file = item.imagePath {
                    Task {
                        // Through the field's media folder or public, or
                        // relative to the document for Astro image() fields.
                        let picked: String? = (try? await sink.engine.call("form.imageValue", [
                            "form": .string(sink.formTarget), "path": path.json,
                            "absolutePath": .string(file), "value": .string(value),
                        ], as: String?.self)) ?? nil
                        if let picked {
                            onPick(picked)
                        } else {
                            onError("This field can't use \(file.lastPathComponent). Pick an image from \(choices?.media?.input ?? "its media folder") or public.")
                        }
                    }
                } else if let url = item.imageUrl {
                    onPick(url)
                }
            }
        }
    }

    private var mediaFolder: String? {
        guard let input = choices?.media?.input, let root = repo.view?.root else { return nil }
        return "\(root)/\(input)"
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

/// A reference to another entry: a searchable list of the collection's
/// entries, or the app media picker (kept to that library) when the
/// reference targets an image library. Works in the document's form, a
/// component's props and a new referenced entry, as on desktop.
struct ReferenceFieldRow: View {
    let sink: any FormSink
    /// The document being edited (the context: its repo and media).
    let document: DocumentModel
    let field: FieldView
    let path: [PathKey]
    let value: String
    let label: String
    @State private var options: ReferenceOptions?
    @State private var pickingAsset = false
    @State private var creating = false
    @State private var editingDetails: LibraryDetails?
    /// The library's images, once read (an image-library reference), and
    /// the value they were read for.
    @State private var libraryAssets: [LibraryAsset]?
    @State private var assetsReadFor: String?
    @State private var libraryError: String?

    var body: some View {
        if let library = field.imageLibrary {
            let asset = libraryAssets?.first { $0.entryId == value }
            VStack(alignment: .leading, spacing: 8) {
                // As desktop's image-library field warns.
                if let libraryError {
                    NoticeRow(message: "Could not read image library: \(libraryError)", systemImage: "exclamationmark.triangle.fill", tint: .orange)
                } else if !value.isEmpty, assetsReadFor == value, asset == nil {
                    NoticeRow(message: "The selected image entry is missing.", systemImage: "exclamationmark.triangle.fill", tint: .orange)
                }
                Button {
                    pickingAsset = true
                } label: {
                    HStack(spacing: 12) {
                        Thumbnail(path: asset?.imagePath, url: asset?.imageUrl, maxPixels: 300)
                            .frame(width: 64, height: 64)
                            .clipShape(.rect(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(label.isEmpty ? field.label : label).foregroundStyle(.primary)
                            Text(value.isEmpty ? "Choose image" : value).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
            .task(id: "\(library)|\(value)|\(document.repo.mediaVersion)") {
                let readFor = value
                do {
                    libraryAssets = try await document.engine.call("media.libraryAssets", ["library": .string(library)])
                    assetsReadFor = readFor
                    libraryError = nil
                } catch {
                    libraryError = error.localizedDescription
                }
            }
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
                Group {
                    AssetEditorSheet(media: details.media, item: details.item)
                }
                .macSheetSizing()
            }
            .sheet(isPresented: $pickingAsset) {
                Group {
                    MediaPickerSheet(
                        repo: document.repo,
                        title: library,
                        library: library,
                        // As desktop: whatever is chosen can be cleared.
                        onClear: value.isEmpty ? nil : { Task { await sink.edit(path, nil) } },
                        imagesOnly: true
                    ) { item, _ in
                        guard let entryId = item.entryId else { return }
                        Task { await sink.edit(path, .string(entryId)) }
                    }
                }
                .macSheetSizing()
            }
        } else {
            HStack {
                ChoiceField(
                    title: label.isEmpty ? field.label : label,
                    options: options?.options ?? [],
                    loading: options == nil,
                    value: value,
                    clearable: !field.required,
                    unknownLabel: { "\($0) (missing)" }
                ) { next in
                    Task { await sink.edit(path, next.map(JSONValue.string)) }
                }
                // Creating the referenced entry belongs to the document's
                // own fields.
                if options?.collection != nil, sink.formTarget == "document" {
                    Button {
                        creating = true
                    } label: {
                        Image(systemName: "plus.circle")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Create \(options?.collection?.label ?? "entry")")
                }
            }
            .task(id: field.referenceCollection) { await loadOptions() }
            .sheet(isPresented: $creating, onDismiss: {
                Task { await loadOptions() }
            }) {
                Group {
                    ReferenceDraftSheet(document: document, path: path)
                }
                .macSheetSizing()
            }
        }
    }

    private func loadOptions() async {
        options = (try? await sink.engine.call("form.referenceOptions", ["form": .string(sink.formTarget), "path": path.json]))
            ?? ReferenceOptions(options: [], collection: nil)
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
                    // The document is the pickers' context (repo, engine);
                    // the engine resolves the draft's fields against the
                    // referenced collection.
                    FieldSections(sink: form, state: state, fields: form.fields, document: document)
                }
            }
            .overlay { if form == nil && error == nil { ProgressView() } }
            .navigationTitle(title)
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    CloseButton {
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
            // Once: a long select's options push over the form, and
            // starting the draft again would reset it.
            .taskOnce {
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
