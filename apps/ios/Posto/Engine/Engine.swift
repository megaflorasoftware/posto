import Foundation
import JavaScriptCore

/// Hosts the TypeScript engine (`engine.js`) in JavaScriptCore. All script
/// access happens on one serial queue; JavaScriptCore drains promise jobs
/// each time a call into the script returns, so async engine methods advance
/// as backend responses and timers arrive.
final class Engine: @unchecked Sendable {
    private let queue = DispatchQueue(label: "posto.engine", qos: .userInitiated)
    private let context: JSContext
    private var engineObject: JSValue?
    private let backend: Backend
    private var nextCallId = 1
    private var pendingCalls: [Int: CheckedContinuation<String, Never>] = [:]
    private var timers: [Int: DispatchSourceTimer] = [:]
    private let eventHandler: @Sendable (String, String) -> Void

    /// - Parameter onEvent: engine notifications (`repo`, `document`, …) as
    ///   name + JSON payload, delivered on the engine queue.
    init(script: String, backend: Backend, onEvent: @escaping @Sendable (String, String) -> Void) throws {
        guard let context = JSContext() else { throw BackendError(message: "JavaScriptCore is unavailable") }
        self.context = context
        self.backend = backend
        self.eventHandler = onEvent
        context.name = "Posto Engine"
        context.exceptionHandler = { _, exception in
            let message = exception?.toString() ?? "unknown"
            let stack = exception?.objectForKeyedSubscript("stack")?.toString() ?? ""
            NSLog("[engine] uncaught exception: %@\n%@", message, stack)
        }
        try queue.sync {
            self.installNativeHost()
            context.evaluateScript(script, withSourceURL: URL(string: "posto://engine.js"))
            if let exception = context.exception {
                throw BackendError(message: "The engine failed to load: \(exception)")
            }
            guard let engine = context.objectForKeyedSubscript("PostoEngine"), engine.isObject else {
                throw BackendError(message: "The engine script did not install PostoEngine")
            }
            self.engineObject = engine
        }
        backend.setEventHandler { [weak self] name, payload in
            self?.backendEvent(name, payloadJSON: payload)
        }
    }

    convenience init(bundle: Bundle = .main, backend: Backend, onEvent: @escaping @Sendable (String, String) -> Void) throws {
        guard let url = bundle.url(forResource: "engine", withExtension: "js") else {
            throw BackendError(message: "engine.js is missing from the app bundle")
        }
        try self.init(script: String(contentsOf: url, encoding: .utf8), backend: backend, onEvent: onEvent)
    }

    // MARK: Calls

    /// Runs an engine method and returns its JSON envelope.
    func callRaw(_ method: String, _ args: [String: JSONValue] = [:]) async -> String {
        let argsJSON = encodeArgs(args)
        return await withCheckedContinuation { continuation in
            queue.async {
                let id = self.nextCallId
                self.nextCallId += 1
                self.pendingCalls[id] = continuation
                self.engineObject?.invokeMethod("call", withArguments: [id, method, argsJSON])
            }
        }
    }

    func call<T: Decodable>(_ method: String, _ args: [String: JSONValue] = [:], as type: T.Type = T.self) async throws -> T {
        try decodeEnvelope(await callRaw(method, args), as: T.self)
    }

    func run(_ method: String, _ args: [String: JSONValue] = [:]) async throws {
        _ = try await call(method, args, as: JSONValue.self)
    }

    /// Forwards a backend event (Rust or demo) into the script.
    func backendEvent(_ name: String, payloadJSON: String) {
        queue.async {
            self.engineObject?.invokeMethod("backendEvent", withArguments: [name, payloadJSON])
        }
    }

    // MARK: Native host

