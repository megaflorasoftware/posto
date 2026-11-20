// Runs the real stack on macOS: the app's RustBackend (the Rust bridge
// built with `build-native.sh --host`) under the engine in JavaScriptCore,
// against a throwaway git copy of a site. Built by scripts/native-smoke.sh.
import Foundation

@main
struct NativeSmoke {
    static func main() async throws {
        let arguments = CommandLine.arguments
        guard arguments.count >= 3 else {
            print("usage: native-smoke <engine.js> <git repo of a site>")
            exit(64)
        }
        let script = try String(contentsOfFile: arguments[1], encoding: .utf8)
        let repoRoot = arguments[2]
        var failures = 0
        func expect(_ condition: Bool, _ message: String) {
            print(condition ? "  ok   \(message)" : "  FAIL \(message)")
            if !condition { failures += 1 }
        }

        let backend = try RustBackend()
        let engine = try Engine(script: script, backend: backend) { _, _ in }

        let exists = try await backend.call("path_exists", ["path": .string(repoRoot), "kind": "directory"], as: Bool.self)
        expect(exists, "Rust path_exists through the C ABI")

        let opened = try await engine.call("repo.open", ["repoRoot": .string(repoRoot), "developerMode": true], as: JSONValue.self)
        expect(opened["error"]?.isNull != false, "repo opens (\(opened["error"]?.displayString ?? ""))")
        let type = opened["projectType"]?.stringValue ?? ""
        expect(type == "astro", "detects the Astro project: \(type)")
        let tree = opened["tree"]?.arrayValue ?? []
        let labels = tree.compactMap { $0["label"]?.stringValue }
        expect(!labels.isEmpty, "file tree from list_files: \(labels.prefix(6))")
        try await Task.sleep(for: .milliseconds(500))
        let later = try await engine.call("repo.view", as: JSONValue.self)
        expect(later["branch"]?.stringValue == "main", "current branch: \(later["branch"]?.displayString ?? "nil")")

        func firstMarkdown(_ nodes: [JSONValue]) -> String? {
            for node in nodes {
                if let file = node["files"]?.arrayValue?.first(where: { ($0["name"]?.stringValue ?? "").hasSuffix(".md") || ($0["name"]?.stringValue ?? "").hasSuffix(".mdx") }) {
                    return file["key"]?.stringValue
                }
                if let nested = firstMarkdown(node["children"]?.arrayValue ?? []) { return nested }
            }
            return nil
        }
        guard let key = firstMarkdown(tree) else {
            expect(false, "found a markdown file")
            exit(1)
        }
        let document = try await engine.call("doc.open", ["key": .string(key)], as: JSONValue.self)
        let fields = document["form"]?["fields"]?.arrayValue?.compactMap { $0["name"]?.stringValue } ?? []
        expect(!fields.isEmpty || document["body"] != nil, "opens \((key as NSString).lastPathComponent) with fields \(fields.prefix(5))")

        let original = try await backend.call("read_text_file", ["path": .string(key)], as: String.self)
        _ = try await engine.call("doc.setBody", ["text": "Edited by the native smoke test.\n"], as: JSONValue.self)
        try await engine.run("doc.flush")
        let saved = try await backend.call("read_text_file", ["path": .string(key)], as: String.self)
        expect(saved.contains("Edited by the native smoke test.") && saved != original, "autosave writes through Rust")

        let changes = try await engine.call("git.loadChanges", as: JSONValue.self)
        let changed = changes["changes"]?.arrayValue?.compactMap { $0["path"]?.stringValue } ?? []
        expect(changed.contains { key.hasSuffix($0) }, "git2 sees the change: \(changed)")

        let reverted = try await engine.call("git.revert", ["file": changes["changes"]?[0] ?? .null], as: JSONValue.self)
        expect((reverted["changes"]?.arrayValue ?? []).isEmpty, "revert restores the file")
        let restored = try await backend.call("read_text_file", ["path": .string(key)], as: String.self)
        expect(restored == original, "file content restored")

        let tabs = try await engine.call("media.tabs", as: JSONValue.self)
        expect(tabs.arrayValue?.isEmpty == false, "media tabs: \(tabs.arrayValue?.compactMap { $0["label"]?.stringValue } ?? [])")

        try await engine.run("repo.close")
        print(failures == 0 ? "native smoke: all checks passed" : "native smoke: \(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }
}
