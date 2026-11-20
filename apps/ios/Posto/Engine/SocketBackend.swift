#if DEBUG
import Foundation
import Network

/// Debug-only: reaches the Rust bridge through Tools/BackendHost over a Unix
/// domain socket, so the Mac Catalyst preview can run against real
/// repositories (`-PostoBackendSocket <path>`; see scripts/live-preview.sh).
final class SocketBackend: Backend, @unchecked Sendable {
    private let connection: NWConnection
    private let queue = DispatchQueue(label: "posto.socket-backend")
    private var pending: [Int: CheckedContinuation<String, Never>] = [:]
    private var nextId = 1
    private var handler: (@Sendable (String, String) -> Void)?

    init(socket: String) {
        connection = NWConnection(to: .unix(path: socket), using: .tcp)
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed(let error) = state { self?.failAll("Backend host unavailable: \(error)") }
        }
        connection.start(queue: queue)
        receive(buffer: Data())
    }

    func setEventHandler(_ handler: @escaping @Sendable (String, String) -> Void) {
        queue.async { self.handler = handler }
    }

    func invoke(_ command: String, argsJSON: String) async -> String {
        let args = (try? JSONDecoder().decode(JSONValue.self, from: Data(argsJSON.utf8))) ?? .object([:])
        return await withCheckedContinuation { continuation in
            queue.async {
                let id = self.nextId
                self.nextId += 1
                self.pending[id] = continuation
                var line = Data(JSONValue.object([
                    "id": .number(Double(id)), "command": .string(command), "args": args,
                ]).jsonString().utf8)
                line.append(0x0A)
                self.connection.send(content: line, completion: .contentProcessed { _ in })
            }
        }
    }

    private func receive(buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 22) { [weak self] data, _, complete, error in
            guard let self else { return }
            var rest = buffer
            if let data { rest.append(data) }
            while let newline = rest.firstIndex(of: 0x0A) {
                let line = Data(rest[rest.startIndex..<newline])
                rest = Data(rest[rest.index(after: newline)...])
                self.deliver(line)
            }
            if complete || error != nil {
                self.failAll("Backend host closed the connection")
            } else {
                self.receive(buffer: rest)
            }
        }
    }

    private func deliver(_ line: Data) {
        guard let message = try? JSONDecoder().decode(JSONValue.self, from: line) else { return }
        if let id = message["id"]?.doubleValue, let response = message["response"]?.stringValue {
            pending.removeValue(forKey: Int(id))?.resume(returning: response)
        } else if let event = message["event"]?.stringValue, let payload = message["payload"]?.stringValue {
            handler?(event, payload)
        }
    }

    private func failAll(_ message: String) {
        let envelope = JSONValue.object(["error": .string(message)]).jsonString()
        for continuation in pending.values { continuation.resume(returning: envelope) }
        pending.removeAll()
    }
}
#endif
