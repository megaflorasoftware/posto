import SwiftUI
import WebKit

/// The site preview, as the desktop app's preview pane runs it: checks Node,
/// the package manager and dependencies (installing on one click), starts the
/// dev server behind the backend's proxy, follows the open file to its page,
/// and opens the file for a page the user browses to.
@MainActor
@Observable
final class PreviewModel {
    enum State: Equatable {
        case idle
        case checking
        /// Something must be installed first; waits for Install.
        case needsInstall
        case installing(String)
        case starting
        case running(port: Int)
        case failed(String)
    }

    struct Step: Equatable, Identifiable {
        let id: String
        let label: String
        var detail: String
        var ready: Bool
    }

    private struct EnvCheck: Decodable {
        let nodeVersion: String?
        let packageManager: String
        let packageManagerVersion: String?
        let needsNodeModules: Bool

        enum CodingKeys: String, CodingKey {
            case nodeVersion = "node_version"
            case packageManager = "package_manager"
            case packageManagerVersion = "package_manager_version"
            case needsNodeModules = "needs_node_modules"
        }
    }

    private struct FileRoute: Decodable {
        let route: String
        let certain: Bool
    }

    let app: AppModel
    private(set) var state: State = .idle
    private(set) var steps: [Step] = []
    private(set) var logs: [String] = []
    /// The page the preview shows (or will, once the server is up).
    private(set) var route = "/"
    /// One web view for the window's life: the pane can come and go (the
    /// full-screen editor, a failed start) without reloading the page.
    let webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.setValue(false, forKey: "drawsBackground")
        return webView
    }()
    /// The project the preview serves.
    private(set) var root: String?
    private var lastServedRoute: String?
    private var syncTask: Task<Void, Never>?
    /// A file opened because the preview moved to its page: it doesn't move
    /// the preview again (the two would fight), as on desktop.
    private var openedByPreview: String?
    /// Bumped by every start and stop, so a superseded start stops changing
    /// state when its awaits return.
    private var generation = 0

    init(app: AppModel) {
        self.app = app
    }

    private var backend: Backend { app.backend }

    var url: URL? {
        guard case .running(let port) = state else { return nil }
        return URL(string: "http://localhost:\(port)\(route)")
    }

    var isRunning: Bool {
        if case .running = state { return true }
        return false
    }

    /// Checking, installing or starting: Restart would race the setup.
    var isBusy: Bool {
        switch state {
        case .checking, .installing, .starting: return true
        default: return false
        }
    }

    // MARK: Server

    func start(root: String) async {
        generation += 1
        let current = generation
        self.root = root
        route = "/"
        state = .checking
        logs = []
        do {
            let env = try await backend.call("check_environment", ["root": .string(root)], as: EnvCheck.self)
            guard current == generation else { return }
            steps = [
                Step(id: "node", label: "Node.js", detail: env.nodeVersion ?? "Not found — will be installed", ready: env.nodeVersion != nil),
                Step(id: "pm", label: "Package manager (\(env.packageManager))", detail: env.packageManagerVersion ?? "Not found — will be installed", ready: env.packageManagerVersion != nil),
                Step(id: "deps", label: "Project dependencies", detail: env.needsNodeModules ? "Will be installed" : "Installed", ready: !env.needsNodeModules),
            ]
            if steps.allSatisfy(\.ready) {
                await startServer(current)
            } else {
                state = .needsInstall
            }
        } catch {
            if current == generation { state = .failed(error.localizedDescription) }
        }
    }

    /// Installs whatever is missing, in order, then starts the server.
    func install() async {
        guard let root else { return }
        let current = generation
        do {
            for index in steps.indices where !steps[index].ready {
                state = .installing(steps[index].label)
                let detail: String
                switch steps[index].id {
                case "node":
                    detail = try await backend.call("install_node", as: String.self)
                case "pm":
                    detail = try await backend.call("install_package_manager", ["root": .string(root)], as: String.self)
                default:
                    try await backend.run("install_dependencies", ["root": .string(root)])
                    detail = "Installed"
                }
                // A restart meanwhile has its own checklist.
                guard current == generation, steps.indices.contains(index) else { return }
                steps[index].detail = detail
                steps[index].ready = true
            }
            await startServer(current)
        } catch {
            if current == generation { state = .failed(error.localizedDescription) }
        }
    }

    private func startServer(_ current: Int) async {
        guard let root, current == generation else { return }
        state = .starting
        do {
            let port = try await backend.call("start_dev_server", ["root": .string(root)], as: Int.self)
            let deadline = Date().addingTimeInterval(60)
            while Date() < deadline {
                guard current == generation else { return }
                // A server that exits early fails the ping with its status;
                // show that (and its logs) now rather than at the deadline.
                if try await backend.call("ping_dev_server", as: Bool.self) {
                    guard current == generation else { return }
                    state = .running(port: port)
                    webView.load(URLRequest(url: url!))
                    startRouteSync()
                    if let repo = app.repo { await follow(repo: repo) }
                    return
                }
                try await Task.sleep(for: .milliseconds(500))
            }
            guard current == generation else { return }
            await loadLogs()
            state = .failed("The dev server did not start within 60 seconds.")
        } catch {
            guard current == generation else { return }
            await loadLogs()
            state = .failed(error.localizedDescription)
        }
    }

    func restart() async {
        guard let root else { return }
        await stop()
        await start(root: root)
    }

    func stop() async {
        generation += 1
        syncTask?.cancel()
        syncTask = nil
        let wasRunning = state != .idle
        state = .idle
        root = nil
        if wasRunning {
            webView.load(URLRequest(url: URL(string: "about:blank")!))
            try? await backend.run("stop_dev_server")
        }
    }

    func loadLogs() async {
        logs = (try? await backend.call("get_dev_server_logs", as: [String].self)) ?? []
    }

    // MARK: Routing

    func navigate(to next: String) {
        route = next
        if let url { webView.load(URLRequest(url: url)) }
    }

    func reload() {
        webView.reload()
    }

    /// `/blog/` and `/blog` are one page (the engine's routesEqual).
    private static func same(_ a: String, _ b: String) -> Bool {
        func trimmed(_ route: String) -> String {
            var route = route
            while route.count > 1 && route.hasSuffix("/") { route.removeLast() }
            return route
        }
        return trimmed(a) == trimmed(b)
    }

    /// Forward: point the preview at the open file's page, but only when the
    /// server confirms it serves (or it's a file-based page), and the file is
    /// still the open one by then.
    func follow(repo: RepoModel) async {
        let key = repo.document?.key
        if let key, key == openedByPreview {
            openedByPreview = nil
            return
        }
        guard let match = (try? await repo.engine.call("preview.route", as: FileRoute?.self)) ?? nil,
              !Self.same(match.route, route), repo.document?.key == key
        else { return }
        if isRunning {
            guard (try? await backend.call("fetch_page", ["route": .string(match.route)], as: String.self)) != nil,
                  repo.document?.key == key
            else { return }
        } else if !match.certain {
            return
        }
        navigate(to: match.route)
    }

    /// Reverse: the dev server logs each page it serves; when that changes
    /// because the user clicked around the preview, open the page's file.
    private func startRouteSync() {
        syncTask?.cancel()
        lastServedRoute = nil
        syncTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(700))
                guard let self, !Task.isCancelled else { return }
                let served = (try? await self.backend.call("get_last_route", as: String?.self)) ?? nil
                guard served != self.lastServedRoute else { continue }
                self.lastServedRoute = served
                guard let served, !Self.same(served, self.route) else { continue }
                self.route = served
                if let repo = self.app.repo,
                   let key = (try? await repo.engine.call("preview.fileForRoute", ["route": .string(served)], as: String?.self)) ?? nil,
                   key != repo.selectedKey {
                    self.openedByPreview = key
                    repo.selectedKey = key
                }
            }
        }
    }
}

