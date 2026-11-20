import Foundation

/// Where commands run: the Rust bridge on a device, or the in-memory demo
/// backend inside the engine. Responses use the bridge's envelope:
/// `{"ok": value}` or `{"error": "message"}`.
protocol Backend: AnyObject, Sendable {
    func invoke(_ command: String, argsJSON: String) async -> String
    /// Backend events (`clone-progress`, `auth-device-code`, `fs-changed`,
    /// `channel`) as name + JSON payload.
    func setEventHandler(_ handler: @escaping @Sendable (String, String) -> Void)
}

struct BackendError: LocalizedError, Sendable {
    let message: String
    var errorDescription: String? { message }
}

private struct Envelope: Decodable {
    let ok: JSONValue?
    let error: String?
}

/// Decodes a bridge envelope into its value, or throws its error.
func decodeEnvelope<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
    let envelope = try JSONDecoder().decode(Envelope.self, from: Data(json.utf8))
    if let error = envelope.error { throw BackendError(message: error) }
    let value = envelope.ok ?? .null
    if let typed = value as? T { return typed }
    do {
        return try value.decode(as: T.self)
    } catch {
        throw BackendError(message: "Unexpected response shape for \(T.self): \(error)")
    }
}

/// Encodes command arguments the way Tauri's `invoke` receives them.
func encodeArgs(_ args: [String: JSONValue]) -> String {
    JSONValue.object(args).jsonString()
}

extension Backend {
    func call<T: Decodable>(
        _ command: String, _ args: [String: JSONValue] = [:], as type: T.Type = T.self
    ) async throws -> T {
        try decodeEnvelope(await invoke(command, argsJSON: encodeArgs(args)), as: T.self)
    }

    func run(_ command: String, _ args: [String: JSONValue] = [:]) async throws {
        _ = try await call(command, args, as: JSONValue.self)
    }
}
