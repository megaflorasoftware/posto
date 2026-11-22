import SwiftUI

/// A dismissible notice row used for status and error messages.
struct NoticeRow: View {
    let message: String
    var systemImage = "info.circle"
    var tint: Color = .accentColor

    var body: some View {
        Label {
            Text(message).font(.subheadline)
        } icon: {
            Image(systemName: systemImage).foregroundStyle(tint)
        }
    }
}

/// Runs async work from a button with a spinner while it runs.
struct AsyncButton<Label: View>: View {
    var role: ButtonRole?
    let action: () async -> Void
    @ViewBuilder let label: () -> Label
    @State private var running = false

    init(role: ButtonRole? = nil, action: @escaping () async -> Void, @ViewBuilder label: @escaping () -> Label) {
        self.role = role
        self.action = action
        self.label = label
    }

    var body: some View {
        Button(role: role) {
            guard !running else { return }
            running = true
            Task {
                await action()
                running = false
            }
        } label: {
            if running {
                HStack(spacing: 8) {
                    ProgressView()
                    label()
                }
            } else {
                label()
            }
        }
        .disabled(running)
    }
}

extension AsyncButton where Label == Text {
    init(_ title: String, role: ButtonRole? = nil, action: @escaping () async -> Void) {
        self.init(role: role, action: action) { Text(title) }
    }
}

/// Save state shown under the editor's title.
func saveStateLabel(_ state: String) -> (text: String, symbol: String, color: Color) {
    switch state {
    case "saving": return ("Saving…", "arrow.triangle.2.circlepath", .secondary)
    case "error": return ("Couldn't save", "exclamationmark.triangle.fill", .red)
    case "invalid": return ("Fix errors to save", "exclamationmark.circle.fill", .orange)
    default: return ("Saved", "checkmark.circle", .secondary)
    }
}

extension String {
    var lastPathComponent: String { (self as NSString).lastPathComponent }
}

/// Lets a sheet's environment carry an error alert without boilerplate.
struct ErrorAlert: ViewModifier {
    @Binding var message: String?

    func body(content: Content) -> some View {
        content.alert(
            "Something went wrong",
            isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } }),
            presenting: message
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { message in
            Text(message)
        }
    }
}

extension View {
    func errorAlert(_ message: Binding<String?>) -> some View {
        modifier(ErrorAlert(message: message))
    }

    /// `.task`, run once while the view is shown. In a NavigationStack a
    /// page disappears under each page pushed over it (a long select's
    /// options, Edit Source) and appears again as that one pops, which runs
    /// `.task` and `.onAppear` again: a sheet's form started there would
    /// start over and drop what was typed.
    func taskOnce(_ action: @escaping @MainActor () async -> Void) -> some View {
        modifier(TaskOnce(action: action))
    }
}

private struct TaskOnce: ViewModifier {
    let action: @MainActor () async -> Void
    @State private var started = false

    func body(content: Content) -> some View {
        content.task {
            guard !started else { return }
            started = true
            await action()
        }
    }
}
