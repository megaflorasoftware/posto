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
    @State private var dropTargeted = false

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: 10)]

    var body: some View {
        withPickers(withSheets(grid
            .overlay { overlayContent }
            .overlay { dropHighlight }
            // Files dragged in (from Files, Photos or Finder) import into
            // the open library or folder, as a drop onto the desktop app does.
            .onDrop(of: MediaDropDelegate.types, delegate: MediaDropDelegate(
                enabled: mode.isManaging && !media.readOnly && !media.tab.isEmpty,
                imagesOnly: media.isLibrary,
                targeted: $dropTargeted
            ) { providers in
                receiveDrop(providers)
            })
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
        if let progress = media.repo?.mediaProgress, progress.total > 0 {
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
                                Task { await media.repo?.submitMediaCredential(credential) }
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
        Binding(get: { media.repo?.mediaCredential }, set: { media.repo?.mediaCredential = $0 })
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
                FolderPreview(previews: folder.previews)
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

    @ViewBuilder
    private var dropHighlight: some View {
        if dropTargeted {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 3, dash: [8, 6]))
                .background(Color.accentColor.opacity(0.08), in: .rect(cornerRadius: 14))
                .overlay {
                    Label(media.isLibrary ? "Drop images to import" : "Drop files to import", systemImage: "square.and.arrow.down")
                        .font(.headline)
                        .padding()
                        .glassPanel(cornerRadius: 14)
                }
                .padding(6)
                .allowsHitTesting(false)
        }
    }

    /// Dropped files: into a library through its import sheet (names and
    /// metadata, as for Photos), into `public` directly. Called while the
    /// drop is performed, so every item's data is asked for then.
    private func receiveDrop(_ providers: [NSItemProvider]) {
        let imagesOnly = media.isLibrary
        let loading = PhotoImport.loadDropped(providers, imagesOnly: imagesOnly)
        preparing = true
        Task {
            defer { preparing = false }
            await importDropped(await loading.value, imagesOnly: imagesOnly)
        }
    }

    private func importDropped(_ files: [PhotoImport.DroppedFile], imagesOnly: Bool) async {
        var paths: [String] = []
        for file in files {
            paths.append(await PhotoImport.importable(file, engine: media.engine))
        }
        guard !paths.isEmpty else {
            media.error = imagesOnly ? "Only images can be imported into a media library." : "Those items couldn't be imported."
            return
        }
        if imagesOnly {
            importing = ImportRequest(tab: media.tab, folder: media.directory, sources: paths)
        } else {
            await media.importPublic(paths)
        }
    }

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

/// A folder tile's square: a folder symbol, its one image, or a 2×2 collage
/// of its first images. The square alone sets the tile's size, with the
/// images laid over it at sizes computed from it and clipped to it, so
/// thumbnails loading (or a sheet still settling its width) can never grow
/// the tile over its label or the next row.
private struct FolderPreview: View {
    let previews: [String]

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .background(.quaternary, in: .rect(cornerRadius: 10))
            .overlay {
                if previews.isEmpty {
                    Image(systemName: "folder.fill").font(.largeTitle).foregroundStyle(.tint)
                } else if previews.count == 1, let preview = previews.first {
                    thumbnail(preview, maxPixels: 300)
                } else {
                    GeometryReader { proxy in
                        collage(in: proxy.size)
                    }
                }
            }
            .clipShape(.rect(cornerRadius: 10))
    }

    private func collage(in size: CGSize) -> some View {
        let inset: CGFloat = 4
        let spacing: CGFloat = 2
        let cell = max(0, (min(size.width, size.height) - inset * 2 - spacing) / 2)
        let shown = Array(previews.prefix(4))
        let rows = stride(from: 0, to: shown.count, by: 2).map { Array(shown[$0..<min($0 + 2, shown.count)]) }
        return VStack(alignment: .leading, spacing: spacing) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: spacing) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, preview in
                        thumbnail(preview, maxPixels: 160)
                            .frame(width: cell, height: cell)
                            .clipShape(.rect(cornerRadius: 4))
                    }
                }
            }
        }
        .frame(width: size.width, height: size.height)
    }

    private func thumbnail(_ preview: String, maxPixels: Int) -> some View {
        let remote = preview.hasPrefix("http")
        return Thumbnail(path: remote ? nil : preview, url: remote ? preview : nil, maxPixels: maxPixels)
    }
}

/// Accepts files dragged onto the media grid: images for a library, any
/// files for `public`, nothing for the read-only `src` tab or a picker.
private struct MediaDropDelegate: DropDelegate {
    /// Images (from Photos, or a file's own type) and file URLs (Finder).
    static let types: [UTType] = [.image, .fileURL, .data]

    let enabled: Bool
    let imagesOnly: Bool
    @Binding var targeted: Bool
    let receive: ([NSItemProvider]) -> Void

    private var accepted: [UTType] { imagesOnly ? [.image, .fileURL] : Self.types }

    func validateDrop(info: DropInfo) -> Bool {
        enabled && info.hasItemsConforming(to: accepted)
    }

    func dropEntered(info: DropInfo) {
        targeted = validateDrop(info: info)
    }

