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
                    Task {
                        do {
                            try await repo.app.removeRepo(root: repo.repoRoot)
                        } catch {
                            repo.openError = "Could not remove the repository: \(error.localizedDescription)"
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

/// Live deployment status: the ring the desktop app shows, full screen. The
/// site and GitHub Actions links stay even when runs can't be listed.
struct DeploymentsView: View {
    let repo: RepoModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        let deployments = repo.deployments
        let status = deployments.status
        let ring = deployments.ring ?? status?.ring
        let unavailable = status?.error != nil && !deployments.hasRuns
        List {
            if let error = deployments.error ?? status?.error {
                Section {
                    NoticeRow(
                        message: deployments.hasRuns ? "Couldn't refresh deployments: \(error)" : error,
                        systemImage: "exclamationmark.triangle.fill",
                        tint: .red
                    )
                }
            }
            Section {
                VStack(spacing: 18) {
                    DeploymentRingView(ring: unavailable ? nil : ring)
                        .frame(width: 200, height: 200)
                    VStack(spacing: 4) {
                        Text(unavailable ? "Deployments unavailable" : deploymentStateText(ring?.state))
                            .font(.title3.weight(.semibold))
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
                if let actions = actionsURL(status) {
                    Button {
                        openURL(actions)
                    } label: {
                        Label("View on GitHub Actions", systemImage: "arrow.up.right.square")
                    }
                }
            }
        }
        .navigationTitle("Deployments")
        .refreshable { await deployments.refresh() }
        .onAppear { deployments.watch() }
        .onDisappear { deployments.unwatch() }
    }

    /// From the status, or before it arrives (or when it can't), from the
    /// repository itself.
    private func actionsURL(_ status: DeploymentStatus?) -> URL? {
        if let status { return URL(string: status.actionsUrl) }
        guard repo.hasRemote, repo.view?.repo != nil else { return nil }
        return URL(string: "https://github.com/\(repo.github.owner)/\(repo.github.name)/actions")
    }
}

struct DeploymentRingView: View {
    let ring: DeploymentRing?
    /// The small ring by the Publish button: thinner, with no percentage.
    var compact = false

    var body: some View {
        let value = (ring?.value ?? 0) / 100
        let lineWidth: CGFloat = compact ? 3 : 18
        ZStack {
            Circle().stroke(Color.secondary.opacity(compact ? 0.25 : 0.15), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: value)
                .stroke(deploymentRingColor(ring?.state), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeInOut, value: value)
            if ring?.done == true {
                Image(systemName: ring?.success == true ? "checkmark" : "xmark")
                    .font(.system(size: compact ? 10 : 48, weight: .bold))
                    .foregroundStyle(ring?.success == true ? Color.teal : Color.red)
            } else if ring?.state == "running" && !compact {
                Text("\(Int((ring?.value ?? 0).rounded()))%")
                    .font(.title.bold())
                    .contentTransition(.numericText())
            }
        }
        .padding(compact ? lineWidth / 2 : 0)
    }
}

func deploymentRingColor(_ state: String?) -> Color {
    switch state {
    case "running": .blue
    case "success": .teal
    case "failure": .red
    default: .gray
    }
}

/// The macOS Deployments toolbar button's label: the live ring once there's
/// a run to draw, as the desktop app's header shows it. It keeps the status
/// polling while the window shows it, as the desktop app does.
struct DeploymentToolbarLabel: View {
    let repo: RepoModel

    var body: some View {
        let deployments = repo.deployments
        let ring = deployments.ring ?? deployments.status?.ring
        Label {
            Text("Deployments")
        } icon: {
            if deployments.hasRuns {
                DeploymentRingView(ring: ring, compact: true)
                    .frame(width: 16, height: 16)
            } else {
                Image(systemName: "antenna.radiowaves.left.and.right")
            }
        }
        .help(deployments.hasRuns ? deploymentStateText(ring?.state) : "Deployments")
        .onAppear { deployments.watch() }
        .onDisappear { deployments.unwatch() }
    }
}

/// The repository's deployment as a small ring that opens Deployments, as
/// the desktop app's header shows it. Shown once there's a run to draw.
struct DeploymentBadge: View {
    let repo: RepoModel
    @State private var showingDeployments = false

    var body: some View {
        let deployments = repo.deployments
        let ring = deployments.ring ?? deployments.status?.ring
        if repo.view?.repo != nil && deployments.hasRuns {
            Button {
                showingDeployments = true
            } label: {
                DeploymentRingView(ring: ring, compact: true)
                    .frame(width: 26, height: 26)
                    .padding(9)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Deployment status")
            .accessibilityValue(deploymentStateText(ring?.state))
            .help(deploymentStateText(ring?.state))
            .sheet(isPresented: $showingDeployments) {
                NavigationStack {
                    DeploymentsView(repo: repo)
                        .toolbar {
                            ToolbarItem(placement: .closeTrailing) {
                                CloseButton("Done") { showingDeployments = false }
                            }
                        }
                }
                .macSheetSizing()
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
                if filtered.isEmpty && createName == nil && !repo.branches.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else if repo.branches.isEmpty {
                    ProgressView()
                }
            }
            .searchable(text: $query, placement: .alwaysVisible, prompt: "Find or create a branch")
            .navigationTitle("Branch")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
            }
            .task { await repo.loadBranches() }
        }
        .presentationDetents([.medium, .large])
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
