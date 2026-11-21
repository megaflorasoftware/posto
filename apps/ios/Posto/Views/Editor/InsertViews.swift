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
            .navigationBarTitleDisplayMode(.inline)
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
            .navigationBarTitleDisplayMode(.inline)
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
        /// The body text and the caret offset inside an existing block.
        case edit(String, Int)
    }

    let engine: Engine
    let mode: Mode
    /// The JSX, and the range it replaces when editing.
    let onFinish: (String, NSRange?) -> Void
    @State private var form: MetadataFormModel?
    @State private var error: String?
    @State private var name = "Component"

    private var isEditing: Bool {
        if case .edit = mode { return true }
        return false
    }

    var body: some View {
        Form {
            if let form {
                if form.fields.isEmpty {
                    Section {
                        Text("\(name) takes no props Posto can edit.").foregroundStyle(.secondary)
                    }
                } else if let state = form.formState() {
                    FieldSections(sink: form, state: state, fields: form.fields)
                }
            }
        }
        .overlay { if form == nil && error == nil { ProgressView() } }
        .navigationTitle(name)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                AsyncButton(isEditing ? "Save" : "Insert") {
                    do {
                        let result: JSONValue = try await engine.call("components.finish")
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
        .task {
            do {
                let view: ComponentFormView
                switch mode {
                case .insert(let component):
                    view = try await engine.call("components.open", [
                        "name": .string(component.name), "path": .string(component.path),
                    ])
                case .edit(let text, let offset):
                    view = try await engine.call("components.openAt", [
                        "text": .string(text), "offset": .number(Double(offset)),
                    ])
                }
                name = view.name
                form = MetadataFormModel(engine: engine, target: "component", fields: view.fields, values: view.values, errors: view.errors, dates: view.dates)
            } catch {
                self.error = error.localizedDescription
            }
        }
        .errorAlert($error)
    }
}
