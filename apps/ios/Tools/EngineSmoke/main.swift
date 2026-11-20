// Runs the bundled engine in JavaScriptCore on macOS against the demo
// backend, exercising the same calls the app makes. Built by
// scripts/engine-smoke.sh from the app's Engine/*.swift sources.
import Foundation

struct Check {
    var failures = 0

    mutating func expect(_ condition: Bool, _ message: String) {
        if condition {
            print("  ok   \(message)")
        } else {
            failures += 1
            print("  FAIL \(message)")
        }
    }
}

@main
struct EngineSmoke {
    static func main() async throws {
        let path = CommandLine.arguments.dropFirst().first ?? "Posto/Resources/engine.js"
        let script = try String(contentsOfFile: path, encoding: .utf8)
        let events = EventLog()
        let engine = try Engine(script: script, backend: UnavailableBackend()) { name, _ in
            events.record(name)
        }
        var check = Check()
        let demo = DemoBackend()
        demo.engine = engine

        try await engine.run("engine.useDemo")
        try await demo.run("sign_in")
        let status = try await demo.call("auth_status", as: JSONValue.self)
        check.expect(status["signed_in"]?.boolValue == true, "demo sign-in")

        let repo = try await engine.call("repo.open", [
            "repoRoot": "/mock/site",
            "repo": ["owner": "example-org", "name": "posto", "cloneUrl": "https://github.com/example-org/posto.git", "defaultBranch": "main"],
            "developerMode": true,
        ], as: JSONValue.self)
        check.expect(repo["error"]?.isNull == true, "repo opens without error (\(repo["error"]?.displayString ?? ""))")
        let labels = repo["tree"]?.arrayValue?.compactMap { $0["label"]?.stringValue } ?? []
        check.expect(labels.contains("Writing"), "tree has the Writing collection: \(labels)")

        let writing = repo["tree"]?.arrayValue?.first { $0["label"]?.stringValue == "Writing" }
        let key = writing?["files"]?[0]?["key"]?.stringValue ?? ""
        let document = try await engine.call("doc.open", ["key": .string(key)], as: JSONValue.self)
        check.expect(document["form"]?["fields"]?.arrayValue?.isEmpty == false, "document form has fields")

        let edited = try await engine.call("form.edit", ["path": ["title"], "value": "From JavaScriptCore"], as: JSONValue.self)
        check.expect(edited["form"]?["values"]?["title"]?.stringValue == "From JavaScriptCore", "form edit applies")
        check.expect(edited["saveState"]?.stringValue == "saving", "edit schedules an autosave")
        // The 800 ms autosave runs on a native timer.
        try await Task.sleep(for: .milliseconds(1_200))
        let saved = try await engine.call("doc.view", as: JSONValue.self)
        check.expect(saved["saveState"]?.stringValue == "saved", "autosave timer fired (\(saved["saveState"]?.displayString ?? ""))")

        let url = Engine.urlParts("https://cdn.example.com/a/b?x=1#y", base: nil) ?? ""
        check.expect(url.contains("\"pathname\":\"\\/a\\/b\"") || url.contains("\"pathname\":\"/a/b\""), "URL parsing: \(url)")

        let publish = try await engine.call("git.loadChanges", as: JSONValue.self)
        check.expect(publish["changesError"]?.isNull == true, "publish sheet loads changes")

        let tabs = try await engine.call("media.tabs", as: JSONValue.self)
        check.expect((tabs.arrayValue?.count ?? 0) >= 2, "media tabs: \(tabs.arrayValue?.compactMap { $0["label"]?.stringValue } ?? [])")

        let deploy = try await engine.call("deploy.status", as: JSONValue.self)
        check.expect(deploy["ring"]?["state"]?.stringValue != nil, "deployment ring computed")

        check.expect(events.names.contains("repo"), "engine pushed repo events")
        print(check.failures == 0 ? "engine smoke: all checks passed" : "engine smoke: \(check.failures) failed")
        exit(check.failures == 0 ? 0 : 1)
    }
}

final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: Set<String> = []

    func record(_ name: String) {
        lock.lock()
        recorded.insert(name)
        lock.unlock()
    }

    var names: Set<String> {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }
}
