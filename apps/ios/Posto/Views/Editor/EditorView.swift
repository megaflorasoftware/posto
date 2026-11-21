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
    /// The component picker opened with the cursor inside text.
    @State private var insertingInline = false
    @State private var editingComponent: ComponentEdit?
    @State private var editingEmbed: EmbedEdit?
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
        .editorTitle(view.name, saveState: view.saveState)
        .inlineNavigationTitle()
        // Delete gets a glass group of its own, apart from the view toggle.
        .toolbarGroups(.barTrailing, gap: .fixed, split: view.tabs.contains("content") && view.tabs.contains("raw")) {
            Button {
                Task { await document.setTab(view.tab == "raw" ? "content" : "raw") }
            } label: {
                Label(
                    view.tab == "raw" ? "Show Visual Editor" : "Show Raw File",
                    systemImage: view.tab == "raw" ? "doc.richtext" : "chevron.left.forwardslash.chevron.right"
                )
            }
        } then: {
            Button(role: .destructive) {
                confirmingDelete = true
            } label: {
                Label("Delete \(view.name)", systemImage: "trash")
            }
        }
        .confirmationDialog("Delete \(view.name)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete File", role: .destructive) {
                Task { await document.repo.deleteOpenFile() }
            }
        } message: {
            Text("This file will be permanently deleted.")
        }
        // Each of the editor's sheets gives the body its keyboard back when
        // it closes, if the body was being edited (endEditing below).
        .sheet(isPresented: $insertingMedia, onDismiss: controller.resumeEditing) {
            Group {
                BodyMediaPicker(repo: document.repo) { pick in
                    Task { await insertMedia(pick) }
                }
            }
            .macSheetSizing()
        }
        .sheet(item: $editingComponent, onDismiss: controller.resumeEditing) { edit in
            Group {
                NavigationStack {
                    ComponentPropsView(
                        engine: document.engine,
                        mode: .edit(edit.text, edit.offset, edit.start),
                        source: edit.card.map { card in
                            ComponentPropsView.SourceActions(
                                text: card.source,
                                save: { replaceEmbed(card, with: $0); editingComponent = nil },
                                delete: { replaceEmbed(card, with: ""); editingComponent = nil }
                            )
                        },
                        document: document
                    ) { snippet, range in
                        if let range {
                            let opened = edit.text as NSString
                            let original = NSMaxRange(range) <= opened.length ? opened.substring(with: range) : nil
                            if !controller.replaceSource(range, with: snippet, expecting: original) { embedChangedUnderneath() }
                        }
                        editingComponent = nil
                    }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { CloseButton { editingComponent = nil } }
                    }
                }
            }
            .macSheetSizing()
        }
        .sheet(item: $editingEmbed, onDismiss: controller.resumeEditing) { card in
            Group {
                NavigationStack {
                    Group {
                        if card.embed.kind == "image" {
                            EmbedImageView(document: document, card: card) { replaceEmbed(card, with: $0); editingEmbed = nil }
                        } else {
                            EmbedSourceView(title: card.embed.label, text: card.source, deleteTitle: "Delete \(card.kindName)") { next in
                                replaceEmbed(card, with: next)
                                editingEmbed = nil
                            }
                        }
                    }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { CloseButton { editingEmbed = nil } }
                    }
                }
                .presentationDetents(card.embed.kind == "image" ? [.large] : [.medium, .large])
            }
            .macSheetSizing()
        }
        .sheet(isPresented: $insertingComponent, onDismiss: controller.resumeEditing) {
            Group {
                ComponentPickerView(
                    engine: document.engine,
                    document: document,
                    inline: insertingInline,
                    onInsertHtml: { controller.insertHtml() }
                ) { snippet in
                    // Inside text the component goes in inline, as on desktop.
                    controller.insert(snippet, asBlock: !insertingInline)
                }
            }
            .macSheetSizing()
        }
        .navigationDestination(isPresented: $focusedBody) {
            VStack(spacing: 0) {
                #if os(macOS)
                // macOS has no keyboard bar; the formatting commands sit on top.
                MarkdownFormatBar(controller: controller)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                Divider()
                #endif
                MarkdownTextView(text: document.bodyText, controller: controller, scrolls: true, embeds: view.body?.isMarkdown == true)
            }
            .navigationTitle(view.name)
            .inlineNavigationTitle()
            .ignoresSafeArea(.container, edges: .bottom)
        }
        #if DEBUG && os(iOS)
        .onReceive(NotificationCenter.default.publisher(for: DemoTour.focusBodyNotification)) { note in
            focusedBody = note.object as? Bool ?? false
        }
        #endif
        .onAppear(perform: wireController)
        .onChange(of: view.body?.componentBlocks) { wireController() }
        .onDisappear { Task { await document.flush() } }
        .errorAlert($document.renameError)
    }

    private func wireController() {
        controller.onChange = { [document] text in document.bodyChanged(text) }
        rawController.onChange = { [document] text in document.rawChanged(text) }
        // Each sheet ends editing first: a body that keeps focus behind a
        // sheet takes it back as a nested sheet (Photos, an import) closes,
        // and its keyboard bar then loops the sheet's layout. The caret is
        // kept, so inserts still land there.
        controller.onRequestImage = { [controller] in
            controller.endEditing()
            insertingMedia = true
        }
        controller.onRequestComponent = { [controller] in
            insertingInline = controller.caretInsideText
            controller.endEditing()
            insertingComponent = true
        }
        controller.onRequestEditComponent = { [controller] text, offset in
            controller.endEditing()
            editingComponent = ComponentEdit(text: text, offset: offset, start: nil, card: nil)
        }
        controller.componentsEnabled = document.view.body?.componentBlocks == true
        controller.onOpenEmbed = { [controller] attachment, source, range in
            controller.endEditing()
            let card = EmbedEdit(embed: attachment.embed, source: attachment.source, range: range)
            if attachment.embed.kind == "component" {
                editingComponent = ComponentEdit(text: source, offset: range.location, start: range.location, card: card)
            } else {
                editingEmbed = card
            }
        }
        if controller.loadEmbeds == nil {
            controller.loadEmbeds = { [document] text in
                try? await document.engine.call("body.embeds", ["text": .string(text)], as: [BodyEmbed].self)
            }
        }
    }

    /// Writes a card's new source (empty to delete it) back into the body,
    /// unless the body changed underneath while its sheet was open.
    private func replaceEmbed(_ card: EmbedEdit, with source: String) {
        if !controller.replaceSource(card.range, with: source, expecting: card.source) { embedChangedUnderneath() }
    }

    private func embedChangedUnderneath() {
        document.renameError = "The body changed while this was open (it was reloaded from disk), so the edit wasn't applied. Open it again to edit the current version."
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
                if let message = view.formUnavailableMessage {
                    Section {
                        NoticeRow(message: message, systemImage: "exclamationmark.triangle.fill", tint: .orange)
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
                    #if os(macOS)
                    if body.isMarkdown { MarkdownFormatBar(controller: controller) }
                    #endif
                    MarkdownTextView(
                        text: document.bodyText,
                        controller: controller,
                        styled: body.isMarkdown,
                        embeds: body.isMarkdown
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

    /// Inserts picked media as the desktop editor writes it (the engine's
    /// snippet: the path, escaping, and audio and video as HTML). Images and
    /// players stand as blocks; other files are links in the text.
    private func insertMedia(_ pick: BodyMediaPick) async {
        do {
            let result: JSONValue = try await document.engine.call("doc.bodyMediaSnippet", pick.snippetArgs)
            guard let snippet = result["snippet"]?.stringValue else { return }
            controller.insert(snippet, asBlock: result["kind"]?.stringValue != "link")
        } catch {
            document.renameError = error.localizedDescription
        }
    }
}

/// The filename as the first form row; read-only when a template controls
/// it, with a regenerate button for manual templates.
private struct FilenameRow: View {
    let document: DocumentModel
    @State private var draft = ""
    @FocusState private var focused: Bool
    @State private var editingTemplate = false

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
                        .placeholderOnly()
                        .noAutocapitalization()
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
        .contextMenu {
            if document.repo.app.developerMode, !document.view.isData, document.view.collectionLabel != nil {
                Button {
                    editingTemplate = true
                } label: {
                    Label("Filename Template…", systemImage: "wand.and.stars")
                }
            }
        }
        .sheet(isPresented: $editingTemplate) {
            Group {
                FieldTemplateSheet(
                    document: document,
                    fieldName: "filename",
                    label: "Filename",
                    current: filename.template.map { FieldTemplate(template: $0, controlled: filename.controlled, rows: nil) }
                )
            }
            .macSheetSizing()
        }
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
    /// Exactly where the component starts, when a card or pill was tapped.
    let start: Int?
    let card: EmbedEdit?
}