    func dropExited(info: DropInfo) {
        targeted = false
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: validateDrop(info: info) ? .copy : .forbidden)
    }

    func performDrop(info: DropInfo) -> Bool {
        targeted = false
        guard validateDrop(info: info) else { return false }
        let providers = info.itemProviders(for: accepted)
        guard !providers.isEmpty else { return false }
        receive(providers)
        return true
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

    /// A dropped item copied to a temporary file, with the type it was read
    /// as (HEIC still to convert).
    struct DroppedFile: Sendable {
        let path: String
        let type: UTType?
    }

    /// Starts reading every dropped item right away, while the drop is
    /// being performed (later, the system no longer has to hand the data
    /// over), and finishes when all are copied out. With `imagesOnly`,
    /// anything that isn't an image is skipped.
    static func loadDropped(_ providers: [NSItemProvider], imagesOnly: Bool) -> Task<[DroppedFile], Never> {
        let group = DispatchGroup()
        let collected = DropCollector(count: providers.count)
        for (index, provider) in providers.enumerated() {
            group.enter()
            loadDropped(provider, imagesOnly: imagesOnly, index: index) { file in
                collected.set(index, file)
                group.leave()
            }
        }
        return Task {
            await withCheckedContinuation { continuation in
                group.notify(queue: .main) { continuation.resume() }
            }
            return collected.files
        }
    }

    /// One item: the file itself when it's a file from Finder; otherwise its
    /// content (Files and Photos on iPad), preferring a web-ready type (Photos
    /// offers JPEG beside HEIC); else the file a file URL points at.
    private static func loadDropped(_ provider: NSItemProvider, imagesOnly: Bool, index: Int, done: @escaping @Sendable (DroppedFile?) -> Void) {
        let hasFileURL = provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
        #if os(macOS)
        if hasFileURL {
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                done(url.flatMap { copyDroppedFile($0, imagesOnly: imagesOnly) })
            }
            return
        }
        #endif
        let wanted: UTType = imagesOnly ? .image : .data
        // Real file types only: not links or private pasteboard flavors.
        let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
            .filter { $0.conforms(to: wanted) && !$0.conforms(to: .url) && !$0.isDynamic && $0.preferredFilenameExtension != nil }
        if let type = types.first(where: { !isHeif($0) }) ?? types.first {
            let name = provider.suggestedName
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                // The file is only there until this returns: copy it out now.
                done(url.flatMap { copyRepresentation($0, type: type, suggestedName: name, index: index) })
            }
            return
        }
        if hasFileURL {
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                done(url.flatMap { copyDroppedFile($0, imagesOnly: imagesOnly) })
            }
            return
        }
        done(nil)
    }

    /// A file representation, named after the item with the extension of
    /// the type it was read as ("Screenshot 10.30.45" gets ".png", and an
    /// "IMG_1.HEIC" read as JPEG becomes "IMG_1.jpg").
    private static func copyRepresentation(_ url: URL, type: UTType, suggestedName: String?, index: Int) -> DroppedFile? {
        let fileExtension = url.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "dat") : url.pathExtension
        var stem = suggestedName.flatMap { $0.isEmpty ? nil : $0 } ?? "dropped-\(Int(Date().timeIntervalSince1970))-\(index + 1)"
        let named = (stem as NSString).pathExtension
        if !named.isEmpty, let namedType = UTType(filenameExtension: named), !namedType.isDynamic {
            if namedType.conforms(to: type) || type.conforms(to: namedType) {
                stem = (stem as NSString).deletingPathExtension
                return copy(url, to: "\(stem).\(named)", type: type)
            }
            stem = (stem as NSString).deletingPathExtension
        }
        return copy(url, to: "\(stem).\(fileExtension)", type: type)
    }

    /// A file dropped by URL (Finder), when it's one this tab takes.
    private static func copyDroppedFile(_ url: URL, imagesOnly: Bool) -> DroppedFile? {
        let type = UTType(filenameExtension: url.pathExtension)
        if imagesOnly && type?.conforms(to: .image) != true { return nil }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return copy(url, to: url.lastPathComponent, type: type)
    }

    private static func copy(_ source: URL, to filename: String, type: UTType?) -> DroppedFile? {
        let destination = uniqueDestination(filename.replacingOccurrences(of: "/", with: "-"))
        do {
            try FileManager.default.copyItem(at: source, to: destination)
            return DroppedFile(path: destination.path, type: type)
        } catch {
            return nil
        }
    }

    private static func isHeif(_ type: UTType) -> Bool {
        type.conforms(to: .heic) || type.conforms(to: .heif)
    }

    /// A path for `filename` in a folder of its own, so a dropped file keeps
    /// its name (the import names the asset after it) even when another
    /// drop had the same one.
    private static func uniqueDestination(_ filename: String) -> URL {
        let folder = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent(filename)
    }

    /// A dropped file ready to import: HEIC becomes JPEG, as for Photos
    /// picks, with the original kept for its capture date.
    static func importable(_ file: DroppedFile, engine: Engine) async -> String {
        guard let type = file.type, isHeif(type) else { return file.path }
        let original = URL(fileURLWithPath: file.path)
        let converted = original.deletingPathExtension().appendingPathExtension("jpg")
        guard convertToJPEG(source: original, destination: converted) else { return file.path }
        try? await engine.run("media.rememberConverted", ["converted": .string(converted.path), "original": .string(file.path)])
        return converted.path
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

/// Dropped files as their loads finish, which may be on any thread.
private final class DropCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var slots: [PhotoImport.DroppedFile?]

    init(count: Int) {
        slots = Array(repeating: nil, count: count)
    }

    func set(_ index: Int, _ file: PhotoImport.DroppedFile?) {
        lock.lock()
        slots[index] = file
        lock.unlock()
    }

    /// In drop order.
    var files: [PhotoImport.DroppedFile] {
        lock.lock()
        defer { lock.unlock() }
        return slots.compactMap { $0 }
    }
}
