import SwiftUI

@main
struct PostoApp: App {
    @State private var root = RootModel()

    var body: some Scene {
        WindowGroup {
            RootView(app: root.app, switchDemo: root.setDemo)
                .id(ObjectIdentifier(root.app))
        }
    }
}

/// Holds the app model; demo mode swaps in a model backed by the engine's
/// in-memory fixture backend instead of the Rust bridge.
@MainActor
@Observable
final class RootModel {
    private static let demoKey = "posto.native.demo"
    private(set) var app: AppModel

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let demo = arguments.contains("-PostoDemo") || UserDefaults.standard.bool(forKey: Self.demoKey)
        app = AppModel(demo: demo)
    }

    func setDemo(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: Self.demoKey)
        Task {
            await app.closeRepo()
            app = AppModel(demo: enabled)
        }
    }
}
