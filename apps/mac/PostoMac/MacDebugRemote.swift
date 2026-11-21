#if DEBUG
import AppKit
import SwiftUI
import WebKit

/// Debug-only remote control for scripted checks, the macOS counterpart of
/// the iOS demo tour: `-PostoRemote <dir>` polls `<dir>/cmd.json` for one
/// command at a time and answers in `<dir>/result-<id>.json`, writing window
/// snapshots as PNGs there. `-PostoOpen <folder>` opens a folder at launch.
@MainActor
enum MacDebugRemote {
    private static var arguments: [String] { ProcessInfo.processInfo.arguments }

    private static func value(after flag: String) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    static var openPath: String? { value(after: "-PostoOpen") }

    static func run(window: MacWindowState) async {
        guard let dir = value(after: "-PostoRemote") else { return }
        let directory = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? Data("ready".utf8).write(to: directory.appendingPathComponent("ready"))
        let commandURL = directory.appendingPathComponent("cmd.json")
        while !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(150))
            guard let data = try? Data(contentsOf: commandURL),
                  let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            try? FileManager.default.removeItem(at: commandURL)
            let id = command["id"] as? String ?? "0"
            var result: [String: Any] = ["id": id]
            do {
                result["detail"] = try await perform(command, window: window, directory: directory)
                result["ok"] = true
            } catch {
                result["ok"] = false
                result["error"] = "\(error)"
            }
            let out = (try? JSONSerialization.data(withJSONObject: result)) ?? Data()
            let temporary = directory.appendingPathComponent("result-\(id).tmp")
            try? out.write(to: temporary)
            try? FileManager.default.moveItem(at: temporary, to: directory.appendingPathComponent("result-\(id).json"))
        }
    }

    struct Failure: Error, CustomStringConvertible { let description: String }

    private static func perform(_ command: [String: Any], window: MacWindowState, directory: URL) async throws -> String {
        let action = command["action"] as? String ?? ""
        let repo = window.app.repo
        switch action {
        case "open":
            await window.open(command["path"] as? String ?? "")
            return "opened \(window.app.repo?.name ?? "nothing")"
        case "select":
            guard let repo else { throw Failure(description: "no folder open") }
            let needle = (command["file"] as? String ?? "").lowercased()
            func collect(_ nodes: [TreeNode]) -> [TreeFile] { nodes.flatMap { $0.files + collect($0.children) } }
            let files = (repo.view?.looseFiles ?? []) + collect(repo.view?.tree ?? [])
            guard let file = files.first(where: { $0.label.lowercased().contains(needle) || $0.path.lowercased().hasSuffix(needle) })
            else { throw Failure(description: "no file matching \(needle)") }
            repo.selectedKey = file.key
            return "selected \(file.path)"
        case "sidebar":
            window.showSidebar(command["mode"] as? String == "media" ? .media : .files)
            return "sidebar"
        case "toggleSidebar":
            window.toggleSidebar()
            return "toggled"
        case "fullscreen":
            window.toggleFullscreenEditor()
            return "fullscreen \(window.fullscreenEditor)"
        case "publish":
            repo?.openPublish()
            return "publish"
        case "branches":
            repo?.branchesOpen = true
            return "branches"
        case "settings":
            repo?.settingsOpen = true
            return "settings"
        case "deployments":
            window.deploymentsOpen = true
            return "deployments"
        case "quickOpen":
            window.quickOpen = true
            return "quick open"
        case "dismiss":
            repo?.publish = nil
            repo?.branchesOpen = false
            repo?.settingsOpen = false
            window.deploymentsOpen = false
            window.quickOpen = false
            window.recentOpen = false
            // Sheets the remote can't reach (the editor's own): Escape, as
            // their Close buttons answer it.
            for sheet in NSApp.windows.compactMap(\.attachedSheet) {
                if let escape = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                                                 windowNumber: sheet.windowNumber, context: nil, characters: "\u{1b}",
                                                 charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) {
                    sheet.makeKey()
                    sheet.sendEvent(escape)
                }
            }
            try? await Task.sleep(for: .milliseconds(600))
            for sheet in NSApp.windows.compactMap(\.attachedSheet) { sheet.sheetParent?.endSheet(sheet) }
            return "dismissed"
        case "appearance":
            NSApp.appearance = NSAppearance(named: command["value"] as? String == "dark" ? .darkAqua : .aqua)
            return "appearance"
        case "embed":
            // Clicks the nth card or pill of a kind in the body editor.
            let kind = command["kind"] as? String
            let index = command["index"] as? Int ?? 0
            guard let textView = bodyTextView(), let storage = textView.textStorage,
                  let coordinator = textView.delegate as? MarkdownTextView.Coordinator
            else { throw Failure(description: "no body editor") }
            let matches = EmbedProjection.attachments(in: storage).filter { kind == nil || $0.0.embed.kind == kind }
            guard matches.indices.contains(index) else { throw Failure(description: "no embed \(kind ?? "any") #\(index)") }
            coordinator.parent.controller.textView = textView
            coordinator.parent.controller.open(matches[index].0, at: matches[index].1)
            return "opened \(matches[index].0.embed.label)"
        case "reveal":
            // Scrolls the body to the nth card or pill of a kind.
            let kind = command["kind"] as? String
            let index = command["index"] as? Int ?? 0
            guard let textView = bodyTextView(), let storage = textView.textStorage else { throw Failure(description: "no body editor") }
            let matches = EmbedProjection.attachments(in: storage).filter { kind == nil || $0.0.embed.kind == kind }
            guard matches.indices.contains(index) else { throw Failure(description: "no embed \(kind ?? "any") #\(index)") }
            textView.scrollRangeToVisible(matches[index].1)
            return "revealed \(matches[index].0.embed.label)"
        case "type":
            guard let textView = bodyTextView() else { throw Failure(description: "no body editor") }
            textView.window?.makeFirstResponder(textView)
            if command["atEnd"] as? Bool == true { textView.setSelectedRange(NSRange(location: textView.string.utf16.count, length: 0)) }
            textView.insertText(command["text"] as? String ?? "", replacementRange: textView.selectedRange())
            return "typed"
        case "source":
            guard let textView = bodyTextView(), let storage = textView.textStorage else { throw Failure(description: "no body editor") }
            return EmbedProjection.source(of: storage)
        case "click":
            // Navigates from inside the page, as a link click would.
            guard window.preview.isRunning else { throw Failure(description: "no preview") }
            let web = window.preview.webView
            _ = try? await web.evaluateJavaScript("location.href = \(String(reflecting: command["route"] as? String ?? "/"))")
            return "clicked"
        case "navigate":
            window.preview.navigate(to: command["route"] as? String ?? "/")
            return "navigated"
        case "state":
            return "columns: \(window.columns), fullscreen: \(window.fullscreenEditor), preview: \(window.preview.state), route: \(window.preview.route), file: \(repo?.document?.view.path ?? "none"), repo error: \(repo?.view?.error ?? "none"), loading: \(repo?.view?.loading ?? false), candidates: \(repo?.view?.workspaceCandidates?.count ?? -1), root: \(repo?.view?.root ?? "nil"), app error: \(window.app.error ?? "none")"
        case "logs":
            await window.preview.loadLogs()
            return window.preview.logs.suffix(40).joined(separator: "\n")
        case "invoke":
            // A raw backend command, for checking the desktop bridge.
            let args = command["args"] as? [String: Any] ?? [:]
            let json = String(data: try JSONSerialization.data(withJSONObject: args), encoding: .utf8) ?? "{}"
            return await window.app.backend.invoke(command["command"] as? String ?? "", argsJSON: json)
        case "engine":
            // A raw engine call, for checking what the engine hands the views.
            guard let engine = window.app.engine else { throw Failure(description: "no engine") }
            let data = try JSONSerialization.data(withJSONObject: command["args"] as? [String: Any] ?? [:])
            let args = try JSONDecoder().decode([String: JSONValue].self, from: data)
            return await engine.callRaw(command["method"] as? String ?? "", args)
        case "sleep":
            try? await Task.sleep(for: .seconds(command["seconds"] as? Double ?? 1))
            return "slept"
        case "snapshot":
            let name = command["name"] as? String ?? "snapshot"
            return try await snapshot(name: name, directory: directory)
        case "views":
            // The view hierarchy, for checking layout without a screenshot.
            func dump(_ view: NSView, depth: Int, into lines: inout [String]) {
                guard depth < (command["depth"] as? Int ?? 14) else { return }
                let frame = view.convert(view.bounds, to: nil)
                var line = String(repeating: "  ", count: depth) + "\(type(of: view)) \(Int(frame.minX)),\(Int(frame.minY)) \(Int(frame.width))x\(Int(frame.height))"
                if view.isHidden { line += " hidden" }
                if let split = view as? NSSplitView {
                    line += " collapsed=\(split.arrangedSubviews.map { split.isSubviewCollapsed($0) })"
                }
                if let text = view as? NSTextField, !text.stringValue.isEmpty { line += " '\(text.stringValue.prefix(40))'" }
                if let text = view as? NSTextView { line += " text='\(text.string.prefix(40).replacingOccurrences(of: "\n", with: "⏎"))'" }
                lines.append(line)
                for child in view.subviews { dump(child, depth: depth + 1, into: &lines) }
            }
            var lines: [String] = []
            for window in NSApp.windows where window.isVisible {
                lines.append("window '\(window.title)' \(window.frame)")
                if let frameView = window.contentView?.superview { dump(frameView, depth: 1, into: &lines) }
            }
            return lines.joined(separator: "\n")
        case "quit":
            NSApp.terminate(nil)
            return "quitting"
        default:
            throw Failure(description: "unknown action \(action)")
        }
    }

    private static func bodyTextView() -> BodyNSTextView? {
        func find(_ view: NSView) -> BodyNSTextView? {
            if let text = view as? BodyNSTextView, text.window != nil { return text }
            for child in view.subviews { if let found = find(child) { return found } }
            return nil
        }
        for window in NSApp.windows where window.isVisible {
            if let root = window.contentView, let found = find(root) { return found }
        }
        return nil
    }

    /// The window server's image of one of this app's own windows, which
    /// needs no screen-recording access. CGWindowListCreateImage is gone
    /// from the SDK but still in CoreGraphics, so it's looked up at run
    /// time; nil when the screen is locked or the call is unavailable.
    private static func windowServerImage(_ window: NSWindow) -> CGImage? {
        typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
        guard let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW),
              let symbol = dlsym(handle, "CGWindowListCreateImage")
        else { return nil }
        let create = unsafeBitCast(symbol, to: CreateImage.self)
        // kCGWindowListOptionIncludingWindow; boundsIgnoreFraming | bestResolution.
        let image = create(.null, 1 << 3, UInt32(window.windowNumber), (1 << 0) | (1 << 3))?.takeRetainedValue()
        guard let image, image.width > 1, image.height > 1 else { return nil }
        return image
    }

    /// Writes every visible window (sheets separately) as `<name>-<n>.png`:
    /// the window server's image when it gives one, otherwise the window's
    /// layer tree with the preview's web content (a remote layer) drawn in
    /// from a WebKit snapshot. No screen-recording access needed.
    private static func snapshot(name: String, directory: URL) async throws -> String {
        // An occluded window stops drawing; bring it forward first.
        NSApp.activate(ignoringOtherApps: true)
        for window in NSApp.windows where window.isVisible { window.orderFrontRegardless() }
        try? await Task.sleep(for: .milliseconds(700))
        var written: [String] = []
        let windows = NSApp.windows.filter { $0.isVisible && $0.frame.width > 50 && $0.contentView != nil }
        for (index, window) in windows.enumerated() {
            if let image = windowServerImage(window),
               let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) {
                let file = directory.appendingPathComponent("\(name)-\(index).png")
                try png.write(to: file)
                written.append(file.lastPathComponent + (window.sheetParent != nil ? " (sheet)" : ""))
                continue
            }
            guard let frameView = window.contentView?.superview ?? window.contentView, let layer = frameView.layer else { continue }
            let scale = window.backingScaleFactor
            let size = frameView.bounds.size
            guard let context = CGContext(
                data: nil, width: Int(size.width * scale), height: Int(size.height * scale),
                bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { continue }
            context.scaleBy(x: scale, y: scale)
            context.setFillColor(window.backgroundColor.cgColor)
            context.fill(CGRect(origin: .zero, size: size))
            if layer.isGeometryFlipped || frameView.isFlipped {
                context.translateBy(x: 0, y: size.height)
                context.scaleBy(x: 1, y: -1)
            }
            layer.render(in: context)
            if layer.isGeometryFlipped || frameView.isFlipped {
                context.scaleBy(x: 1, y: -1)
                context.translateBy(x: 0, y: -size.height)
            }
            for webView in webViews(in: frameView) {
                guard let web = try? await webView.takeSnapshot(configuration: nil),
                      let cgImage = web.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
                // Window coordinates: origin at the bottom left, as the context.
                let rect = webView.convert(webView.bounds, to: nil)
                context.draw(cgImage, in: rect)
            }
            guard let image = context.makeImage() else { continue }
            let bitmap = NSBitmapImageRep(cgImage: image)
            guard let png = bitmap.representation(using: .png, properties: [:]) else { continue }
            let file = directory.appendingPathComponent("\(name)-\(index).png")
            try png.write(to: file)
            written.append(file.lastPathComponent + (window.sheetParent != nil ? " (sheet)" : ""))
        }
        return written.joined(separator: ", ")
    }

    private static func webViews(in view: NSView) -> [WKWebView] {
        if let web = view as? WKWebView { return [web] }
        return view.subviews.flatMap(webViews(in:))
    }
}
#endif
