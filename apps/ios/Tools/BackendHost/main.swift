// Serves the Rust bridge (macOS host build) over a Unix domain socket, so
// the Mac Catalyst preview of the app can run against real repositories. (A
// Unix socket, not TCP: macOS's local network privacy check drops a GUI
// app's localhost TCP connections.) One JSON object per line:
//   request   {"id": 1, "command": "list_files", "args": {...}}
//   response  {"id": 1, "response": "<the bridge's envelope JSON>"}
//   event     {"event": "clone-progress", "payload": "<payload JSON>"}
// Built and started by scripts/live-preview.sh.
import Foundation
import Network

@main
struct BackendHost {
    static func main() async throws {
        let arguments = CommandLine.arguments
        guard arguments.count >= 3 else {
            print("usage: backend-host <socket path> <data directory>")
            exit(64)
        }
        let socket = arguments[1]
        unlink(socket)
        let backend = try RustBackend(dataDirectory: URL(fileURLWithPath: arguments[2], isDirectory: true))
        let server = try Server(backend: backend, socket: socket)
        server.start()
        print("backend-host listening on \(socket)")
        fflush(stdout)
        while true { try await Task.sleep(for: .seconds(3600)) }
    }
}

final class Server: @unchecked Sendable {
    private let backend: RustBackend
    private let listener: NWListener
    private let queue = DispatchQueue(label: "posto.backend-host")
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    init(backend: RustBackend, socket: String) throws {
        self.backend = backend
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .unix(path: socket)
        listener = try NWListener(using: parameters)
    }

    func start() {
        backend.setEventHandler { [weak self] name, payload in
            guard let self, let line = Self.line(["event": name, "payload": payload]) else { return }
            self.queue.async {
                for connection in self.connections.values { connection.send(content: line, completion: .contentProcessed { _ in }) }
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            self.connections[ObjectIdentifier(connection)] = connection
            connection.stateUpdateHandler = { [weak self] state in
                if case .cancelled = state { self?.connections.removeValue(forKey: ObjectIdentifier(connection)) }
                if case .failed = state { connection.cancel() }
            }
            connection.start(queue: self.queue)
            self.receive(on: connection, buffer: Data())
        }
        listener.start(queue: queue)
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
            guard let self else { return }
            var pending = buffer
            if let data { pending.append(data) }
            while let newline = pending.firstIndex(of: 0x0A) {
                let line = pending[pending.startIndex..<newline]
                pending = Data(pending[pending.index(after: newline)...])
                self.handle(Data(line), on: connection)
            }
            if complete || error != nil {
                connection.cancel()
            } else {
                self.receive(on: connection, buffer: pending)
            }
        }
    }

    private func handle(_ line: Data, on connection: NWConnection) {
        guard let request = try? JSONDecoder().decode(JSONValue.self, from: line),
              let id = request["id"]?.doubleValue,
              let command = request["command"]?.stringValue
        else { return }
        let args = (request["args"] ?? .object([:])).jsonString()
        let backend = backend
        Task {
            let response = await backend.invoke(command, argsJSON: args)
            print("\(command) -> \(response.prefix(100))")
            fflush(stdout)
            guard let reply = Self.line(["id": id, "response": response]) else { return }
            connection.send(content: reply, completion: .contentProcessed { _ in })
        }
    }

    private static func line(_ object: [String: Any]) -> Data? {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        data.append(0x0A)
        return data
    }
}
