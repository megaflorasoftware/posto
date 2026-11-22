import SwiftUI

struct RootView: View {
    let app: AppModel
    let switchDemo: (Bool) -> Void
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch app.stage {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .signedOut:
                SignInView(app: app, switchDemo: switchDemo)
            case .authorizing:
                DeviceCodeView(app: app)
            case .repositories:
                if let repo = app.repo {
                    RepoWorkspaceView(repo: repo)
                } else {
                    RepositoriesView(app: app, switchDemo: switchDemo)
                }
            }
        }
        .animation(.default, value: app.stage)
        .task { await app.start() }
        #if DEBUG
        .modifier(DemoTourSheets(app: app))
        #endif
        .sheet(item: Binding(get: { app.browserURL }, set: { app.browserURL = $0 })) { url in
            SafariView(url: url).ignoresSafeArea()
        }
        .onChange(of: scenePhase) { _, phase in
            // The Tauri app re-checks upstream when it returns to the foreground.
            if phase == .active, let repo = app.repo {
                Task { _ = try? await repo.engine.call("git.checkUpstream", as: JSONValue.self) }
            }
            // Swiping the app away in the switcher only takes it to
            // .inactive, so edits are saved there too, not just on .background.
            if phase != .active { saveEdits() }
        }
    }

    /// Writes the open file's pending edits: the debounced typing, then the
    /// engine's own autosave (`doc.flush` saves at once rather than waiting
    /// out its delay). A background task lets the write finish after the
    /// app leaves the screen.
    private func saveEdits() {
        guard let document = app.repo?.document else { return }
        let assertion = BackgroundAssertion(name: "Save edits")
        Task {
            await document.flush()
            assertion.end()
        }
    }
}

/// Keeps the app running briefly after it leaves the screen, until `end()`
/// or until the system runs out of time for it.
@MainActor
private final class BackgroundAssertion {
    private var identifier = UIBackgroundTaskIdentifier.invalid

    init(name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            self?.end()
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
