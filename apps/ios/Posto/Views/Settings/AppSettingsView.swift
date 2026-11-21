import SwiftUI

struct AppSettingsView: View {
    let app: AppModel
    let switchDemo: (Bool) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                if let user = app.user {
                    Section {
                        HStack(spacing: 14) {
                            AvatarView(user: user).frame(width: 44, height: 44).scaleEffect(1.4)
                            VStack(alignment: .leading) {
                                Text(user.name.isEmpty ? user.login : user.name).font(.headline)
                                Text("@\(user.login)").font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
                Section {
                    Toggle("Developer mode", isOn: Binding(
                        get: { app.developerMode },
                        set: { app.setDeveloperMode($0) }
                    ))
                } footer: {
                    Text("Shows raw files, collection settings, and schema notices.")
                }
                if app.demo {
                    Section {
                        Button("Leave demo mode") {
                            dismiss()
                            switchDemo(false)
                        }
                    } footer: {
                        Text("You're exploring sample content; nothing is saved to GitHub.")
                    }
                }
                Section {
                    AsyncButton(role: .destructive) {
                        await app.signOut()
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                            .foregroundStyle(.red)
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
        }
    }
}
