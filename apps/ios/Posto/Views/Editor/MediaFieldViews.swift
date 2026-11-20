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

    var body: some View {
        NavigationStack {
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
