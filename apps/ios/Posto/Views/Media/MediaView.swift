import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Media management, reached from Site Settings: image libraries, `src`
/// images, and `public` files.
struct MediaView: View {
    let repo: RepoModel
    @State private var media: MediaModel?

    var body: some View {
        Group {
            if let media {
                MediaBrowser(media: media, mode: .manage)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Media")
        .inlineNavigationTitle()
        .task {
            let model = MediaModel(repo: repo)
            media = model
            await model.start()
        }
        .onChange(of: repo.mediaVersion) { Task { await media?.load(reload: true) } }
    }
}

/// The tab picker, folder grid, and (when managing) every media action.
struct MediaBrowser: View {
    enum Mode {
        case manage
        /// Picks an item: one shown, or one just imported into the open tab
        /// (with its library alt text), as the desktop picker's Import does.
        case pick((MediaItem, String?) -> Void)

        var isManaging: Bool {
            if case .manage = self { return true }
            return false
        }
    }

    @Bindable var media: MediaModel
    let mode: Mode
    /// Picking for an image field or reference: only images can be picked
    /// (as the desktop image pickers list only images).
    var imagesOnly = false
    @State private var newFolderName = ""
    @State private var creatingFolder = false
    @State private var confirmingDelete = false
    @State private var moving = false
    @State private var validation: ValidationResult?
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var choosingPhotos = false
    @State private var choosingFiles = false
    @State private var importing: ImportRequest?
    @State private var editingAsset: MediaItem?
    @State private var editingFile: MediaItem?
    @State private var preparing = false
    /// An import made while picking, picked once its sheet has closed (a
    /// picker closing itself mid-transition would stay open).
    @State private var importedPick: (item: MediaItem, alt: String?)?

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: 10)]

    var body: some View {
        withPickers(withSheets(grid
            .overlay { overlayContent }
            .refreshable { await media.load(reload: true) }
            .toolbar { if mode.isManaging { manageToolbar } else { pickToolbar } }
            .toolbarGroups(.bottomControls, gap: .flexible, active: mode.isManaging && !media.readOnly && media.selecting) {
                Button(media.everythingSelected ? "Deselect All" : "Select All") { media.toggleAll() }
            } then: {
                selectionActions
            }))
    }

