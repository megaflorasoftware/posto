import SwiftUI

/// A tapped card or pill: what it is, the markdown it stands for, and where
/// that markdown sits in the body.
struct EmbedEdit: Identifiable {
    let id = UUID()
    let embed: BodyEmbed
    let source: String
    let range: NSRange

    var kindName: String {
        switch embed.kind {
        case "component": return "Component"
        case "import": return "Import"
        case "raw": return embed.label
        case "html": return "HTML"
        default: return "Image"
        }
    }
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

/// An image in the body: its preview, alt text and source, a replacement
/// from the media libraries, or the raw markdown.
struct EmbedImageView: View {
    let document: DocumentModel
    let card: EmbedEdit
    /// The image's new markdown; empty removes it.
    let onSave: (String) -> Void
    @State private var alt = ""
    @State private var src = ""
    @State private var pickedPath: String?
    @State private var replacing = false
    @State private var confirmingRemove = false

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
            }
            Section("Source") {
                TextField("Path or URL", text: $src)
                    .font(.system(.callout, design: .monospaced))
                    .autocorrectionDisabled()
                    .noAutocapitalization()
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
                BodyMediaPicker(repo: document.repo) { path, url, pickedAlt, _ in
                    Task {
                        if let url {
                            src = url
                            pickedPath = nil
                        } else if let path, let value = await document.bodyMediaValue(for: path) {
                            src = value
                            pickedPath = path
                        }
                        if alt.isEmpty { alt = pickedAlt }
                    }
                }
            }
            .macSheetSizing()
        }
        .confirmationDialog("Remove this image?", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remove Image", role: .destructive) { onSave("") }
        }
        .onAppear {
            alt = card.embed.alt ?? ""
            src = card.embed.src ?? ""
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
    /// original title.
    private var markdown: String {
        let source = card.source as NSString
        let pattern = try? NSRegularExpression(pattern: #"\s+("[^"\n]*"|'[^'\n]*')\s*\)$"#)
        let match = pattern?.firstMatch(in: card.source, range: NSRange(location: 0, length: source.length))
        let title = match.map { " " + source.substring(with: $0.range(at: 1)) } ?? ""
        let trimmed = src.trimmingCharacters(in: .whitespaces)
        let target = trimmed.contains(" ") ? "<\(trimmed)>" : trimmed
        let text = alt.replacingOccurrences(of: "]", with: "\\]").replacingOccurrences(of: "\n", with: " ")
        return "![\(text)](\(target)\(title))"
    }
}
