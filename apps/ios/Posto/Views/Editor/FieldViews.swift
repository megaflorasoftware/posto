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

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            control
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if showLabel, let description = field.description, !description.isEmpty, field.type != "boolean" {
                Text(description).font(.caption).foregroundStyle(.secondary)
            }
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
                    disabled: field.locked
                ) { text in
                    let trimmed = text.trimmingCharacters(in: .whitespaces)
                    if trimmed.isEmpty { return nil }
                    return Double(trimmed).map(JSONValue.number) ?? .string(trimmed)
                } commit: { next in
                    await sink.edit(path, next)
                }
                .keyboardType(.decimalPad)
            }
        case "date":
            DateFieldRow(sink: sink, field: field, path: path, value: value, control: state.dates[path.dotted], label: label)
        case "select":
            SelectFieldRow(field: field, value: value?.stringValue ?? "", label: label) { next in
                Task { await sink.edit(path, next.map(JSONValue.string)) }
            }
        case "image":
            if let document {
                ImageFieldRow(document: document, field: field, path: path, value: value?.stringValue ?? "", label: label)
            } else {
                textControl(multiline: false)
            }
        case "reference":
            if let document {
                ReferenceFieldRow(document: document, field: field, path: path, value: value?.stringValue ?? "", label: label)
            } else {
                textControl(multiline: false)
            }
        case "string":
            textControl(multiline: (field.template?.rows ?? 1) > 1)
        default:
            textControl(multiline: true)
        }
    }

    private func textControl(multiline: Bool) -> some View {
        LabeledField(label: label) {
            HStack(alignment: .top) {
                BufferedTextField(
                    placeholder: field.label,
                    source: value?.stringValue ?? "",
                    multiline: multiline,
                    disabled: field.disabled
                ) { text in
                    text.isEmpty ? nil : .string(text)
                } commit: { next in
                    await sink.edit(path, next)
                }
                if field.chooseImage, let document {
                    ImageChooserButton(document: document, path: path) { picked in
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
    var multiline = false
    var disabled = false
    let parse: (String) -> JSONValue?
    let commit: (JSONValue?) async -> Void

    @State private var draft = ""
    @FocusState private var focused: Bool
    @State private var pending: Task<Void, Never>?

    var body: some View {
        Group {
            if multiline {
                TextField(placeholder, text: $draft, axis: .vertical)
                    .lineLimit(3...12)
            } else {
                TextField(placeholder, text: $draft)
            }
        }
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
            if !isFocused, pending == nil { draft = source }
        }
    }
}

struct SelectFieldRow: View {
    let field: FieldView
    let value: String
    let label: String
    let onChange: (String?) -> Void

    var body: some View {
        let known = field.selectValues.contains { $0.value == value }
        Picker(selection: Binding(get: { value }, set: { onChange($0.isEmpty ? nil : $0) })) {
            if !field.required || value.isEmpty {
                Text("None").tag("")
            }
            if !value.isEmpty && !known {
                Text(value).tag(value)
            }
            ForEach(field.selectValues) { option in
                Text(option.label).tag(option.value)
            }
        } label: {
            Text(label.isEmpty ? field.label : label)
        }
        .pickerStyle(.menu)
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

    var body: some View {
        let items = state.values.value(at: path)?.arrayValue ?? []
        let canRemove = items.count > (field.listMin ?? 0)
        let canAdd = field.listMax.map { items.count < $0 } ?? true
        let item = FieldView(
            name: field.name, type: field.type, label: field.label, showLabel: false,
            description: nil, required: false, hidden: false, list: false, listMin: nil, listMax: nil,
            schemaPath: field.schemaPath, fields: field.fields, locked: field.locked, template: nil,
            selectValues: field.selectValues, numberMin: field.numberMin, numberMax: field.numberMax,
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
                            ObjectItemSummary(document: document, field: field, value: items[index], index: index, path: itemPath)
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
        } header: {
            Text(field.displayLabel)
        } footer: {
            FieldFooter(field: field, error: state.errors[path.dotted])
        }
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

/// An object-list row: a thumbnail of its first image and a summary.
struct ObjectItemSummary: View {
    var document: DocumentModel?
    let field: FieldView
    let value: JSONValue
    let index: Int
    let path: [PathKey]

    var body: some View {
        HStack(spacing: 12) {
            if let document, let image = firstImage(field.fields, value, path) {
                FieldImagePreview(document: document, path: image.path, value: image.value)
                    .frame(width: 44, height: 44)
                    .clipShape(.rect(cornerRadius: 6))
            }
            Text(summary).lineLimit(1)
        }
    }

    private var summary: String {
        if let image = firstImage(field.fields, value, path) { return image.value.lastPathComponent }
        for child in field.fields where !child.hidden {
            if let text = value[child.name]?.stringValue, !text.isEmpty { return text }
        }
        return "Item \(index + 1)"
    }

    private func firstImage(_ fields: [FieldView], _ value: JSONValue, _ base: [PathKey]) -> (path: [PathKey], value: String)? {
        for child in fields where !child.hidden {
            let childPath = base + [.key(child.name)]
            if child.type == "image", let text = value[child.name]?.stringValue, !text.isEmpty {
                return (childPath, text)
            }
            if child.type == "object", !child.list, let nested = value[child.name],
               let found = firstImage(child.fields, nested, childPath) {
                return found
            }
        }
        return nil
    }
}
