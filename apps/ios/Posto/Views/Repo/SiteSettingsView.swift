import SwiftUI

/// Site settings: Deployments, Branch, Media, Switch project, and removing
/// the local copy — the same rows as the Tauri app's settings page. iOS
/// also opens the project's README from here.
struct SiteSettingsView: View {
    @Bindable var repo: RepoModel
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingRemove = false

    var body: some View {
        NavigationStack {
            List {
                if let view = repo.view {
                    Section {
                        #if os(iOS)
                        // The file list leaves the README out on iOS.
                        if let readme = view.readme {
                            Button {
                                repo.settingsOpen = false
                                repo.selectedKey = readme.key
                            } label: {
                                SettingsRow(title: "README", subtitle: readme.name, symbol: "book")
                            }
                            .foregroundStyle(.primary)
                        }
                        #endif
                        if view.repo != nil {
                            NavigationLink {
                                DeploymentsView(repo: repo)
                            } label: {
                                SettingsRow(title: "Deployments", subtitle: "Live GitHub Actions status", symbol: "antenna.radiowaves.left.and.right")
                            }
                        }
                        if let branch = view.branch {
                            Button {
                                // The picker and the branch-conflict alert are
                                // presented by the workspace, which can't while
                                // this sheet is up: close it, then open the picker.
                                repo.settingsOpen = false
                                repo.branchesOpen = true
                            } label: {
                                SettingsRow(title: "Branch", subtitle: branch, symbol: "arrow.triangle.branch")
                            }
                            .rowButtonStyle()
                            .foregroundStyle(.primary)
                        }
                        NavigationLink {
                            MediaView(repo: repo)
                        } label: {
                            SettingsRow(
                                title: "Media",
                                subtitle: view.mediaLibraryCount > 0
                                    ? "\(view.mediaLibraryCount) media \(view.mediaLibraryCount == 1 ? "library" : "libraries") + public"
                                    : "Public media",
                                symbol: "photo.on.rectangle"
                            )
                        }
                        if view.canSwitchProject {
                            NavigationLink {
                                WorkspaceChooserView(repo: repo, candidates: nil, dismissible: true)
                            } label: {
                                SettingsRow(title: "Switch Project", subtitle: view.projectDirectory, symbol: "square.stack.3d.up")
                            }
                        }
                    }
                    #if os(iOS)
                    // Also on the repository list's Settings; the macOS app
                    // has it in its Settings window.
                    Section {
                        Toggle("Developer mode", isOn: Binding(
                            get: { repo.app.developerMode },
                            set: { repo.app.setDeveloperMode($0) }
                        ))
                    } footer: {
                        Text("Shows raw files, collection settings, and schema notices.")
                    }
                    #endif
                    // A folder opened on the Mac is the user's own; only
                    // managed clones can be removed.
                    if !repo.local {
                        Section {
                            Button(role: .destructive) {
                                confirmingRemove = true
                            } label: {
                                Label("Delete from Device", systemImage: "trash")
                                    .foregroundStyle(.red)
                            }
                        } footer: {
                            Text("Removes this repository's downloaded copy from this device. Unpublished changes will be lost. You can download it again anytime.")
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .closeTrailing) {
                    CloseButton("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Delete \(repo.name) from this device?",
                isPresented: $confirmingRemove,
                titleVisibility: .visible
            ) {
                Button("Delete from Device", role: .destructive) {
                    let app = repo.app
                    Task {
                        do {
                            try await app.removeRepo(root: repo.repoRoot)
                        } catch {
                            // The repository has closed: the list shows it.
                            app.error = "Could not delete \(repo.name) from this device: \(error.localizedDescription)"
                        }
                    }
                }
            } message: {
                Text("Unpublished changes will be lost.")
            }
        }
    }
}

struct SettingsRow: View {
    let title: String
    let subtitle: String
    let symbol: String

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        } icon: {
            Image(systemName: symbol)
        }
    }
}

/// Live deployment status: the ring the desktop app shows, full screen.
struct DeploymentsView: View {
    let repo: RepoModel
    @State private var model: DeploymentModel?
    @Environment(\.openURL) private var openURL

    var body: some View {
        let status = model?.status
        let ring = model?.ring ?? status?.ring
        List {
            if let error = model?.error {
                Section { NoticeRow(message: error, systemImage: "exclamationmark.triangle.fill", tint: .red) }
            }
            Section {
                VStack(spacing: 18) {
                    DeploymentRingView(ring: ring)
                        .frame(width: 200, height: 200)
                    VStack(spacing: 4) {
                        Text(statusText(ring?.state)).font(.title3.weight(.semibold))
                        if let status {
                            Text("\(status.owner)/\(status.name) · \(status.branch)")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            }
            Section {
                if let site = status?.siteUrl, let url = URL(string: site) {
                    Button {
                        openURL(url)
                    } label: {
                        Label("Open Site", systemImage: "globe")
                    }
                }
                if let actions = status.flatMap({ URL(string: $0.actionsUrl) }) {
                    Button {
                        openURL(actions)
                    } label: {
                        Label("View on GitHub Actions", systemImage: "arrow.up.right.square")
                    }
                }
            }
        }
        .navigationTitle("Deployments")
        .onAppear {
            let deployments = model ?? DeploymentModel(repo: repo)
            model = deployments
            deployments.start()
        }
        .onDisappear { model?.stop() }
    }

    private func statusText(_ state: String?) -> String {
        switch state {
        case "running": return "Deploying…"
        case "queued": return "Queued"
        case "success": return "Deployed"
        case "failure": return "Deployment failed"
        case nil: return "Checking…"
        default: return "No recent deployments"
        }
    }
}

struct DeploymentRingView: View {
    let ring: DeploymentRing?

    var body: some View {
        let value = (ring?.value ?? 0) / 100
        let color: Color = switch ring?.state {
        case "running": .blue
        case "success": .teal
        case "failure": .red
        default: .gray
        }
        ZStack {
            Circle().stroke(Color.secondary.opacity(0.15), lineWidth: 18)
            Circle()
                .trim(from: 0, to: value)
                .stroke(color, style: StrokeStyle(lineWidth: 18, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeInOut, value: value)
            if ring?.done == true {
                Image(systemName: ring?.success == true ? "checkmark" : "xmark")
                    .font(.system(size: 48, weight: .bold))
                    .foregroundStyle(ring?.success == true ? Color.teal : Color.red)
            } else if ring?.state == "running" {
                Text("\(Int((ring?.value ?? 0).rounded()))%")
                    .font(.title.bold())
                    .contentTransition(.numericText())
            }
        }
    }
}

/// Find or create a branch: search the local and remote list, or create one
/// from the typed (slugified) name.
struct BranchPickerView: View {
    let repo: RepoModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var loading = true

    var body: some View {
        NavigationStack {
            let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
            let filtered = repo.branches.filter { needle.isEmpty || $0.name.lowercased().contains(needle) }
            let slug = slugifyBranchName(query)
            let createName = !slug.isEmpty && !repo.branches.contains { $0.name == slug } ? slug : nil
            List {
                ForEach(filtered) { branch in
                    Button {
                        dismiss()
                        if !branch.current { Task { await repo.switchBranch(branch.name, create: false) } }
                    } label: {
                        HStack {
                            Label {
                                Text(branch.name).foregroundStyle(Color.primary)
                            } icon: {
                                Image(systemName: branch.local ? "laptopcomputer" : "cloud")
                                    .foregroundStyle(Color.secondary)
                            }
                            Spacer()
                            if branch.current { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
                if let createName {
                    Button {
                        dismiss()
                        Task { await repo.switchBranch(createName, create: true) }
                    } label: {
                        Label("Create branch “\(createName)”", systemImage: "plus")
                    }
                }
            }
            .overlay {
                if let error = repo.branchesError, createName == nil {
                    // Typing a name still offers to create the branch.
                    ContentUnavailableView {
                        Label("Couldn't load branches", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try Again") { Task { await load() } }
                            .glassActionStyle()
                    }
                } else if repo.branches.isEmpty && loading {
                    ProgressView()
                } else if filtered.isEmpty && createName == nil {
                    if needle.isEmpty {
                        ContentUnavailableView("No branches", systemImage: "arrow.triangle.branch", description: Text("Type a name to create one."))
                    } else {
                        ContentUnavailableView.search(text: query)
                    }
                }
            }
            .searchable(text: $query, placement: .alwaysVisible, prompt: "Find or create a branch")
            .navigationTitle("Branch")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
            }
            .task { await load() }
        }
        .presentationDetents([.medium, .large])
    }

    private func load() async {
        loading = true
        await repo.loadBranches()
        loading = false
    }
}

/// Lowercase, dashes for spaces, characters git refs disallow removed —
/// `slugifyBranchName` from @posto/editor.
func slugifyBranchName(_ input: String) -> String {
    var value = input.lowercased()
    value = value.replacingOccurrences(of: #"\s+"#, with: "-", options: .regularExpression)
    value = value.replacingOccurrences(of: #"[~^:?*\[\]\\@{}]"#, with: "", options: .regularExpression)
    value = value.replacingOccurrences(of: #"\.{2,}"#, with: ".", options: .regularExpression)
    value = value.replacingOccurrences(of: #"/{2,}"#, with: "/", options: .regularExpression)
    value = value.replacingOccurrences(of: #"-{2,}"#, with: "-", options: .regularExpression)
    value = value.replacingOccurrences(of: #"\.lock$"#, with: "", options: .regularExpression)
    value = value.replacingOccurrences(of: #"^[-./]+|[-./]+$"#, with: "", options: .regularExpression)
    return value
}
