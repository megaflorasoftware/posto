import Foundation

/// The Catalyst preview build runs demo mode only; the Rust bridge isn't
/// built for Mac Catalyst.
final class RustBackend: Backend, @unchecked Sendable {
    init() throws {
        throw BackendError(message: "This preview build only runs the demo. Use the iOS build for GitHub.")
    }

    func invoke(_ command: String, argsJSON: String) async -> String { #"{"error":"unavailable"}"# }
    func setEventHandler(_ handler: @escaping @Sendable (String, String) -> Void) {}
}
