import SwiftUI

/// A tapped card or pill: what it is, the markdown it stands for, and where
/// that markdown sits in the body.
struct EmbedEdit: Identifiable {
    let id = UUID()
    let embed: BodyEmbed
    let source: String
    let range: NSRange

    var kindName: String { embed.kindName }
}

/// A card's markdown, edited as text: HTML, imports and raw MDX (as the
/// desktop chips do), or a component whose props don't fit a form.
struct EmbedSourceView: View {
    let title: String
    let text: String
    var deleteTitle = "Delete"
    /// The new source; empty deletes the card.
    let onSave: (String) -> Void
    @State private var draft = ""
    @State private var confirmingDelete = false

    var body: some View {
        Form {
            Section {
                TextEditor(text: $draft)
                    .font(.system(.callout, design: .monospaced))
                    .frame(minHeight: 180)
                    .autocorrectionDisabled()
                    .noAutocapitalization()
            } footer: {
                Text("Saved into the body exactly as written.")
            }
            Section {
                Button(deleteTitle, role: .destructive) { confirmingDelete = true }
            }
        }
        .navigationTitle(title)
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { onSave(draft) }
                    .disabled(draft == text)
            }
        }
        .confirmationDialog("\(deleteTitle)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button(deleteTitle, role: .destructive) { onSave("") }
        }
        .onAppear { draft = text }
    }
}

/// The image-library entry a body image shows (`body.imageAsset`).
private struct BodyLibraryAsset: Decodable {
    let library: String
    let asset: LibraryAsset
}

/// A library entry open in the asset editor.
private struct LibraryAssetEdit: Identifiable {
    let media: MediaModel
    let item: MediaItem
    var id: String { item.id }
}

/// An image in the body: its preview, alt text and source, a replacement
/// from the media libraries, or the raw markdown. An image from an image
/// library also opens the library's editor (metadata, rename, delete), as
/// on desktop.
struct EmbedImageView: View {
    let document: DocumentModel
    let card: EmbedEdit
    /// The image's new markdown; empty removes it.
    let onSave: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var alt = ""
    @State private var src = ""
    @State private var pickedPath: String?
    @State private var replacing = false
    @State private var confirmingRemove = false
    @State private var libraryAsset: BodyLibraryAsset?
    @State private var editingLibraryAsset: LibraryAssetEdit?
    /// Set once the library's editor has been open: its changes (a new alt
    /// text, a rename) rewrite the body, and this card with it.
    @State private var libraryRevision: Int?

