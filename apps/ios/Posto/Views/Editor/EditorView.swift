import SwiftUI

/// The open file: its fields as a native form with the body below, or the
/// raw file in developer mode — the same structure as the Tauri editor.
struct EditorView: View {
    @Bindable var document: DocumentModel
    @State private var confirmingDelete = false
    @State private var controller = MarkdownEditorController()
    @State private var rawController = MarkdownEditorController()
    @State private var insertingMedia = false
    @State private var insertingComponent = false
    @State private var editingComponent: ComponentEdit?
    @State private var focusedBody = false

    var body: some View {
        let view = document.view
        Group {
            if view.tab == "raw" {
                MarkdownTextView(
                    text: document.rawText,
                    controller: rawController,
                    scrolls: true,
                    monospaced: true,
                    styled: false
                )
                .ignoresSafeArea(.container, edges: .bottom)
            } else {
                contentForm(view)
            }
        }
        .navigationTitle(view.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(view.name).font(.headline).lineLimit(1)
                    let state = saveStateLabel(view.saveState)
                    Label(state.text, systemImage: state.symbol)
                        .labelStyle(.titleAndIcon)
                        .font(.caption2)
                        .foregroundStyle(state.color)
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if view.tabs.contains("content") && view.tabs.contains("raw") {
                    Button {
                        Task { await document.setTab(view.tab == "raw" ? "content" : "raw") }
                    } label: {
                        Label(
                            view.tab == "raw" ? "Show Visual Editor" : "Show Raw File",
                            systemImage: view.tab == "raw" ? "doc.richtext" : "chevron.left.forwardslash.chevron.right"
                        )
                    }
                }
                Button(role: .destructive) {
                    confirmingDelete = true
                } label: {
                    Label("Delete \(view.name)", systemImage: "trash")
                }
            }
        }
        .confirmationDialog("Delete \(view.name)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete File", role: .destructive) {
                Task { await document.repo.deleteOpenFile() }
            }
        } message: {
            Text("This file will be permanently deleted.")
        }
        .sheet(isPresented: $insertingMedia) {
            BodyMediaPicker(repo: document.repo) { absolutePath, url, alt, kind in
                Task { await insertMedia(path: absolutePath, url: url, alt: alt, kind: kind) }
            }
        }
        .sheet(item: $editingComponent) { edit in
            NavigationStack {
                ComponentPropsView(engine: document.engine, mode: .edit(edit.text, edit.offset)) { snippet, range in
                    if let range { controller.replace(range: range, with: snippet) }
                    editingComponent = nil
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { editingComponent = nil } }
                }
            }
        }
        .sheet(isPresented: $insertingComponent) {
            ComponentPickerView(engine: document.engine) { snippet in
                controller.insert(snippet, asBlock: true)
            }
        }
        .navigationDestination(isPresented: $focusedBody) {
            MarkdownTextView(text: document.bodyText, controller: controller, scrolls: true)
                .navigationTitle(view.name)
                .navigationBarTitleDisplayMode(.inline)
                .ignoresSafeArea(.container, edges: .bottom)
        }
        .onAppear(perform: wireController)
        .onChange(of: view.body?.componentBlocks) { wireController() }
        .onDisappear { Task { await document.flush() } }
        .errorAlert($document.renameError)
    }

    private func wireController() {
        controller.onChange = { [document] text in document.bodyChanged(text) }
        rawController.onChange = { [document] text in document.rawChanged(text) }
        controller.onRequestImage = { insertingMedia = true }
        controller.onRequestComponent = { insertingComponent = true }
        controller.onRequestEditComponent = { text, offset in
            editingComponent = ComponentEdit(text: text, offset: offset)
        }
        controller.componentsEnabled = document.view.body?.componentBlocks == true
    }

    @ViewBuilder
    private func contentForm(_ view: DocumentView) -> some View {
        Form {
            if let configError = view.configError {
                Section {
                    NoticeRow(message: configError, systemImage: "exclamationmark.triangle.fill", tint: .orange)
                }
            }
            if let form = view.form {
                if form.parseError != nil {
                    Section {
                        NoticeRow(
                            message: "Form editing is unavailable: the frontmatter has a YAML syntax error. Fix it in the raw file view.",
                            systemImage: "exclamationmark.triangle.fill",
                            tint: .orange
                        )
                    }
                } else if form.missing == true {
                    Section {
                        NoticeRow(message: "This entry no longer exists in its data file.", systemImage: "questionmark.folder", tint: .orange)
                    }
                } else {
                    FieldSections(
                        sink: document,
                        state: form,
                        fields: form.fields,
                        document: document,
                        header: AnyView(FilenameRow(document: document))
                    )
                }
            } else {
                Section { FilenameRow(document: document) }
            }
            if let body = view.body {
                Section {
                    MarkdownTextView(
                        text: document.bodyText,
                        controller: controller,
                        styled: body.isMarkdown
                    )
                    .padding(.vertical, 6)
                } header: {
                    HStack {
                        Text("Body")
                        Spacer()
                        Button {
                            focusedBody = true
                        } label: {
                            Label("Focus", systemImage: "arrow.up.left.and.arrow.down.right")
                                .labelStyle(.iconOnly)
                        }
                        .accessibilityLabel("Edit body full screen")
                    }
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func insertMedia(path: String?, url: String?, alt: String, kind: String) async {
        var value = url
        if value == nil, let path { value = await document.bodyMediaValue(for: path) }
        guard let value else {
            document.renameError = "That file isn't inside a folder this document can reference."
            return
        }
        switch kind {
        case "image": controller.insert("![\(alt)](\(value))", asBlock: true)
        case "audio": controller.insert("<audio controls src=\"\(value)\"></audio>", asBlock: true)
        case "video": controller.insert("<video controls src=\"\(value)\"></video>", asBlock: true)
        default: controller.insert("[\(alt)](\(value))")
        }
    }
}

/// The filename as the first form row; read-only when a template controls
/// it, with a regenerate button for manual templates.
private struct FilenameRow: View {
    let document: DocumentModel
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        let filename = document.view.filename
        LabeledField(label: "Filename") {
            HStack {
                if filename.readOnly {
                    Text(filename.value)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } else {
                    TextField("Filename", text: $draft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(commit)
                        .onChange(of: focused) { _, isFocused in if !isFocused { commit() } }
                }
                if filename.refreshTemplate != nil {
                    Button {
                        Task { await document.refreshFilename() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Regenerate filename from template")
                }
            }
        }
        .onAppear { draft = filename.value }
        .onChange(of: filename.value) { _, next in if !focused { draft = next } }
    }

    private func commit() {
        let next = draft.trimmingCharacters(in: .whitespaces)
        let current = document.view.filename.value
        guard next != current else { return }
        guard !next.isEmpty, !next.contains("/"), next != ".", next != ".." else {
            draft = current
            return
        }
        Task {
            await document.rename(to: next)
            if document.renameError != nil { draft = document.view.filename.value }
        }
    }
}

/// The body and caret an "Edit Component" request started from.
private struct ComponentEdit: Identifiable {
    let id = UUID()
    let text: String
    let offset: Int
}
