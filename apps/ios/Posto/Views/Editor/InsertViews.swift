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
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
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
                    ComponentPropsView(engine: engine, component: component) { snippet in
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
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
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

private struct ComponentPropsView: View {
    let engine: Engine
    let component: ComponentRef
    let onInsert: (String) -> Void
    @State private var form: MetadataFormModel?
    @State private var error: String?

    var body: some View {
        Form {
            if let form {
                if form.fields.isEmpty {
                    Section {
                        Text("\(component.name) takes no props Posto can edit.").foregroundStyle(.secondary)
                    }
                } else if let state = form.formState() {
                    FieldSections(sink: form, state: state, fields: form.fields)
                }
            }
        }
        .overlay { if form == nil { ProgressView() } }
        .navigationTitle(component.name)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                AsyncButton("Insert") {
                    do {
                        let result: JSONValue = try await engine.call("components.finish")
                        if let snippet = result["snippet"]?.stringValue { onInsert(snippet) }
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
                .disabled(form?.valid != true)
            }
        }
        .task {
            do {
                let view: ComponentFormView = try await engine.call("components.open", [
                    "name": .string(component.name), "path": .string(component.path),
                ])
                form = MetadataFormModel(engine: engine, target: "component", fields: view.fields, values: view.values, errors: view.errors, dates: view.dates)
            } catch {
                self.error = error.localizedDescription
            }
        }
        .errorAlert($error)
    }
}