/// The preview pane: a setup checklist until the dev server runs, then the
/// site, with navigation and server controls in its header.
struct PreviewPane: View {
    let window: MacWindowState
    let preview: PreviewModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Button { preview.navigate(to: "/") } label: { Image(systemName: "house") }
                .help("Home")
                .disabled(!preview.isRunning)
            Button { preview.reload() } label: { Image(systemName: "arrow.clockwise") }
                .help("Reload")
                .disabled(!preview.isRunning)
            Text(preview.route)
                .font(.callout.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.quaternary.opacity(0.6), in: .rect(cornerRadius: 6))
            Button {
                if let url = preview.url { NSWorkspace.shared.open(url) }
            } label: {
                Image(systemName: "safari")
            }
            .help("Open in browser")
            .disabled(preview.url == nil)
            Button {
                Task { await preview.restart() }
            } label: {
                Image(systemName: "power")
            }
            .help("Restart the dev server")
            .disabled(preview.isBusy || preview.root == nil)
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
    }

    @ViewBuilder
    private var content: some View {
        switch preview.state {
        case .running:
            PreviewWebView(preview: preview)
        case .idle:
            ContentUnavailableView("Preview", systemImage: "globe", description: Text("The site preview starts when a folder opens."))
        case .checking, .starting, .installing:
            VStack(spacing: 14) {
                ProgressView()
                Text(progressText).foregroundStyle(.secondary)
                checklist
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .needsInstall:
            VStack(spacing: 16) {
                Text("Set up the preview").font(.title3.bold())
                checklist
                AsyncButton("Install") { await preview.install() }
                    .prominentActionStyle()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            VStack(spacing: 12) {
                ContentUnavailableView("The preview couldn't start", systemImage: "exclamationmark.triangle", description: Text(message))
                    .frame(maxHeight: 220)
                if !preview.logs.isEmpty {
                    ScrollView {
                        Text(preview.logs.suffix(80).joined(separator: "\n"))
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                    }
                    .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 8))
                    .padding(.horizontal)
                }
                AsyncButton("Try Again") { await preview.restart() }
                    .glassActionStyle()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.bottom)
        }
    }

    private var progressText: String {
        switch preview.state {
        case .checking: return "Checking the project…"
        case .installing(let step): return "Installing \(step)…"
        default: return "Starting the dev server…"
        }
    }

    @ViewBuilder
    private var checklist: some View {
        if !preview.steps.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(preview.steps) { step in
                    HStack(spacing: 8) {
                        Image(systemName: step.ready ? "checkmark.circle.fill" : "circle.dashed")
                            .foregroundStyle(step.ready ? Color.green : Color.secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(step.label)
                            Text(step.detail).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .frame(width: 280, alignment: .leading)
        }
    }
}

/// The site, in the preview's one WKWebView (pointed at the preview proxy).
struct PreviewWebView: NSViewRepresentable {
    let preview: PreviewModel

    func makeNSView(context: Context) -> WKWebView {
        preview.webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}
}