    private var grid: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                tabPicker
                if let error = media.error {
                    NoticeRow(message: error, systemImage: "exclamationmark.triangle.fill", tint: .red)
                        .padding(.horizontal)
                }
                if !media.directory.isEmpty {
                    Button {
                        media.directory = parentDirectory(media.directory)
                    } label: {
                        Label(media.directory, systemImage: "chevron.backward")
                            .font(.subheadline.weight(.medium))
                    }
                    .padding(.horizontal)
                }
                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(media.listing?.folders ?? []) { folder in
                        folderCell(folder)
                    }
                    ForEach(media.listing?.items ?? []) { item in
                        itemCell(item)
                    }
                }
                .padding(.horizontal)
            }
            .padding(.vertical)
        }
    }

    private func parentDirectory(_ directory: String) -> String {
        guard let slash = directory.lastIndex(of: "/") else { return "" }
        return String(directory[..<slash])
    }

    @ViewBuilder
    private var overlayContent: some View {
        if media.listing == nil && media.loading {
            ProgressView()
        } else if let listing = media.listing, listing.folders.isEmpty, listing.items.isEmpty {
            ContentUnavailableView(
                "Nothing here yet",
                systemImage: "photo.on.rectangle",
                description: Text(media.readOnly ? "Images under src appear here." : "Import images or files to add them.")
            )
        }
        if let progress = media.repo.mediaProgress, progress.total > 0 {
            VStack(spacing: 8) {
                ProgressView(value: Double(progress.done), total: Double(progress.total))
                Text("Checking \(progress.done) of \(progress.total) items…").font(.footnote)
            }
            .padding()
            .glassPanel(cornerRadius: 14)
            .padding()
        }
        if preparing {
            ProgressView("Preparing images…")
                .padding()
                .glassPanel(cornerRadius: 14)
        }
    }

    private func withSheets<Content: View>(_ content: Content) -> some View {
        content
            .alert("New Folder", isPresented: $creatingFolder) {
                TextField("Name", text: $newFolderName)
                Button("Cancel", role: .cancel) {}
                Button("Create") { Task { await media.createFolder(named: newFolderName) } }
            }
            .confirmationDialog(deleteTitle, isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { Task { await media.deleteSelection() } }
            } message: {
                Text("This deletes the selected items and everything inside selected folders from the project. This cannot be undone in Posto.")
            }
            .sheet(isPresented: $moving) {
                Group {
                    MoveSheet(media: media)
                }
                .macSheetSizing()
            }
            .sheet(item: $importing, onDismiss: {
                // Picking: the image just imported is the pick.
                guard case .pick(let pick) = mode, let picked = importedPick else { return }
                importedPick = nil
                pick(picked.item, picked.alt)
            }) { request in
                Group {
                    LibraryImportSheet(media: media, request: request) { imported in
                        guard let first = imported.first else { return }
                        importedPick = (MediaItem(id: first.imagePath, name: first.imagePath.lastPathComponent, imagePath: first.imagePath,
                                                  imageUrl: nil, kind: "image", problem: nil, entryId: first.entryId), first.alt)
                    }
                }
                .macSheetSizing()
            }
            .sheet(item: $editingAsset) { item in
                Group {
                    AssetEditorSheet(media: media, item: item)
                }
                .macSheetSizing()
            }
            .sheet(item: $editingFile) { item in
                Group {
                    PublicFileSheet(media: media, item: item)
                }
                .macSheetSizing()
            }
    }

    private func withPickers<Content: View>(_ content: Content) -> some View {
        content
            .sheet(item: credentialBinding) { request in
                Group {
                    NavigationStack {
                        Form {
                            CredentialFormSection(request: request, purpose: .upload) { credential in
                                Task { await media.repo.submitMediaCredential(credential) }
                            }
                        }
                        .navigationTitle("Storage Password")
                        .inlineNavigationTitle()
                    }
                    .presentationDetents([.medium])
                }
                .macSheetSizing()
            }
            .alert("Validation", isPresented: validationShown, presenting: validation) { _ in
                Button("OK", role: .cancel) {}
            } message: { result in
                Text(validationSummary(result))
            }
            // Picking takes one item; managing imports any number.
            .photosPicker(isPresented: $choosingPhotos, selection: $photoSelection, maxSelectionCount: mode.isManaging ? nil : 1,
                          matching: .images, photoLibrary: .shared())
            .onChange(of: photoSelection) { _, items in
                guard !items.isEmpty else { return }
                photoSelection = []
                Task { await importPhotos(items) }
            }
            .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: mode.isManaging) { result in
                if case .success(let urls) = result { Task { await importFiles(urls) } }
            }
    }

    private var credentialBinding: Binding<CredentialRequest?> {
        Binding(get: { media.repo.mediaCredential }, set: { media.repo.mediaCredential = $0 })
    }

    private var validationShown: Binding<Bool> {
        Binding(get: { validation != nil }, set: { if !$0 { validation = nil } })
    }

    // MARK: Tabs

    @ViewBuilder
    private var tabPicker: some View {
        if media.tabs.count > 1 {
            Picker("Source", selection: $media.tab) {
                ForEach(media.tabs) { tab in
                    Text(tab.label).tag(tab.id)
                }
            }
            .pickerStyle(.segmented)
            // On macOS a segmented picker also shows its title beside it.
            .labelsHidden()
            .padding(.horizontal)
        }
    }

    // MARK: Cells

    private func folderCell(_ folder: MediaFolder) -> some View {
        let selected = media.selectedFolders.contains(folder.path)
        return Button {
            if media.selecting { media.toggle(folder: folder) } else { media.directory = relative(folder.path) }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10).fill(.quaternary)
                    if folder.previews.isEmpty {
                        Image(systemName: "folder.fill").font(.largeTitle).foregroundStyle(.tint)
                    } else if folder.previews.count == 1, let preview = folder.previews.first {
                        Thumbnail(path: preview.hasPrefix("http") ? nil : preview, url: preview.hasPrefix("http") ? preview : nil, maxPixels: 300)
                            .clipShape(.rect(cornerRadius: 10))
                    } else {
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 2), GridItem(.flexible(), spacing: 2)], spacing: 2) {
                            ForEach(folder.previews.prefix(4), id: \.self) { preview in
                                Thumbnail(path: preview.hasPrefix("http") ? nil : preview, url: preview.hasPrefix("http") ? preview : nil, maxPixels: 160)
                                    .aspectRatio(1, contentMode: .fit)
                                    .clipShape(.rect(cornerRadius: 4))
                            }
                        }
                        .padding(4)
                    }
                }
                .aspectRatio(1, contentMode: .fit)
                .overlay(alignment: .topTrailing) { selectionBadge(selected) }
                Label(folder.name, systemImage: "folder").font(.caption).lineLimit(1)
            }
        }
        .buttonStyle(.plain)
    }

    private func itemCell(_ item: MediaItem) -> some View {
        let selected = media.selectedItems.contains(item.id)
        return Button {
            if media.selecting {
                media.toggle(item: item)
            } else if case .pick(let pick) = mode {
                // Broken library entries and, for images, other files can't
                // be picked.
                if pickable(item) { pick(item, nil) }
            } else if media.isLibrary {
                if item.problem == nil { editingAsset = item }
            } else if media.isPublic {
                editingFile = item
            }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Group {
                    if item.kind == "image" {
                        Thumbnail(path: item.imagePath, url: item.imagePath == nil ? item.imageUrl : nil, maxPixels: 300)
                    } else {
                        ZStack {
                            Rectangle().fill(.quaternary)
                            Image(systemName: mediaSymbol(for: item.kind, name: item.name)).font(.largeTitle).foregroundStyle(.secondary)
                        }
                    }
                }
                .aspectRatio(1, contentMode: .fit)
                .clipShape(.rect(cornerRadius: 10))
                .overlay(alignment: .topTrailing) { selectionBadge(selected) }
                .overlay(alignment: .bottomLeading) {
                    if item.imagePath == nil && item.imageUrl != nil {
                        Image(systemName: "icloud.fill")
                            .font(.caption)
                            .padding(5)
                            .background(.ultraThinMaterial, in: .circle)
                            .padding(5)
                    }
                }
                Text(item.problem ?? item.name)
                    .font(.caption)
                    .foregroundStyle(item.problem == nil ? Color.primary : Color.red)
                    .lineLimit(1)
            }
            .opacity(item.problem == nil && (mode.isManaging || pickable(item)) ? 1 : 0.4)
        }
        .buttonStyle(.plain)
    }

    private func pickable(_ item: MediaItem) -> Bool {
        item.problem == nil && (!imagesOnly || item.kind == "image")
    }

    @ViewBuilder
    private func selectionBadge(_ selected: Bool) -> some View {
        if media.selecting {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, selected ? Color.accentColor : Color.black.opacity(0.3))
                .padding(6)
        }
    }

    private func relative(_ path: String) -> String {
        guard let root = media.listing?.rootDirectory, path.hasPrefix(root + "/") else { return path }
        return String(path.dropFirst(root.count + 1))
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var manageToolbar: some ToolbarContent {
        if !media.readOnly {
            ToolbarItem(placement: .barTrailing) {
                Button(media.selecting ? "Done" : "Select") {
                    media.selecting.toggle()
                    media.clearSelection()
                }
            }
            if !media.selecting {
                ToolbarItem(placement: .barTrailing) {
                    Menu {
                        Button {
                            choosingPhotos = true
                        } label: {
                            Label(media.isLibrary ? "Import Images" : "Import from Photos", systemImage: "photo.on.rectangle")
                        }
                        if media.isPublic {
                            Button {
                                choosingFiles = true
                            } label: {
                                Label("Import Files", systemImage: "doc.badge.plus")
                            }
                        }
                        Button {
                            newFolderName = ""
                            creatingFolder = true
                        } label: {
                            Label("New Folder", systemImage: "folder.badge.plus")
                        }
                    } label: {
                        Label("Add", systemImage: "plus")
                    }
                }
            }
        }
    }

    /// Picking (Insert Media, Replace): import from Photos (and, into
    /// `public`, from Files) and pick what was imported, as the desktop
    /// picker's Import image and Import file do.
    @ToolbarContentBuilder
    private var pickToolbar: some ToolbarContent {
        if !media.readOnly {
            ToolbarItem(placement: .barTrailing) {
                Menu {
                    Button {
                        choosingPhotos = true
                    } label: {
                        Label("Import from Photos", systemImage: "photo.on.rectangle")
                    }
                    if media.isPublic && !imagesOnly {
                        Button {
                            choosingFiles = true
                        } label: {
                            Label("Import File", systemImage: "doc.badge.plus")
                        }
                    }
                } label: {
                    Label("Import", systemImage: "plus")
                }
            }
        }
    }

    @ViewBuilder
    private var selectionActions: some View {
        if media.isLibrary {
            Button {
                Task { validation = await media.validateSelection() }
            } label: {
                Label("Validate", systemImage: "checkmark.seal")
            }
            .disabled(!media.hasSelection)
        }
        Button {
            moving = true
        } label: {
            Label("Move", systemImage: "folder")
        }
        .disabled(!media.hasSelection)
        Button(role: .destructive) {
            confirmingDelete = true
        } label: {
            Label("Delete", systemImage: "trash")
        }
        .disabled(!media.hasSelection)
    }

    private var deleteTitle: String {
        let count = media.selectedItems.count + media.selectedFolders.count
        return count == 1 ? "Delete item?" : "Delete \(count) items?"
    }

    private func validationSummary(_ result: ValidationResult) -> String {
        if let skipped = result.skipped { return skipped }
        var lines = ["Updated \(result.updated) \(result.updated == 1 ? "item" : "items"). \(result.unchanged) \(result.unchanged == 1 ? "item was" : "items were") already correct."]
        for failure in result.failed { lines.append("\(failure.entryId): \(failure.message)") }
        return lines.joined(separator: "\n")
    }

    // MARK: Importing

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        preparing = true
        defer { preparing = false }
        var paths: [String] = []
        for (index, item) in items.enumerated() {
            if let path = await PhotoImport.temporaryFile(for: item, index: index, engine: media.engine) {
                paths.append(path)
            }
        }
        guard !paths.isEmpty else { return }
        if media.isLibrary {
            importing = ImportRequest(tab: media.tab, folder: media.directory, sources: paths)
        } else {
            await importPublic(paths)
        }
    }

    private func importFiles(_ urls: [URL]) async {
        preparing = true
        defer { preparing = false }
        let paths = urls.compactMap(PhotoImport.copyToTemporary)
        await importPublic(paths)
    }

    /// Into `public`; when picking, the imported file is the pick.
    private func importPublic(_ paths: [String]) async {
        guard case .pick(let pick) = mode else {
            await media.importPublic(paths)
            return
        }
        do {
            let imported: [String] = try await media.engine.call("media.importPublic", [
                "directory": .string(media.directory), "sources": .array(paths.map(JSONValue.string)),
            ])
            await media.load(reload: true)
            // The listing's own item carries the engine's kind (image, audio,
            // video or link).
            if let path = imported.first,
               let item = media.listing?.items.first(where: { $0.imagePath == path || $0.id == path }) {
                pick(item, nil)
            }
        } catch {
            media.error = error.localizedDescription
        }
    }
}

