import SwiftUI

/// Renders schema fields as native form sections. Simple fields share one
/// section; objects and lists get their own, and object-list items drill
/// into a page of their own, like Settings.
struct FieldSections: View {
    let sink: any FormSink
    let state: FormState
    let fields: [FieldView]
    var base: [PathKey] = []
    var document: DocumentModel?
    var header: AnyView?

    var body: some View {
        let visible = fields.filter { !$0.hidden }
        let simple = visible.filter { !$0.list && $0.type != "object" }
        let grouped = visible.filter { $0.list || $0.type == "object" }
        if !simple.isEmpty || header != nil {
            Section {
                if let header { header }
                ForEach(simple) { field in
                    FieldRow(sink: sink, state: state, field: field, path: base + [.key(field.name)], document: document)
                }
            }
        }
        ForEach(grouped) { field in
            let path = base + [.key(field.name)]
            if field.list {
                ListFieldSection(sink: sink, state: state, field: field, path: path, document: document)
            } else {
                Section {
                    NestedFields(sink: sink, state: state, fields: field.fields, base: path, document: document)
                } header: {
                    Text(field.displayLabel)
                } footer: {
                    FieldFooter(field: field, error: state.errors[path.dotted])
                }
            }
        }
    }
}

/// Fields inside an object section: nested objects collapse into groups.
struct NestedFields: View {
    let sink: any FormSink
    let state: FormState
    let fields: [FieldView]
    let base: [PathKey]
    var document: DocumentModel?

    var body: some View {
        ForEach(fields.filter { !$0.hidden }) { field in
            let path = base + [.key(field.name)]
            if field.list {
                NavigationLink {
                    LiveFormState(sink: sink) { live in
                        Form {
                            ListFieldSection(sink: sink, state: live, field: field, path: path, document: document)
                        }
                    }
                    .navigationTitle(field.label)
                } label: {
                    LabeledContent(field.displayLabel, value: "\(state.values.value(at: path)?.arrayValue?.count ?? 0) items")
                }
            } else if field.type == "object" {
                DisclosureGroup(field.displayLabel) {
                    NestedFields(sink: sink, state: state, fields: field.fields, base: path, document: document)
                }
            } else {
                FieldRow(sink: sink, state: state, field: field, path: path, document: document)
            }
        }
    }
}

extension DocumentView {
    /// Why the form can't edit the file, with the parser's own message: a
    /// data file's as is (as the desktop data form shows it), frontmatter's
    /// as a YAML error. The raw view is pointed at only where there is one
    /// (developer mode).
    var formUnavailableMessage: String? {
        guard let error = form?.parseError?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        if isData { return "Form editing is unavailable: \(error)" }
        let fix = tabs.contains("raw") ? " Fix it in the raw file view." : ""
        return "Form editing is unavailable: the frontmatter has a YAML syntax error.\(fix)\n\n\(error)"
    }
}

struct FieldFooter: View {
    let field: FieldView
    let error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let error { Text(error).foregroundStyle(.red) }
            if let description = field.description, !description.isEmpty { Text(description) }
        }
    }
}

/// One scalar field.
struct FieldRow: View {
    let sink: any FormSink
    let state: FormState
    let field: FieldView
    let path: [PathKey]
    var document: DocumentModel?
    /// List items render without their label (the section names them).
    var showLabel = true

    private var value: JSONValue? { state.values.value(at: path) }
    private var error: String? { state.errors[path.dotted] }

    @State private var editingTemplate = false
    @State private var editingRows = false