    var body: some View {
        Form {
            Section {
                preview
                    .frame(maxWidth: .infinity)
                    .frame(height: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .listRowInsets(EdgeInsets())
            }
            Section("Alt text") {
                TextField("Describe the image", text: $alt, axis: .vertical)
                    .lineLimit(1...4)
                    .placeholderOnly()
            }
            Section("Source") {
                TextField("Path or URL", text: $src)
                    .placeholderOnly()
                    .font(.system(.callout, design: .monospaced))
                    .autocorrectionDisabled()
                    .noAutocapitalization()
            }
            if let libraryAsset {
                Section {
                    Button {
                        Task { await editInLibrary(libraryAsset) }
                    } label: {
                        Label("Edit Library Image…", systemImage: "photo.stack")
                    }
                } footer: {
                    Text("\(libraryAsset.asset.entryId) in the \(libraryAsset.library) library: its alt text and details. Renaming it updates every document that uses it.")
                }
            }
            Section {
                Button {
                    replacing = true
                } label: {
                    Label("Replace Image…", systemImage: "photo.on.rectangle")
                }
                NavigationLink {
                    EmbedSourceView(title: "Markdown", text: card.source, deleteTitle: "Remove Image", onSave: onSave)
                } label: {
                    Label("Edit Markdown", systemImage: "chevron.left.forwardslash.chevron.right")
                }
            }
            Section {
                Button("Remove Image", role: .destructive) { confirmingRemove = true }
            }
        }
        .navigationTitle("Image")
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { onSave(markdown) }
                    .disabled(!changed || src.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .sheet(isPresented: $replacing) {
            Group {
                BodyMediaPicker(repo: document.repo, title: "Replace Image", imagesOnly: true) { pick in
                    Task {
                        if let url = pick.url {
                            src = url
                            pickedPath = nil
                        } else if let path = pick.path, let value = await document.bodyMediaValue(for: path) {
                            src = value
                            pickedPath = path
                        }
                        if alt.isEmpty { alt = pick.defaultAlt }
                    }
                }
            }
            .macSheetSizing()
        }
        .sheet(item: $editingLibraryAsset, onDismiss: libraryEditorClosed) { edit in
            Group {
                AssetEditorSheet(media: edit.media, item: edit.item)
            }
            .macSheetSizing()
        }
        .confirmationDialog("Remove this image?", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remove Image", role: .destructive) { onSave("") }
        }
        // The library's edit reached the body (it reloads as its references
        // are rewritten): this card's source is out of date.
        .onChange(of: document.view.revision) { _, revision in
            if let libraryRevision, revision != libraryRevision, editingLibraryAsset == nil { dismiss() }
        }
        .onAppear {
            alt = card.embed.alt ?? ""
            src = card.embed.src ?? ""
        }
        .task {
            guard let src = card.embed.src, !src.isEmpty else { return }
            libraryAsset = try? await document.engine.call("body.imageAsset", ["src": .string(src)])
        }
    }

    /// Opens the library's editor for this image, as an image-library
    /// reference field does; the body's pending text is saved first, since
    /// a rename rewrites it on disk.
    private func editInLibrary(_ found: BodyLibraryAsset) async {
        await document.flush()
        let media = MediaModel(repo: document.repo)
        media.selectTabWithoutLoading(found.library)
        libraryRevision = document.view.revision
        let asset = found.asset
        editingLibraryAsset = LibraryAssetEdit(
            media: media,
            item: MediaItem(id: asset.metadataPath, name: asset.name, imagePath: asset.imagePath, imageUrl: asset.imageUrl, kind: "image", problem: nil)
        )
    }

    private func libraryEditorClosed() {
        Task {
            await document.reload()
            if let libraryRevision, document.view.revision != libraryRevision { dismiss() }
        }
    }

    @ViewBuilder
    private var preview: some View {
        if let pickedPath {
            Thumbnail(path: pickedPath, maxPixels: 1200)
        } else if src == card.embed.src {
            Thumbnail(path: card.embed.image?.path, url: card.embed.image?.url, maxPixels: 1200)
        } else if src.hasPrefix("http") {
            Thumbnail(url: src, maxPixels: 1200)
        } else {
            Thumbnail(path: nil, maxPixels: 1200)
        }
    }

    private var changed: Bool {
        alt != (card.embed.alt ?? "") || src != (card.embed.src ?? "")
    }

    /// `![alt](src "title")` with the new alt text and source, keeping the
    /// original title, escaped as the engine writes inserted images.
    private var markdown: String {
        let source = card.source as NSString
        let pattern = try? NSRegularExpression(pattern: #"\s+("[^"\n]*"|'[^'\n]*')\s*\)$"#)
        let match = pattern?.firstMatch(in: card.source, range: NSRange(location: 0, length: source.length))
        let title = match.map { " " + source.substring(with: $0.range(at: 1)) } ?? ""
        let trimmed = src.trimmingCharacters(in: .whitespaces)
        let target = trimmed.rangeOfCharacter(from: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "()<>"))) != nil
            ? "<\(trimmed.replacingOccurrences(of: "<", with: "%3C").replacingOccurrences(of: ">", with: "%3E"))>"
            : trimmed
        let text = alt
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
            .components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
        return "![\(text)](\(target)\(title))"
    }
}
