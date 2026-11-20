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
        .sheet(item: Binding(get: { app.browserURL }, set: { app.browserURL = $0 })) { url in
            SafariView(url: url).ignoresSafeArea()
        }
        .onChange(of: scenePhase) { _, phase in
            // The Tauri app re-checks upstream when it returns to the foreground.
            if phase == .active, let repo = app.repo {
                Task { _ = try? await repo.engine.call("git.checkUpstream", as: JSONValue.self) }
            }
            if phase == .background { Task { await app.repo?.document?.flush() } }
        }
    }
}
