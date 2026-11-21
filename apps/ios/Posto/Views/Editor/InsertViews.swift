import SwiftUI

/// Picks media to insert into the body: library images, `src` images, or
/// `public` files — the rich-text editor's media dialog.
struct BodyMediaPicker: View {
    let repo: RepoModel
    /// (local path, remote URL, alt text, kind)
    let onPick: (String?, String?, String, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var media: MediaModel?

    var body: some View {
        NavigationStack {
            Group {
                if let media {
                    MediaBrowser(media: media, mode: .pick { item in
                        let alt = (item.name as NSString).deletingPathExtension
                        onPick(item.imagePath, item.imagePath == nil ? item.imageUrl : nil, alt, item.kind)
                        dismiss()
                    })
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Insert Media")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
            }
        }
        .task {
            let model = MediaModel(repo: repo)
            media = model
            await model.start()
        }
    }
}

/// Lists the project's components, then collects props for the chosen one.
struct ComponentPickerView: View {
    let engine: Engine
    let onInsert: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var list: ComponentList?
    @State private var query = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            let shown = (list?.components ?? []).filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
            List(shown) { component in
                NavigationLink {
                    ComponentPropsView(engine: engine, mode: .insert(component)) { snippet, _ in
                        onInsert(snippet)
                        dismiss()
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(component.name)
                        Text(component.relativePath).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .overlay {
                if list == nil {
                    ProgressView()
                } else if list?.components.isEmpty == true {
                    ContentUnavailableView(
                        "No components found",
                        systemImage: "square.on.square.dashed",
                        description: Text("Components in \(list?.directories.joined(separator: " or ") ?? "the components folder") appear here.")
                    )
                } else if shown.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .searchable(text: $query)
            .navigationTitle("Insert Component")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
            }
            .task {
                do {
                    list = try await engine.call("components.list")
                } catch {
                    self.error = error.localizedDescription
                    list = ComponentList(components: [], directories: [])
                }
            }
            .errorAlert($error)
        }
    }
}

struct ComponentPropsView: View {
    enum Mode {
        case insert(ComponentRef)
        /// The body text, the caret offset, and (for a tapped card or pill)
        /// exactly where the component starts.
        case edit(String, Int, Int?)
    }

    /// The component's markdown, to edit as text or delete it.
    struct SourceActions {
        let text: String
        let save: (String) -> Void
        let delete: () -> Void
    }

    let engine: Engine
    let mode: Mode
    var source: SourceActions?
    /// The JSX, and the range it replaces when editing.
    let onFinish: (String, NSRange?) -> Void
    @State private var form: MetadataFormModel?
    @State private var slots: [SlotText] = []
    @State private var error: String?
    /// Why the props can't be edited as a form (the source still can be).
    @State private var unsupported: String?
    @State private var name = "Component"
    @State private var confirmingDelete = false

    private var isEditing: Bool {
        if case .edit = mode { return true }
        return false
    }

    var body: some View {
        Form {
            if let unsupported {
                Section {
                    NoticeRow(message: unsupported, systemImage: "exclamationmark.triangle.fill", tint: .orange)
                }
            } else if let form {
                if form.fields.isEmpty {
                    Section {
                        Text("\(name) takes no props Posto can edit.").foregroundStyle(.secondary)
                    }
                } else if let state = form.formState() {
                    FieldSections(sink: form, state: state, fields: form.fields)
                }
            }
            // Children, one text per slot, as the desktop children fields.
            ForEach(slots.indices, id: \.self) { index in
                Section(slots[index].name.map { "Slot: \($0)" } ?? "Children") {
                    TextField("Markdown", text: $slots[index].text, axis: .vertical)
                        .lineLimit(2...12)
                        .autocorrectionDisabled(false)
                }
            }
            if let source {
                Section {
                    NavigationLink {
                        EmbedSourceView(title: name, text: source.text, deleteTitle: "Delete Component", onSave: source.save)
                    } label: {
                        Label("Edit Source", systemImage: "chevron.left.forwardslash.chevron.right")
                    }
                    Button("Delete Component", role: .destructive) { confirmingDelete = true }
                }
            }
        }
        .overlay { if form == nil && error == nil && unsupported == nil { ProgressView() } }
        .navigationTitle(name)
        .inlineNavigationTitle()
        .toolbar {
            if unsupported == nil {
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton(isEditing ? "Save" : "Insert") {
                        do {
                            let args: [String: JSONValue] = slots.isEmpty ? [:] : ["slots": try JSONValue(encoding: slots)]
                            let result: JSONValue = try await engine.call("components.finish", args)
                            let range = result["range"]?.arrayValue.flatMap { bounds -> NSRange? in
                                guard bounds.count == 2, let start = bounds[0].doubleValue, let end = bounds[1].doubleValue else { return nil }
                                return NSRange(location: Int(start), length: Int(end - start))
                            }
                            if let snippet = result["snippet"]?.stringValue { onFinish(snippet, range) }
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                    .disabled(form?.valid != true)
                }
            }
        }
        .confirmationDialog("Delete \(name)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete Component", role: .destructive) { source?.delete() }
        }
        .task {
            do {
                let view: ComponentFormView
                switch mode {
                case .insert(let component):
                    view = try await engine.call("components.open", [
                        "name": .string(component.name), "path": .string(component.path),
                    ])
                case .edit(let text, let offset, let start):
                    var args: [String: JSONValue] = ["text": .string(text), "offset": .number(Double(offset))]
                    if let start { args["start"] = .number(Double(start)) }
                    view = try await engine.call("components.openAt", args)
                }
                name = view.name
                slots = view.slotTexts ?? []
                form = MetadataFormModel(engine: engine, target: "component", fields: view.fields, values: view.values, errors: view.errors, dates: view.dates)
            } catch {
                // A tapped card whose props the form can't hold still edits as source.
                if isEditing && source != nil {
                    unsupported = error.localizedDescription
                } else {
                    self.error = error.localizedDescription
                }
            }
        }
        .errorAlert($error)
    }
}

/// A component's children for one slot (`name` nil for the default slot).
struct SlotText: Codable, Sendable, Hashable {
    var name: String?
    var text: String

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        // Explicit null: the engine tells the default slot apart by it.
        try container.encode(name, forKey: .name)
        try container.encode(text, forKey: .text)
    }
}
