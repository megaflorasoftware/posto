import Foundation

/// Demo mode: the app's own commands (sign-in, repositories, clone) go to the
/// in-memory backend that lives inside the engine (`@posto/ipc/mock`), so the
/// whole app runs with fixture content and no Rust or network.
final class DemoBackend: Backend, @unchecked Sendable {
    weak var engine: Engine?
    private var handler: (@Sendable (String, String) -> Void)?

    func invoke(_ command: String, argsJSON: String) async -> String {
        guard let engine else { return #"{"error":"The demo engine is not running"}"# }
        let args = (try? JSONDecoder().decode(JSONValue.self, from: Data(argsJSON.utf8))) ?? .object([:])
        return await engine.callRaw("backend.invoke", ["command": .string(command), "args": args])
    }

    func setEventHandler(_ handler: @escaping @Sendable (String, String) -> Void) {
        self.handler = handler
    }

    /// Demo events arrive as the engine's `backend-event` notification.
    func deliver(_ name: String, payloadJSON: String) {
        handler?(name, payloadJSON)
    }
}

/// The engine's own transport while in demo mode; the mock replaces it.
final class UnavailableBackend: Backend, @unchecked Sendable {
    func invoke(_ command: String, argsJSON: String) async -> String {
        #"{"error":"No native backend in demo mode"}"#
    }

    func setEventHandler(_ handler: @escaping @Sendable (String, String) -> Void) {}
}
