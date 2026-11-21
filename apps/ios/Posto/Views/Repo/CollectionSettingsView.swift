import SwiftUI

/// Developer mode: a collection's `.posto` preferences.
struct CollectionSettingsView: View {
    let repo: RepoModel
    let collection: CollectionRef
    @Environment(\.dismiss) private var dismiss
    @State private var settings: CollectionSettings?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let binding = Binding($settings) {
                    Section {
                        TextField(binding.wrappedValue.name, text: binding.displayName)
                    } header: {
                        Text("Display name")
                    } footer: {
                        Text("Shown as the collection's heading.")
                    }
                    Section {
                        TextField("{fields.title}", text: binding.entryName)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.body.monospaced())
                    } header: {
                        Text("Entry label")
                    } footer: {
                        Text("Template over frontmatter for each entry's label.")
                    }
                    Section("Sorting") {
                        Picker("Sort entries by", selection: binding.sortBy) {
                            Text("File order").tag(String?.none)
                            ForEach(binding.wrappedValue.sortOptions) { option in
                                Text(option.label).tag(Optional(option.value))
                            }
                        }
                        if binding.wrappedValue.sortBy != nil {
                            Picker("Direction", selection: binding.sortDirection) {
                                Text("Descending").tag("desc")
                                Text("Ascending").tag("asc")
                            }
                        }
                    }
                    Section {
                        ForEach(binding.wrappedValue.fileNames, id: \.self) { name in
                            let pinned = binding.wrappedValue.pinned.contains(name)
                            Button {
                                if pinned {
                                    binding.wrappedValue.pinned.removeAll { $0 == name }
                                } else {
                                    binding.wrappedValue.pinned.append(name)
                                }
                            } label: {
                                HStack {
                                    Text(name).foregroundStyle(.primary)
                                    Spacer()
                                    if let index = binding.wrappedValue.pinned.firstIndex(of: name) {
                                        Label("\(index + 1)", systemImage: "pin.fill").labelStyle(.titleAndIcon).foregroundStyle(.tint)
                                    }
                                }
                            }
                        }
                    } header: {
                        Text("Pinned files")
                    } footer: {
                        Text("Kept at the top, in the order you pin them.")
                    }
                }
            }
            .overlay { if settings == nil { ProgressView() } }
            .navigationTitle("\(collection.label) Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton("Save") { await save() }
                        .disabled(settings == nil)
                }
            }
            .task {
                do {
                    settings = try await repo.engine.call("collections.settings", ["name": .string(collection.name)])
                } catch {
                    self.error = error.localizedDescription
                }
            }
            .errorAlert($error)
        }
    }

    private func save() async {
        guard let settings else { return }
        do {
            try await repo.engine.run("collections.save", [
                "name": .string(settings.name),
                "displayName": .string(settings.displayName),
                "entryName": .string(settings.entryName),
                "sortBy": JSONValue(settings.sortBy),
                "sortDirection": .string(settings.sortDirection),
                "pinned": .array(settings.pinned.map(JSONValue.string)),
            ])
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Developer mode: the order collections appear in the sidebar.
struct CollectionOrderView: View {
    let repo: RepoModel
    @Environment(\.dismiss) private var dismiss
    @State private var order: [CollectionRef] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                ForEach(order) { collection in
                    Text(collection.label)
                }
                .onMove { order.move(fromOffsets: $0, toOffset: $1) }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Collection Order")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton("Save") {
                        do {
                            try await repo.engine.run("collections.saveOrder", ["order": .array(order.map { .string($0.name) })])
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
            }
            .task { order = (try? await repo.engine.call("collections.order")) ?? [] }
            .errorAlert($error)
        }
    }
}
