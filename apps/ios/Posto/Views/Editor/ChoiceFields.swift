import SwiftUI

/// A select field. Long option lists (an icon-name enum can have thousands)
/// don't travel with the form view; the row fetches them once, so edits
/// elsewhere in the form never resend or re-diff them.
struct SelectFieldRow: View {
    let sink: any FormSink
    let field: FieldView
    let path: [PathKey]
    let value: String
    let title: String
    @State private var fetched: [SelectOption]?

    var body: some View {
        let fetches = field.fetchesSelectValues
        ChoiceField(
            title: title,
            options: fetches ? fetched ?? [] : field.selectValues,
            total: field.selectCount,
            loading: fetches && fetched == nil,
            value: value,
            clearable: !field.required
        ) { next in
            Task { await sink.edit(path, next.map(JSONValue.string)) }
        }
        .task(id: fetches ? "\(field.schemaPath)#\(field.selectCount ?? 0)" : nil) {
            guard fetches else { return }
            fetched = (try? await sink.engine.call("form.selectOptions", [
                "form": .string(sink.formTarget), "path": path.json,
            ], as: [SelectOption].self)) ?? []
        }
    }
}

/// A select or reference field's control, as the Tauri app's searchable
/// selects (AdaptiveSelect): a menu for a short list of options, else a row
/// that pushes a searchable list. A stored value that isn't among the
/// options stays shown (references mark it missing).
struct ChoiceField: View {
    let title: String
    let options: [SelectOption]
    /// How many options there are, when `options` is still loading.
    var total: Int? = nil
    var loading = false
    /// The stored value; empty when unset.
    let value: String
    /// Optional fields can be set back to None.
    let clearable: Bool
    /// How a stored value missing from the options reads.
    var unknownLabel: (String) -> String = { $0 }
    var disabled = false
    let onChange: (String?) -> Void

    /// Longer lists push a searchable page instead of a menu.
    static let menuLimit = 10

    var body: some View {
        if max(options.count, total ?? 0) <= Self.menuLimit {
            let choices = choices
            Picker(selection: Binding(get: { value }, set: { onChange($0.isEmpty ? nil : $0) })) {
                if showsNone { Text("None").tag("") }
                ForEach(choices) { option in
                    Text(option.label).tag(option.value)
                }
            } label: {
                Text(title)
            }
            .pickerStyle(.menu)
            .disabled(disabled)
        } else {
            NavigationLink {
                ChoiceList(title: title, options: choices, value: value, showsNone: showsNone, onChange: onChange)
            } label: {
                LabeledContent(title) {
                    Text(selectedLabel).lineLimit(1)
                }
            }
            .disabled(disabled || loading)
        }
    }

    private var known: Bool { options.contains { $0.value == value } }

    private var choices: [SelectOption] {
        guard !value.isEmpty, !known else { return options }
        return [SelectOption(value: value, label: unknownLabel(value))] + options
    }

    private var selectedLabel: String {
        if value.isEmpty { return "None" }
        if loading { return value }
        return options.first { $0.value == value }?.label ?? unknownLabel(value)
    }

    /// None is offered when the field may be empty, and stands for an empty
    /// required field until something is chosen.
    private var showsNone: Bool { clearable || value.isEmpty }
}

/// The searchable options page: a lazily drawn list that matches by label
/// or value, shows at most 50 matches at a time as the desktop select does,
/// and returns on a choice.
struct ChoiceList: View {
    let title: String
    let options: [SelectOption]
    let value: String
    let showsNone: Bool
    let onChange: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    static let shownLimit = 50

    var body: some View {
        let search = query.trimmingCharacters(in: .whitespaces)
        let matches = search.isEmpty ? options : options.filter {
            $0.label.localizedCaseInsensitiveContains(search) || $0.value.localizedCaseInsensitiveContains(search)
        }
        List {
            Section {
                if showsNone && search.isEmpty {
                    row(label: "None", value: "")
                }
                ForEach(shown(matches)) { option in
                    row(label: option.label, value: option.value)
                }
            } footer: {
                if matches.count > Self.shownLimit {
                    Text("Showing \(Self.shownLimit) of \(matches.count). Search to find the rest.")
                }
            }
        }
        .overlay {
            if matches.isEmpty && !search.isEmpty {
                ContentUnavailableView.search(text: search)
            }
        }
        .searchable(text: $query, placement: .alwaysVisible, prompt: "Search")
        .noAutocapitalization()
        .autocorrectionDisabled()
        .navigationTitle(title)
        .inlineNavigationTitle()
    }

    /// The first matches, keeping the current choice in reach.
    private func shown(_ matches: [SelectOption]) -> [SelectOption] {
        var shown = Array(matches.prefix(Self.shownLimit))
        if let current = matches.first(where: { $0.value == value }), !shown.contains(current) {
            shown.insert(current, at: 0)
        }
        return shown
    }

    private func row(label: String, value: String) -> some View {
        Button {
            onChange(value.isEmpty ? nil : value)
            dismiss()
        } label: {
            HStack {
                Text(label).foregroundStyle(.primary)
                Spacer()
                if value == self.value {
                    Image(systemName: "checkmark").foregroundStyle(.tint)
                }
            }
            .contentShape(.rect)
        }
        .rowButtonStyle()
    }
}
