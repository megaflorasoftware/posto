import SwiftUI

/// Imports picked photos into an image library: one page per image with its
/// filename and the library's metadata fields, prefilled from the photo.
struct LibraryImportSheet: View {
    let media: MediaModel
    let request: ImportRequest
    @Environment(\.dismiss) private var dismiss
    @State private var view: ImportView?
    @State private var forms: [MetadataFormModel] = []
    @State private var filenames: [String] = []
    @State private var page = 0
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let view, !view.drafts.isEmpty {
                    TabView(selection: $page) {
                        ForEach(Array(view.drafts.enumerated()), id: \.offset) { index, draft in
                            draftPage(view: view, draft: draft, index: index)
                                .tag(index)
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: view.drafts.count > 1 ? .always : .never))
                    .indexViewStyle(.page(backgroundDisplayMode: .always))
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    CloseButton {
                        Task { try? await media.engine.run("media.cancelImport") }
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton {
                        await runImport()
                    } label: {
                        Text(forms.count > 1 ? "Import \(forms.count)" : "Import").bold()
                    }
                    .disabled(!canImport)
                }
            }
            .task { await start() }
            .errorAlert($error)
        }
    }

    private var title: String {
        guard let view else { return "Import" }
        return "Import into \(view.library)"
    }

    private var canImport: Bool {
        !forms.isEmpty && forms.allSatisfy(\.valid) && filenames.allSatisfy { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private func draftPage(view: ImportView, draft: ImportDraftView, index: Int) -> some View {
        Form {
            Section {
                Thumbnail(path: draft.sourceImagePath, maxPixels: 900)
                    .aspectRatio(4 / 3, contentMode: .fit)
                    .clipShape(.rect(cornerRadius: 10))
                    .listRowInsets(EdgeInsets())
            }
            Section {
                HStack(spacing: 4) {
                    TextField("Filename", text: Binding(
                        get: { filenames.indices.contains(index) ? filenames[index] : "" },
                        set: { next in
                            guard filenames.indices.contains(index) else { return }
                            filenames[index] = next
                            Task { _ = try? await media.engine.call("media.updateDraft", ["index": .number(Double(index)), "filename": .string(next)], as: JSONValue.self) }
                        }
                    ))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    Text(".\(draft.extension)").foregroundStyle(.secondary)
                }
                if view.metadataExtensions.count > 1 {
                    Picker("Metadata format", selection: Binding(
                        get: { draft.metadataExtension ?? "" },
                        set: { next in
                            Task {
                                self.view = try? await media.engine.call("media.updateDraft", ["index": .number(Double(index)), "metadataExtension": .string(next)])
                            }
                        }
                    )) {
                        ForEach(view.metadataExtensions, id: \.self) { Text($0).tag($0) }
                    }
                }
            } header: {
                Text("Filename (framework ID)")
            } footer: {
                Text(view.folder.isEmpty ? "Importing at the library root." : "Importing into \(view.folder).")
            }
            if forms.indices.contains(index), let state = forms[index].formState() {
                FieldSections(sink: forms[index], state: state, fields: forms[index].fields)
            }
        }
    }

    private func start() async {
        do {
            let started: ImportView = try await media.engine.call("media.startImport", [
                "tab": .string(request.tab),
                "folder": .string(request.folder),
                "sources": .array(request.sources.map(JSONValue.string)),
            ])
            view = started
            forms = started.drafts.enumerated().map { index, draft in
                MetadataFormModel(engine: media.engine, target: "import:\(index)", fields: started.fields, values: draft.values, errors: draft.errors, dates: draft.dates)
            }
            filenames = started.drafts.map(\.filename)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func runImport() async {
        do {
            _ = try await media.engine.call("media.executeImport", as: JSONValue.self)
            await media.load(reload: true)
            dismiss()
        } catch {
            self.error = error.localizedDescription
            // Drafts that landed were dropped; show what's left.
            if let remaining: ImportView = try? await media.engine.call("media.importView") {
                view = remaining
                forms = remaining.drafts.enumerated().map { index, draft in
                    MetadataFormModel(engine: media.engine, target: "import:\(index)", fields: remaining.fields, values: draft.values, errors: draft.errors, dates: draft.dates)
                }
                filenames = remaining.drafts.map(\.filename)
                page = 0
            }
        }
    }
}

/// Edits one library image: its filename (renaming updates references) and
/// metadata, or deletes it.
struct AssetEditorSheet: View {
    let media: MediaModel
    let item: MediaItem
    @Environment(\.dismiss) private var dismiss
    @State private var asset: AssetEditorView?
    @State private var form: MetadataFormModel?
    @State private var filename = ""
    @State private var confirmingDelete = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let asset {
                    Section {
                        Thumbnail(path: asset.imagePath, url: asset.imagePath == nil ? asset.imageUrl : nil, maxPixels: 900)
                            .aspectRatio(4 / 3, contentMode: .fit)
                            .clipShape(.rect(cornerRadius: 10))
                            .listRowInsets(EdgeInsets())
                    }
                    Section {
                        if asset.filename != nil {
                            TextField("Filename", text: $filename)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        } else if let url = asset.imageUrl {
                            LabeledContent("CDN URL") {
                                Text(url).font(.caption).textSelection(.enabled).lineLimit(2)
                            }
                        }
                    } header: {
                        Text(asset.entryId)
                    } footer: {
                        if asset.filename != nil {
                            Text("Renaming updates every document that uses this image.")
                        }
                    }
                    if let form, let state = form.formState() {
                        FieldSections(sink: form, state: state, fields: form.fields)
                    }
                    Section {
                        Button("Delete Image", role: .destructive) { confirmingDelete = true }
                    }
                }
            }
            .overlay { if asset == nil { ProgressView() } }
            .navigationTitle("Edit Image")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton {
                        do {
                            try await media.engine.run("media.saveAsset", ["filename": asset?.filename == nil ? .null : .string(filename)])
                            await media.load(reload: true)
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
            .confirmationDialog("Delete this image?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete Image", role: .destructive) {
                    Task {
                        do {
                            try await media.engine.run("media.deleteAsset")
                            await media.load(reload: true)
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
            } message: {
                Text("This cannot be undone in Posto.")
            }
            .task {
                do {
                    let opened: AssetEditorView = try await media.engine.call("media.openAsset", ["tab": .string(media.tab), "id": .string(item.id)])
                    asset = opened
                    filename = opened.filename ?? ""
                    form = MetadataFormModel(engine: media.engine, target: "asset", fields: opened.fields, values: opened.values, errors: opened.errors, dates: opened.dates)
                } catch {
                    self.error = error.localizedDescription
                }
            }
            .onDisappear { Task { try? await media.engine.run("media.closeAsset") } }
            .errorAlert($error)
        }
    }
}

/// Renames or deletes a `public` file; renaming rewrites references.
struct PublicFileSheet: View {
    let media: MediaModel
    let item: MediaItem
    @Environment(\.dismiss) private var dismiss
    @State private var filename = ""
    @State private var confirmingDelete = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Group {
                        if item.kind == "image" {
                            Thumbnail(path: item.imagePath, maxPixels: 900)
                        } else {
                            ZStack {
                                Rectangle().fill(.quaternary)
                                Image(systemName: mediaSymbol(for: item.kind, name: item.name)).font(.system(size: 48)).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .aspectRatio(4 / 3, contentMode: .fit)
                    .clipShape(.rect(cornerRadius: 10))
                    .listRowInsets(EdgeInsets())
                }
                Section {
                    TextField("Filename", text: $filename)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Renaming updates links to this file in your documents.")
                }
                Section {
                    Button("Delete File", role: .destructive) { confirmingDelete = true }
                }
            }
            .navigationTitle("Edit \(item.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton {
                        if let failure = await media.renamePublic(item, to: filename) {
                            error = failure
                        } else {
                            dismiss()
                        }
                    } label: {
                        Text("Save").bold()
                    }
                }
            }
            .confirmationDialog("Delete \(item.name)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete File", role: .destructive) {
                    Task {
                        await media.deletePublic(item)
                        dismiss()
                    }
                }
            }
            .onAppear { filename = item.name }
            .errorAlert($error)
        }
        .presentationDetents([.medium, .large])
    }
}

/// Picks the folder selected media moves into.
struct MoveSheet: View {
    let media: MediaModel
    @Environment(\.dismiss) private var dismiss
    @State private var targets: [String]?

    var body: some View {
        NavigationStack {
            List(targets ?? [], id: \.self) { target in
                Button {
                    Task {
                        await media.moveSelection(to: target)
                        dismiss()
                    }
                } label: {
                    Label(target.isEmpty ? "Top level" : target, systemImage: target.isEmpty ? "tray" : "folder")
                        .foregroundStyle(.primary)
                }
                .disabled(target == media.directory)
            }
            .overlay { if targets == nil { ProgressView() } }
            .navigationTitle("Move To")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
            }
            .task { targets = await media.moveTargets() }
        }
        .presentationDetents([.medium, .large])
    }
}