    private func installNativeHost() {
        let host = JSValue(newObjectIn: context)!

        let invoke: @convention(block) (Double, String, String) -> Void = { [weak self] requestId, command, argsJSON in
            guard let self else { return }
            let backend = self.backend
            Task.detached {
                let response = await backend.invoke(command, argsJSON: argsJSON)
                self.queue.async {
                    self.engineObject?.invokeMethod("resolveInvoke", withArguments: [requestId, response])
                }
            }
        }
        host.setObject(invoke, forKeyedSubscript: "invoke" as NSString)

        let emit: @convention(block) (String, String) -> Void = { [weak self] name, payload in
            self?.eventHandler(name, payload)
        }
        host.setObject(emit, forKeyedSubscript: "emit" as NSString)

        let reply: @convention(block) (Double, String) -> Void = { [weak self] callId, response in
            guard let self, let continuation = self.pendingCalls.removeValue(forKey: Int(callId)) else { return }
            continuation.resume(returning: response)
        }
        host.setObject(reply, forKeyedSubscript: "reply" as NSString)

        let log: @convention(block) (String, String) -> Void = { level, message in
            NSLog("[engine:%@] %@", level, message)
        }
        host.setObject(log, forKeyedSubscript: "log" as NSString)

        let setTimer: @convention(block) (Double, Double, Bool) -> Void = { [weak self] id, delay, repeats in
            guard let self else { return }
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            let interval = DispatchTimeInterval.milliseconds(Int(max(0, delay)))
            if repeats {
                timer.schedule(deadline: .now() + interval, repeating: interval == .milliseconds(0) ? .milliseconds(1) : interval)
            } else {
                timer.schedule(deadline: .now() + interval)
            }
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                if !repeats { self.timers.removeValue(forKey: Int(id))?.cancel() }
                self.engineObject?.invokeMethod("fireTimer", withArguments: [id])
            }
            self.timers[Int(id)]?.cancel()
            self.timers[Int(id)] = timer
            timer.resume()
        }
        host.setObject(setTimer, forKeyedSubscript: "setTimer" as NSString)

        let clearTimer: @convention(block) (Double) -> Void = { [weak self] id in
            self?.timers.removeValue(forKey: Int(id))?.cancel()
        }
        host.setObject(clearTimer, forKeyedSubscript: "clearTimer" as NSString)

        let parseURL: @convention(block) (String, JSValue) -> JSValue = { input, base in
            let context = JSContext.current()!
            let baseURL = base.isString ? URL(string: base.toString()) : nil
            guard let parsed = Self.urlParts(input, base: baseURL) else { return JSValue(nullIn: context) }
            return JSValue(object: parsed, in: context)
        }
        host.setObject(parseURL, forKeyedSubscript: "parseURL" as NSString)

        context.setObject(host, forKeyedSubscript: "__postoNative" as NSString)
    }

    /// WHATWG-style URL parts from Foundation's parser, as JSON. Only absolute
    /// URLs with a scheme are valid, like `new URL()` without a base.
    static func urlParts(_ input: String, base: URL?) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = base.flatMap({ URL(string: trimmed, relativeTo: $0)?.absoluteURL }) ?? URL(string: trimmed),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: true),
              let scheme = components.scheme?.lowercased()
        else { return nil }
        let special = ["http", "https", "ws", "wss", "ftp"].contains(scheme)
        let host = components.percentEncodedHost?.lowercased() ?? ""
        if special && host.isEmpty { return nil }
        let defaultPorts = ["http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21]
        let port = components.port.flatMap { defaultPorts[scheme] == $0 ? nil : String($0) } ?? ""
        let hostWithPort = port.isEmpty ? host : "\(host):\(port)"
        var path = components.percentEncodedPath
        if special && path.isEmpty { path = "/" }
        let search = components.percentEncodedQuery.map { $0.isEmpty ? "" : "?\($0)" } ?? ""
        let hash = components.percentEncodedFragment.map { $0.isEmpty ? "" : "#\($0)" } ?? ""
        let user = components.percentEncodedUser ?? ""
        let password = components.percentEncodedPassword ?? ""
        let credentials = user.isEmpty && password.isEmpty ? "" : "\(user)\(password.isEmpty ? "" : ":\(password)")@"
        let origin = special && scheme != "ftp" ? "\(scheme)://\(hostWithPort)" : "null"
        let href = special || !host.isEmpty
            ? "\(scheme)://\(credentials)\(hostWithPort)\(path)\(search)\(hash)"
            : "\(scheme):\(path)\(search)\(hash)"
        let parts: [String: String] = [
            "href": href,
            "protocol": "\(scheme):",
            "username": user,
            "password": password,
            "host": hostWithPort,
            "hostname": host,
            "port": port,
            "pathname": path,
            "search": search,
            "hash": hash,
            "origin": origin,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: parts) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
}