    /// Developer mode: fields of collection entries (data collections' too,
    /// as on desktop) can carry `.posto` templates and row counts.
    private var templatable: Bool {
        guard let document, sink.formTarget == "document", showLabel, document.repo.app.developerMode,
              document.view.collectionLabel != nil
        else { return false }
        return !path.contains { if case .index = $0 { return true } else { return false } }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            control
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if showLabel, let description = field.description, !description.isEmpty, field.type != "boolean" {
                Text(description).font(.caption).foregroundStyle(.secondary)
            }
            if templatable, let template = field.template?.template {
                Label(template, systemImage: field.controlled ? "lock" : "wand.and.stars")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .contextMenu {
            if templatable {
                Button {
                    editingTemplate = true
                } label: {
                    Label("Template…", systemImage: "wand.and.stars")
                }
                if field.type == "string" {
                    Button {
                        editingRows = true
                    } label: {
                        Label("Rows…", systemImage: "text.alignleft")
                    }
                }
            }
        }
        .sheet(isPresented: $editingTemplate) {
            Group {
                if let document {
                    FieldTemplateSheet(document: document, fieldName: field.schemaPath, label: field.label, current: field.template)
                }
            }
            .macSheetSizing()
        }
        .sheet(isPresented: $editingRows) {
            Group {
                if let document {
                    FieldRowsSheet(document: document, fieldName: field.schemaPath, label: field.label, current: field.template)
                }
            }
            .macSheetSizing()
        }
    }

    private var label: String { showLabel && field.showLabel ? field.displayLabel : "" }

    @ViewBuilder
    private var control: some View {
        switch field.type {
        case "boolean":
            Toggle(isOn: Binding(
                get: { value?.boolValue ?? false },
                set: { newValue in Task { await sink.edit(path, .bool(newValue)) } }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label.isEmpty ? field.label : label)
                    if let description = field.description, !description.isEmpty {
                        Text(description).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        case "number":
            LabeledField(label: label) {
                BufferedTextField(
                    placeholder: field.label,
                    source: value?.stringValue ?? "",
                    disabled: field.locked,
                    finalize: clampNumber
                ) { text in
                    let trimmed = text.trimmingCharacters(in: .whitespaces)
                    if trimmed.isEmpty { return nil }
                    return Double(trimmed).map(JSONValue.number) ?? .string(trimmed)
                } commit: { next in
                    await sink.edit(path, next)
                }
                .decimalKeyboard()
            }
        case "date":
            DateFieldRow(sink: sink, field: field, path: path, value: value, control: state.dates[path.dotted], label: label)
        case "select":
            SelectFieldRow(sink: sink, field: field, path: path, value: value?.stringValue ?? "", title: label.isEmpty ? field.label : label)
        case "image":
            if sink.picksImages, let document {
                ImageFieldRow(sink: sink, repo: document.repo, field: field, path: path, value: value?.stringValue ?? "", label: label)
            } else {
                textControl(lines: nil)
            }
        case "reference":
            // In the document's fields, a component's props (whose
            // `CollectionEntry<'media'>['id']` props are image-library
            // references) and a new referenced entry, as on desktop.
            if sink.picksImages, let document {
                ReferenceFieldRow(sink: sink, document: document, field: field, path: path, value: value?.stringValue ?? "", label: label)
            } else {
                textControl(lines: nil)
            }
        case "string":
            // The row count from developer settings, as the desktop textarea
            // shows it; longer text grows the field up to a dozen lines.
            let rows = field.template?.rows ?? 1
            textControl(lines: rows > 1 ? rows...max(rows, 12) : nil)
        default:
            textControl(lines: 3...12)
        }
    }

    /// A number outside the field's min/max is brought into range when
    /// editing ends, as the desktop number input clamps on blur.
    private func clampNumber(_ text: String) -> String? {
        guard field.numberMin != nil || field.numberMax != nil,
              let number = Double(text.trimmingCharacters(in: .whitespaces))
        else { return nil }
        var clamped = number
        if let lower = field.numberMin { clamped = max(clamped, lower) }
        if let upper = field.numberMax { clamped = min(clamped, upper) }
        return clamped == number ? nil : JSONValue.number(clamped).stringValue
    }

    /// Single-line without `lines`; else a field showing that many lines.
    private func textControl(lines: ClosedRange<Int>?) -> some View {
        LabeledField(label: label) {
            HStack(alignment: .top) {
                BufferedTextField(
                    placeholder: field.label,
                    source: value?.stringValue ?? "",
                    lines: lines,
                    disabled: field.disabled
                ) { text in
                    text.isEmpty ? nil : .string(text)
                } commit: { next in
                    await sink.edit(path, next)
                }
                if let template = field.template, template.template != nil, !template.controlled, sink.formTarget == "document" {
                    Button {
                        Task { await sink.regenerate(path) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Regenerate \(field.label) from its template")
                }
                if field.chooseImage, sink.picksImages, let document {
                    ImageChooserButton(sink: sink, repo: document.repo, path: path, value: value?.stringValue ?? "") { picked in
                        Task { await sink.edit(path, picked.map(JSONValue.string)) }
                    }
                }
            }
        }
    }
}

/// The field's label above its control, as data-entry forms do.
struct LabeledField<Content: View>: View {
    let label: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !label.isEmpty {
                Text(label)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            content()
        }
    }
}

/// A text field that keeps the user's draft while focused and only follows
/// the engine's value when not editing, so round trips never fight typing.
struct BufferedTextField: View {
    let placeholder: String
    let source: String
    /// Multi-line, showing at least the lower bound of lines and growing to
    /// the upper; single-line when nil.
    var lines: ClosedRange<Int>? = nil
    var disabled = false
    /// Rewrites the text when editing ends (nil keeps it), committing the
    /// result: a number brought into its field's range.
    var finalize: ((String) -> String?)? = nil
    let parse: (String) -> JSONValue?
    let commit: (JSONValue?) async -> Void

    @State private var draft = ""
    @FocusState private var focused: Bool
    @State private var pending: Task<Void, Never>?

    var body: some View {
        Group {
            // The prompt keeps the placeholder on macOS, where the hidden
            // label would otherwise take it along.
            if let lines {
                TextField(placeholder, text: $draft, prompt: Text(placeholder), axis: .vertical)
                    .lineLimit(lines)
            } else {
                TextField(placeholder, text: $draft, prompt: Text(placeholder))
            }
        }
        .placeholderOnly()
        .focused($focused)
        .disabled(disabled)
        .foregroundStyle(disabled ? .secondary : .primary)
        .onAppear { draft = source }
        .onChange(of: source) { _, next in
            if !focused && pending == nil { draft = next }
        }
        .onChange(of: draft) { _, text in
            guard focused, text != source else { return }
            pending?.cancel()
            pending = Task {
                try? await Task.sleep(for: .milliseconds(150))
                guard !Task.isCancelled else { return }
                await commit(parse(text))
                pending = nil
            }
        }
        .onChange(of: focused) { _, isFocused in
            guard !isFocused else { return }
            if let next = finalize?(draft), next != draft {
                draft = next
                pending?.cancel()
                pending = Task {
                    await commit(parse(next))
                    pending = nil
                }
            } else if pending == nil {
                draft = source
            }
        }
    }
}

/// Date fields edit through a native picker; the engine writes the picked
/// date back in the document's own spelling. Values Posto can't read as a
/// date stay editable as text.
struct DateFieldRow: View {
    let sink: any FormSink
    let field: FieldView
    let path: [PathKey]
    let value: JSONValue?
    let control: DateControl?
    let label: String

    private var showsTime: Bool { field.dateTime || control?.hasTime == true }

    var body: some View {
        let raw = value?.stringValue ?? ""
        let controlValue = showsTime ? control?.dateTime : control?.date
        if !raw.isEmpty, controlValue?.isEmpty != false {
            LabeledField(label: label) {
                BufferedTextField(placeholder: field.label, source: raw, disabled: field.locked) { text in
                    text.isEmpty ? nil : .string(text)
                } commit: { next in
                    await sink.edit(path, next)
                }
            }
        } else if let date = controlValue.flatMap(Self.parse) {
            HStack {
                DatePicker(
                    label.isEmpty ? field.label : label,
                    selection: Binding(
                        get: { date },
                        set: { next in Task { await sink.editDate(path, control: Self.format(next, time: showsTime), time: showsTime) } }
                    ),
                    displayedComponents: showsTime ? [.date, .hourAndMinute] : [.date]
                )
                .disabled(field.locked)
                if !field.required && !field.locked {
                    Button {
                        Task { await sink.edit(path, nil) }
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Clear \(field.label)")
                }
            }
        } else {
            HStack {
                Text(label.isEmpty ? field.label : label)
                Spacer()
                Button("Add Date") {
                    Task { await sink.editDate(path, control: Self.format(Date(), time: showsTime), time: showsTime) }
                }
                .buttonStyle(.bordered)
                .disabled(field.locked)
            }
        }
    }

    /// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS]` as a local date.
    static func parse(_ control: String) -> Date? {
        let parts = control.split(separator: "T")
        let day = parts.first?.split(separator: "-").compactMap { Int($0) } ?? []
        guard day.count == 3 else { return nil }
        var components = DateComponents(year: day[0], month: day[1], day: day[2])
        if parts.count > 1 {
            let time = parts[1].split(separator: ":").compactMap { Int($0) }
            components.hour = time.first
            components.minute = time.count > 1 ? time[1] : 0
            components.second = time.count > 2 ? time[2] : 0
        } else {
            components.hour = 12
        }
        return Calendar.current.date(from: components)
    }

    static func format(_ date: Date, time: Bool) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let day = String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 1, c.day ?? 1)
        guard time else { return day }
        return day + String(format: "T%02d:%02d:%02d", c.hour ?? 0, c.minute ?? 0, c.second ?? 0)
    }
}

/// A list field: scalar items edit inline; object items drill into a page.
struct ListFieldSection: View {
    let sink: any FormSink
    let state: FormState
    let field: FieldView
    let path: [PathKey]
    var document: DocumentModel?
    @State private var creatingReference = false
    /// Entry titles for stored reference values, by reference field (see
    /// `labeledReferences`).
    @State private var referenceLabels: [String: [String: String]] = [:]

    var body: some View {
        let items = state.values.value(at: path)?.arrayValue ?? []
        let canRemove = items.count > (field.listMin ?? 0)
        let canAdd = field.listMax.map { items.count < $0 } ?? true
        let item = FieldView(
            name: field.name, type: field.type, label: field.label, showLabel: false,
            description: nil, required: false, hidden: false, list: false, listMin: nil, listMax: nil,
            schemaPath: field.schemaPath, fields: field.fields, locked: field.locked, template: nil,
            selectValues: field.selectValues, selectCount: field.selectCount,
            numberMin: field.numberMin, numberMax: field.numberMax,
            dateTime: field.dateTime, chooseImage: false, referenceCollection: field.referenceCollection,
            imageLibrary: field.imageLibrary, newItem: nil
        )
        Section {
            ForEach(Array(items.indices), id: \.self) { index in
                let itemPath = path + [.index(index)]
                Group {
                    if field.type == "object" {
                        NavigationLink {
                            LiveFormState(sink: sink) { live in
                                Form {
                                    NestedFields(sink: sink, state: live, fields: field.fields, base: itemPath, document: document)
                                }
                            }
                            .navigationTitle("\(field.label) \(index + 1)")
                        } label: {
                            ObjectItemSummary(
                                sink: sink, field: field, value: items[index], index: index, path: itemPath,
                                referenceLabels: referenceLabels
                            )
                        }
                    } else {
                        FieldRow(sink: sink, state: state, field: item, path: itemPath, document: document, showLabel: false)
                    }
                }
                .contextMenu {
                    if index > 0 {
                        Button { Task { await sink.listMove(path, from: index, to: index - 1) } } label: {
                            Label("Move Up", systemImage: "arrow.up")
                        }
                    }
                    if index < items.count - 1 {
                        Button { Task { await sink.listMove(path, from: index, to: index + 1) } } label: {
                            Label("Move Down", systemImage: "arrow.down")
                        }
                    }
                    if canRemove {
                        Button(role: .destructive) { Task { await sink.listRemove(path, index) } } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
                .swipeActions {
                    if canRemove {
                        Button(role: .destructive) { Task { await sink.listRemove(path, index) } } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
            }
            // Drags rows where the list allows it without edit mode (macOS);
            // on iOS, Reorder below and Move Up/Down reorder.
            .onMove { from, to in
                guard let source = from.first else { return }
                let destination = to > source ? to - 1 : to
                Task { await sink.listMove(path, from: source, to: destination) }
            }
            Button {
                Task { await sink.listAppend(path, field.newItem ?? .string("")) }
            } label: {
                Label("Add Item", systemImage: "plus")
            }
            .disabled(!canAdd)
            // On a row of its own: a section's modifiers can apply per row.
            .task(id: referenceValues(items)) { await loadReferenceLabels() }
            if items.count > 1 {
                NavigationLink {
                    ListReorderPage(sink: sink, field: field, path: path, referenceLabels: referenceLabels)
                } label: {
                    Label("Reorder", systemImage: "arrow.up.arrow.down")
                }
            }
            if field.type == "reference", field.imageLibrary == nil, sink.formTarget == "document", let document {
                Button {
                    creatingReference = true
                } label: {
                    Label("Create New Entry", systemImage: "plus.square.on.square")
                }
                .disabled(!canAdd)
                .sheet(isPresented: $creatingReference) {
                    Group {
                        ReferenceDraftSheet(document: document, path: path)
                    }
                    .macSheetSizing()
                }
            }
        } header: {
            Text(field.displayLabel)
        } footer: {
            FieldFooter(field: field, error: state.errors[path.dotted])
        }
    }

    /// The references whose rows show their entry's title rather than the
    /// stored value, keyed by child name: an object list's reference
    /// children, or ("") a reference list itself (for its reorder page).
    /// Image-library references keep their id, as on desktop.
    private var labeledReferences: [(name: String, path: [PathKey])] {
        guard sink.picksImages else { return [] }
        if field.type == "object" {
            return field.fields
                .filter { $0.type == "reference" && $0.imageLibrary == nil && !$0.list }
                .map { ($0.name, path + [.index(0), .key($0.name)]) }
        }
        return field.type == "reference" && field.imageLibrary == nil ? [("", path + [.index(0)])] : []
    }

    /// The stored reference values, so titles reload only when they change.
    private func referenceValues(_ items: [JSONValue]) -> [String] {
        labeledReferences.flatMap { reference in
            items.map { item in (reference.name.isEmpty ? item : item[reference.name])?.stringValue ?? "" }
        }
    }

    private func loadReferenceLabels() async {
        var labels: [String: [String: String]] = [:]
        for reference in labeledReferences {
            let options: ReferenceOptions? = try? await sink.engine.call("form.referenceOptions", [
                "form": .string(sink.formTarget), "path": reference.path.json,
            ])
            labels[reference.name] = Dictionary(
                (options?.options ?? []).map { ($0.value, $0.label) },
                uniquingKeysWith: { first, _ in first }
            )
        }
        referenceLabels = labels
    }
}

/// Reorders a list by dragging. iOS drags rows only in edit mode, which the
/// form can't enter without its links and controls going inert, so this
/// page is always editing (macOS drags list rows as they are).
struct ListReorderPage: View {
    let sink: any FormSink
    let field: FieldView
    let path: [PathKey]
    var referenceLabels: [String: [String: String]] = [:]
    /// The items as shown, moved at once while the engine catches up.
    @State private var rows: [Row] = []

    struct Row: Identifiable {
        let id = UUID()
        let value: JSONValue
    }

    var body: some View {
        LiveFormState(sink: sink) { state in
            let items = state.values.value(at: path)?.arrayValue ?? []
            List {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    summary(row.value, index: index)
                }
                .onMove(perform: move)
            }
            .alwaysEditing()
            .onAppear { sync(items) }
            .onChange(of: items) { _, next in sync(next) }
        }
        .navigationTitle("Reorder \(field.label)")
        .inlineNavigationTitle()
    }

    @ViewBuilder
    private func summary(_ value: JSONValue, index: Int) -> some View {
        if field.type == "object" {
            ObjectItemSummary(
                sink: sink, field: field, value: value, index: index, path: path + [.index(index)],
                referenceLabels: referenceLabels
            )
        } else {
            let text = value.displayString
            HStack(spacing: 12) {
                if field.type == "image", sink.picksImages {
                    Group {
                        if text.isEmpty {
                            Thumbnail(path: nil, url: nil)
                        } else {
                            FieldImagePreview(sink: sink, path: path + [.index(index)], value: text)
                        }
                    }
                    .frame(width: 44, height: 44)
                    .clipShape(.rect(cornerRadius: 6))
                }
                if text.isEmpty {
                    Text("Empty").foregroundStyle(.secondary)
                } else {
                    Text(label(for: text)).lineLimit(1)
                }
            }
        }
    }

    private func label(for text: String) -> String {
        switch field.type {
        case "image": return text.lastPathComponent
        case "reference": return referenceLabels[""]?[text] ?? text
        case "select": return field.selectValues.first { $0.value == text }?.label ?? text
        default: return text
        }
    }

    private func sync(_ items: [JSONValue]) {
        guard rows.map(\.value) != items else { return }
        rows = items.map { Row(value: $0) }
    }

    private func move(from source: IndexSet, to destination: Int) {
        guard let from = source.first else { return }
        rows.move(fromOffsets: source, toOffset: destination)
        let to = destination > from ? destination - 1 : destination
        Task { await sink.listMove(path, from: from, to: to) }
    }
}

/// Reads the form's latest state in its own body, so pushed pages stay
/// current as edits come back from the engine.
struct LiveFormState<Content: View>: View {
    let sink: any FormSink
    @ViewBuilder let content: (FormState) -> Content

    var body: some View {
        if let state = sink.formState() {
            content(state)
        } else {
            ContentUnavailableView("This item is no longer available", systemImage: "doc.questionmark")
        }
    }
}

/// An object-list row, as the desktop's collapsed list items: a thumbnail
/// when the items have an image (a placeholder while this one has none),
/// and a summary — the image's file name, else the first text or number
/// (a reference as its entry's title), else "Item N".
struct ObjectItemSummary: View {
    let sink: any FormSink
    let field: FieldView
    let value: JSONValue
    let index: Int
    let path: [PathKey]
    /// Entry titles by reference child, then stored value.
    var referenceLabels: [String: [String: String]] = [:]

    var body: some View {
        let image = Self.imageDescendant(field.fields)
        let stored = image.flatMap { Self.descendantString(value, $0) }
        HStack(spacing: 12) {
            if let image, sink.picksImages {
                Group {
                    if let stored {
                        FieldImagePreview(sink: sink, path: path + image.map(PathKey.key), value: stored)
                    } else {
                        Thumbnail(path: nil, url: nil)
                    }
                }
                .frame(width: 44, height: 44)
                .clipShape(.rect(cornerRadius: 6))
            }
            Text(stored?.lastPathComponent ?? summary).lineLimit(1)
        }
    }

    private var summary: String {
        for child in field.fields {
            switch value[child.name] {
            case .string(let text) where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                return child.type == "reference" ? referenceLabels[child.name]?[text] ?? text : text
            case .number(let number):
                return JSONValue.number(number).displayString
            default:
                continue
            }
        }
        return "Item \(index + 1)"
    }

    /// The field names down to the first visible image anywhere in an item
    /// (schemas often wrap it in a nested object or list).
    static func imageDescendant(_ fields: [FieldView]) -> [String]? {
        for child in fields where !child.hidden {
            if child.type == "image" { return [child.name] }
            if let nested = imageDescendant(child.fields) { return [child.name] + nested }
        }
        return nil
    }

    /// The first non-empty string at a descendant path; lists along the way
    /// give their first item that has one.
    static func descendantString(_ value: JSONValue, _ names: [String]) -> String? {
        if case .array(let items) = value {
            return items.lazy.compactMap { descendantString($0, names) }.first
        }
        guard let name = names.first else {
            if case .string(let text) = value, !text.isEmpty { return text }
            return nil
        }
        return value[name].flatMap { descendantString($0, Array(names.dropFirst())) }
    }
}

/// Developer mode: a field's `.posto` template — controlled (always follows
/// the template, read-only) or manual (a regenerate button).
struct FieldTemplateSheet: View {
    let document: DocumentModel
    let fieldName: String
    let label: String
    let current: FieldTemplate?
    @Environment(\.dismiss) private var dismiss
    @State private var template = ""
    @State private var controlled = false
    @State private var error: String?

    private var trimmed: String { template.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var missingExtension: Bool {
        fieldName == "filename" && !trimmed.isEmpty && trimmed.range(of: #"\.[A-Za-z0-9]+$"#, options: .regularExpression) == nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("{fields.title|slug}", text: $template, axis: .vertical)
                        .placeholderOnly()
                        .font(.body.monospaced())
                        .noAutocapitalization()
                        .autocorrectionDisabled()
                } header: {
                    Text("Template")
                } footer: {
                    if missingExtension {
                        Text("Filename templates must end with an extension, such as .mdx.").foregroundStyle(.red)
                    } else {
                        Text("Use {fields.x} for a raw field value or {fields.x|slug} for a slug.")
                    }
                }
                Section("Edit behavior") {
                    Picker("Edit behavior", selection: $controlled) {
                        Text("Manual: regenerate on request").tag(false)
                        Text("Controlled: always follows the template").tag(true)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                if current?.template != nil {
                    Section {
                        AsyncButton(role: .destructive) {
                            await save(fieldName == "filename" || current?.rows != nil
                                ? schema(template: nil) : nil)
                        } label: {
                            Text("Remove Template")
                        }
                    }
                }
            }
            .navigationTitle("\(label) Template")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton("Save") { await save(schema(template: trimmed)) }
                        .disabled(trimmed.isEmpty || missingExtension)
                }
            }
            .onAppear {
                template = current?.template ?? ""
                controlled = current.map(\.controlled) ?? (fieldName == "filename")
            }
            .errorAlert($error)
        }
    }

    private func schema(template: String?) -> JSONValue {
        var object: [String: JSONValue] = ["editBehavior": .string(controlled ? "controlled" : "manual")]
        if let template { object["template"] = .string(template) }
        if let rows = current?.rows { object["rows"] = .number(Double(rows)) }
        return .object(object)
    }

    private func save(_ schema: JSONValue?) async {
        do {
            let result: JSONValue = try await document.engine.call("collections.saveFieldTemplate", [
                "fieldName": .string(fieldName), "schema": schema ?? .null,
            ])
            if let next = try? result["view"]?.decode(as: DocumentView.self) { document.apply(next) }
            if let message = result["error"]?.stringValue { document.renameError = message }
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Developer mode: how many rows a string field shows.
struct FieldRowsSheet: View {
    let document: DocumentModel
    let fieldName: String
    let label: String
    let current: FieldTemplate?
    @Environment(\.dismiss) private var dismiss
    @State private var rows = 1
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Stepper("\(rows) \(rows == 1 ? "row" : "rows")", value: $rows, in: 1...50)
                } footer: {
                    Text("Number of visible rows in this string field.")
                }
            }
            .navigationTitle("\(label) Rows")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton("Save") {
                        var schema: [String: JSONValue] = [
                            "editBehavior": .string(current?.controlled == true ? "controlled" : "manual"),
                            "rows": .number(Double(rows)),
                        ]
                        if let template = current?.template { schema["template"] = .string(template) }
                        do {
                            let result: JSONValue = try await document.engine.call("collections.saveFieldTemplate", [
                                "fieldName": .string(fieldName), "schema": .object(schema),
                            ])
                            if let next = try? result["view"]?.decode(as: DocumentView.self) { document.apply(next) }
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
            }
            .onAppear { rows = current?.rows ?? 1 }
            .errorAlert($error)
        }
        .presentationDetents([.medium])
    }
}
