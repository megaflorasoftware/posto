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
    weak var webView: WKWebView?
    private var root: String?
    private var lastServedRoute: String?
    private var syncTask: Task<Void, Never>?
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
                switch steps[index].id {
                case "node":
                    steps[index].detail = try await backend.call("install_node", as: String.self)
                case "pm":
                    steps[index].detail = try await backend.call("install_package_manager", ["root": .string(root)], as: String.self)
                default:
                    try await backend.run("install_dependencies", ["root": .string(root)])
                    steps[index].detail = "Installed"
                }
                steps[index].ready = true
                guard current == generation else { return }
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
                if (try? await backend.call("ping_dev_server", as: Bool.self)) == true {
                    guard current == generation else { return }
                    state = .running(port: port)
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
        if state != .idle { try? await backend.run("stop_dev_server") }
        state = .idle
    }

    func loadLogs() async {
        logs = (try? await backend.call("get_dev_server_logs", as: [String].self)) ?? []
    }

    // MARK: Routing

    func navigate(to next: String) {
        route = next
        if let url { webView?.load(URLRequest(url: url)) }
    }

    func reload() {
        webView?.reload()
    }

    /// Forward: point the preview at the open file's page, but only when the
    /// server confirms it serves (or it's a file-based page).
    func follow(repo: RepoModel) async {
        guard let match = (try? await repo.engine.call("preview.route", as: FileRoute?.self)) ?? nil,
              match.route != route
        else { return }
        if case .running = state {
            guard (try? await backend.call("fetch_page", ["route": .string(match.route)], as: String.self)) != nil else { return }
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
                guard let served, served != self.route else { continue }
                self.route = served
                if let repo = self.app.repo,
                   let key = (try? await repo.engine.call("preview.fileForRoute", ["route": .string(served)], as: String?.self)) ?? nil,
                   key != repo.selectedKey {
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
            Button { preview.reload() } label: { Image(systemName: "arrow.clockwise") }
                .help("Reload")
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

/// The site, in a WKWebView pointed at the preview proxy.
struct PreviewWebView: NSViewRepresentable {
    let preview: PreviewModel

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.setValue(false, forKey: "drawsBackground")
        preview.webView = webView
        if let url = preview.url { webView.load(URLRequest(url: url)) }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        preview.webView = webView
    }
}
