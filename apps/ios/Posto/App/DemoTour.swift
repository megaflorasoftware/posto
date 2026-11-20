#if DEBUG
import SwiftUI
import UIKit

/// Debug-only: `-PostoTour <directory>` walks the demo through each screen
/// and writes a snapshot of the window per step, then quits. Lets the UI be
/// checked from scripts (Mac Catalyst or the simulator) without UI testing.
@MainActor
@Observable
final class DemoTour {
    enum Screen: String, Identifiable {
        case media, deployments
        var id: String { rawValue }
    }

    static let shared = DemoTour()
    var presented: Screen?

    /// Absolute paths are used as given (Mac Catalyst); relative ones land in
    /// the app's Documents folder, where the simulator script collects them.
    var directory: URL? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-PostoTour"), arguments.indices.contains(index + 1) else { return nil }
        let path = arguments[index + 1]
        if path.hasPrefix("/") { return URL(fileURLWithPath: path, isDirectory: true) }
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return documents.appendingPathComponent(path, isDirectory: true)
    }

    func run(app: AppModel) async {
        guard let directory else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var step = 0
        func snap(_ name: String, wait: Double = 1.2) async {
            try? await Task.sleep(for: .seconds(wait))
            step += 1
            write(directory.appendingPathComponent(String(format: "%02d-%@.png", step, name)))
        }

        if ProcessInfo.processInfo.arguments.contains("-PostoTourCompact") {
            // An iPhone-sized window: compact width collapses the split view.
            for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
                scene.sizeRestrictions?.minimumSize = CGSize(width: 390, height: 844)
                scene.sizeRestrictions?.maximumSize = CGSize(width: 390, height: 844)
            }
            try? await Task.sleep(for: .seconds(1))
        }

        if ProcessInfo.processInfo.arguments.contains("-PostoTourDark") {
            for window in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows) {
                window.overrideUserInterfaceStyle = .dark
            }
        }

        await waitFor { app.stage != .loading }
        await snap("sign-in")
        if app.stage == .signedOut {
            await app.signIn()
        }
        await waitFor { app.stage == .repositories && !app.repos.isEmpty }
        await snap("repositories")

        guard let repo = app.repos.first(where: { app.managedRepo(for: $0) != nil }) else { return finish() }
        await app.choose(repo)
        guard let model = app.repo else { return finish() }
        await waitFor { model.view?.loading == false }
        await snap("sidebar")

        if let file = model.view?.tree.first(where: { $0.label == "Writing" })?.files.first ?? model.view?.tree.first?.files.first {
            model.selectedKey = file.key
            await waitFor { model.document != nil }
            await snap("editor", wait: 1.5)
        }

        model.selectedKey = nil
        try? await Task.sleep(for: .seconds(0.8))
        if let index = model.view?.looseFiles.first(where: { $0.name == "index.md" }) {
            model.selectedKey = index.key
            await waitFor { model.document?.key == index.key }
            await snap("body-editor", wait: 1.5)
        }

        model.openPublish()
        await snap("publish", wait: 1.5)
        model.publish = nil

        model.settingsOpen = true
        await snap("site-settings")
        model.settingsOpen = false

        try? await Task.sleep(for: .seconds(0.8))
        presented = .media
        await snap("media", wait: 2)
        presented = .deployments
        await snap("deployments", wait: 2)
        presented = nil

        model.branchesOpen = true
        await snap("branches", wait: 1.5)
        model.branchesOpen = false
        finish()
    }

    private func finish() {
        // Tells scripts waiting on the tour that every snapshot is written.
        if let directory { try? Data().write(to: directory.appendingPathComponent("done")) }
        Task {
            try? await Task.sleep(for: .seconds(0.5))
            exit(0)
        }
    }

    private func waitFor(timeout: Double = 15, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    /// Writes the window, and the topmost sheet on its own (Mac Catalyst
    /// draws sheets outside the window's hierarchy).
    private func write(_ url: URL) {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return }
        render(window, to: url)
        var top = window.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        if let sheet = top, sheet !== window.rootViewController, let view = sheet.view {
            render(view, to: url.deletingPathExtension().appendingPathExtension("sheet.png"))
        }
    }

    private func render(_ view: UIView, to url: URL) {
        let renderer = UIGraphicsImageRenderer(bounds: view.bounds)
        let image = renderer.image { context in
            if !view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) {
                view.layer.render(in: context.cgContext)
            }
        }
        try? image.pngData()?.write(to: url)
    }
}

struct DemoTourSheets: ViewModifier {
    let app: AppModel
    @State private var tour = DemoTour.shared

    func body(content: Content) -> some View {
        content
            .sheet(item: $tour.presented) { screen in
                NavigationStack {
                    if let repo = app.repo {
                        switch screen {
                        case .media: MediaView(repo: repo)
                        case .deployments: DeploymentsView(repo: repo)
                        }
                    }
                }
            }
            .task { await tour.run(app: app) }
    }
}
#endif
