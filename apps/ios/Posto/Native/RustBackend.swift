import Foundation
import PostoNative

/// The Tauri app's Rust commands (git, GitHub, files, media), linked in as
/// PostoNative.xcframework and called through its `invoke` C ABI.
final class RustBackend: Backend, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (@Sendable (String, String) -> Void)?

    /// - Parameter dataDirectory: where repositories and settings live;
    ///   defaults to the app's Application Support folder. Tools on a Mac
    ///   pass their own so they never touch an installed app's data.
    init(dataDirectory: URL? = nil) throws {
        let files = FileManager.default
        let identifier = Bundle.main.bundleIdentifier ?? "net.megaflora.posto.native"
        let support = try dataDirectory ?? files.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent(identifier, isDirectory: true)
        let caches = try dataDirectory?.appendingPathComponent("cache", isDirectory: true)
            ?? files.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent(identifier, isDirectory: true)
        for directory in [support, caches] {
            try files.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        // Repositories live here; keep them out of iCloud backups like any
        // re-downloadable cache.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var supportURL = support
        try? supportURL.setResourceValues(values)

        let config = JSONValue.object([
            "dataDir": .string(support.path),
            "cacheDir": .string(caches.path),
            "configDir": .string(support.path),
        ]).jsonString()
        let status = posto_init(config, { _, event, payload in
            guard let event, let payload else { return }
            let name = String(cString: event)
            let json = String(cString: payload)
            RustBackend.lock.lock()
            let handler = RustBackend.handler
            RustBackend.lock.unlock()
            handler?(name, json)
        }, nil)
        // 2 means an earlier instance already started the engine.
        if status == 1 { throw BackendError(message: "The Posto engine rejected its configuration") }
    }

    func setEventHandler(_ handler: @escaping @Sendable (String, String) -> Void) {
        Self.lock.lock()
        Self.handler = handler
        Self.lock.unlock()
    }

    func invoke(_ command: String, argsJSON: String) async -> String {
        await withCheckedContinuation { (continuation: CheckedContinuation<String, Never>) in
            let box = Unmanaged.passRetained(ResponseBox(continuation)).toOpaque()
            posto_invoke(0, command, argsJSON, { context, _, response in
                guard let context else { return }
                let box = Unmanaged<ResponseBox>.fromOpaque(context).takeRetainedValue()
                box.continuation.resume(returning: response.map { String(cString: $0) } ?? #"{"error":"No response"}"#)
            }, box)
        }
    }
}

private final class ResponseBox {
    let continuation: CheckedContinuation<String, Never>

    init(_ continuation: CheckedContinuation<String, Never>) {
        self.continuation = continuation
    }
}
