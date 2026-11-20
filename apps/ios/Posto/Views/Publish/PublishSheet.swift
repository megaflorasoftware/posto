import SwiftUI

/// Publish: the files the commit will include (each revertible), what
/// happens to CDN media, a commit message, and progress while it runs.
struct PublishSheet: View {
    @Bindable var model: PublishModel
    @Environment(\.dismiss) private var dismiss
    @State private var showChanges = false
    @State private var confirmingDelete: ChangedFile?

    var body: some View {
        NavigationStack {
            let view = model.view
            Form {
                if let scope = view?.scopeLabel {
                    Section {
                        Label("Showing changes in \(scope)", systemImage: "folder").font(.subheadline)
                    }
                }
                changesSection(view)
                mediaSection(view)
                if let failure = view?.publishError {
                    Section {
                        NoticeRow(message: failure, systemImage: "xmark.octagon.fill", tint: .red)
                    }
                }
                if let request = view?.credentialRequest {
                    CredentialFormSection(request: request, purpose: .upload) { credential in
                        Task { await model.submitCredential(credential) }
                    }
                } else {
                    Section {
                        TextField("Commit message", text: $model.message)
                            .disabled(view?.publishing == true)
                    } header: {
                        Text("Commit message")
                    }
                    if let stage = view?.stage {
                        Section {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(stage.label).font(.subheadline)
                                if let progress = stage.progress {
                                    ProgressView(value: progress)
                                } else {
                                    ProgressView().frame(maxWidth: .infinity)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Publish")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(view?.publishing == true && view?.credentialRequest == nil)
                }
                ToolbarItem(placement: .confirmationAction) {
                    AsyncButton {
                        if await model.publish() { dismiss() }
                    } label: {
                        Text("Publish").bold()
                    }
                    .disabled(!model.canPublish)
                }
            }
            .interactiveDismissDisabled(view?.publishing == true)
            .confirmationDialog(
                "Delete \(confirmingDelete?.path.lastPathComponent ?? "file")?",
                isPresented: Binding(get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } }),
                titleVisibility: .visible,
                presenting: confirmingDelete
            ) { file in
                Button("Delete New File", role: .destructive) {
                    Task { await model.revert(file) }
                }
            } message: { _ in
                Text("This file hasn't been published, so deleting it can't be undone.")
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func changesSection(_ view: PublishView?) -> some View {
        Section {
            if let error = view?.changesError {
                NoticeRow(message: "Could not read changes: \(error)", systemImage: "exclamationmark.triangle.fill", tint: .red)
            } else if model.loading || view?.changes == nil || (view?.planning == true && view?.changes?.isEmpty != false) {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(view?.planning == true ? "Checking images…" : "Loading changes…").foregroundStyle(.secondary)
                }
            } else if let changes = model.shownChanges, !changes.isEmpty {
                DisclosureGroup(isExpanded: $showChanges) {
                    ForEach(changes) { file in
                        ChangeRow(file: file)
                            .swipeActions {
                                if model.canRevert(file) && view?.publishing != true {
                                    Button(role: file.status == "??" ? .destructive : nil) {
                                        if file.status == "??" { confirmingDelete = file } else { Task { await model.revert(file) } }
                                    } label: {
                                        Label(file.status == "??" ? "Delete" : "Revert", systemImage: file.status == "??" ? "trash" : "arrow.uturn.backward")
                                    }
                                    .tint(file.status == "??" ? .red : .orange)
                                }
                            }
                    }
                } label: {
                    Label("\(changes.count) changed \(changes.count == 1 ? "file" : "files")", systemImage: "doc.on.doc")
                }
            } else {
                Text(view?.hasMediaWork == true ? "No other changes." : "No changes to publish.")
                    .foregroundStyle(.secondary)
            }
        } footer: {
            if model.shownChanges?.isEmpty == false {
                Text("Swipe a file to revert it.")
            }
        }
    }

    @ViewBuilder
    private func mediaSection(_ view: PublishView?) -> some View {
        if let view {
            if let planError = view.planError {
                Section {
                    NoticeRow(message: "Could not check images: \(planError)", systemImage: "exclamationmark.triangle.fill", tint: .red)
                }
            } else if view.hasMediaWork || !view.blockers.isEmpty || !view.keptNotes.isEmpty {
                Section("Media") {
                    ForEach(view.uploadNotes, id: \.self) { note in
                        NoticeRow(message: note, systemImage: "icloud.and.arrow.up")
                    }
                    if let deleteNote = view.deleteNote {
                        NoticeRow(message: deleteNote, systemImage: "icloud.slash")
                    }
                    ForEach(view.blockers, id: \.self) { blocker in
                        NoticeRow(message: blocker, systemImage: "xmark.octagon.fill", tint: .red)
                    }
                    ForEach(view.keptNotes, id: \.self) { note in
                        NoticeRow(message: note, systemImage: "info.circle", tint: .secondary)
                    }
                }
            }
        }
    }
}

private struct ChangeRow: View {
    let file: ChangedFile

    var body: some View {
        let badge = file.badge
        HStack(spacing: 10) {
            Text(badge.label)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(color(badge.label).opacity(0.18), in: .capsule)
                .foregroundStyle(color(badge.label))
            Text(file.path)
                .font(.footnote.monospaced())
                .lineLimit(1)
                .truncationMode(.head)
        }
    }

    private func color(_ label: String) -> Color {
        switch label {
        case "new", "added": return .green
        case "modified": return .orange
        case "deleted": return .red
        case "renamed": return .blue
        default: return .gray
        }
    }
}

/// Asks for a CDN source's password, saved in this device's keychain.
struct CredentialFormSection: View {
    enum Purpose { case upload, browse }

    let request: CredentialRequest
    let purpose: Purpose
    let onSubmit: (JSONValue?) -> Void
    @State private var accessKeyId = ""
    @State private var secret = ""

    var body: some View {
        let source = request.source
        let isS3 = source.provider == "s3"
        Section {
            if isS3 {
                TextField("Access key ID", text: $accessKeyId)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Secret access key", text: $secret)
            } else {
                SecureField("Storage zone password", text: $secret)
            }
            HStack {
                Button("Cancel", role: .cancel) { onSubmit(nil) }
                Spacer()
                Button(purpose == .upload ? "Save and Continue" : "Save and Browse") {
                    var credential: [String: JSONValue] = ["secret": .string(secret)]
                    if isS3 { credential["accessKeyId"] = .string(accessKeyId) }
                    onSubmit(.object(credential))
                }
                .buttonStyle(.borderedProminent)
                .disabled(secret.isEmpty || (isS3 && accessKeyId.isEmpty))
            }
        } header: {
            Text(source.displayName)
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let error = request.error { Text(error).foregroundStyle(.red) }
                Text(isS3
                    ? "Enter the access key for the \(source.bucket) bucket. It's saved in this device's keychain."
                    : "Enter the password for the \(source.bucket) storage zone. It's saved in this device's keychain.")
            }
        }
    }
}