struct ImportRequest: Identifiable {
    let id = UUID()
    let tab: String
    let folder: String
    let sources: [String]
}

/// Photos and Files hand back data, not paths; the engine and Rust import
/// from files on disk, so picks land in a temporary folder first. HEIC
/// photos become JPEG (sites can't show HEIC); the original is kept so its
/// capture date is still read.
enum PhotoImport {
    static var directory: URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("posto-imports", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func temporaryFile(for item: PhotosPickerItem, index: Int, engine: Engine) async -> String? {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
        let type = item.supportedContentTypes.first { $0.conforms(to: .image) } ?? .jpeg
        let stamp = Int(Date().timeIntervalSince1970)
        let stem = "photo-\(stamp)-\(index + 1)"
        let isHeif = type.conforms(to: .heic) || type.conforms(to: .heif) || type.identifier == "public.heif"
        let original = directory.appendingPathComponent("\(stem).\(type.preferredFilenameExtension ?? "jpg")")
        do {
            try data.write(to: original)
        } catch {
            return nil
        }
        guard isHeif else { return original.path }
        let converted = directory.appendingPathComponent("\(stem).jpg")
        guard convertToJPEG(source: original, destination: converted) else { return original.path }
        try? await engine.run("media.rememberConverted", ["converted": .string(converted.path), "original": .string(original.path)])
        return converted.path
    }

    static func convertToJPEG(source: URL, destination: URL) -> Bool {
        guard let input = CGImageSourceCreateWithURL(source as CFURL, nil),
              let output = CGImageDestinationCreateWithURL(destination as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
        else { return false }
        let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.92]
        CGImageDestinationAddImageFromSource(output, input, 0, options as CFDictionary)
        return CGImageDestinationFinalize(output)
    }

    static func copyToTemporary(_ url: URL) -> String? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let destination = directory.appendingPathComponent(url.lastPathComponent)
        try? FileManager.default.removeItem(at: destination)
        do {
            try FileManager.default.copyItem(at: url, to: destination)
            return destination.path
        } catch {
            return nil
        }
    }
}
