import SwiftUI

struct SignInView: View {
    let app: AppModel
    let switchDemo: (Bool) -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "doc.richtext")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(.tint)
            VStack(spacing: 8) {
                Text("Posto")
                    .font(.largeTitle.bold())
                Text("Connect GitHub to choose a site and edit its documents.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if let error = app.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            VStack(spacing: 12) {
                Button {
                    Task { await app.signIn() }
                } label: {
                    Label("Continue with GitHub", systemImage: "arrow.right.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .prominentActionStyle()
                .controlSize(.large)

                Group {
                    if app.demo {
                        Button("Leave demo mode") { switchDemo(false) }
                    } else {
                        Button("Explore a demo site") { switchDemo(true) }
                    }
                }
                .glassActionStyle(bordered: false)
            }
        }
        .padding(24)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity)
    }
}

struct DeviceCodeView: View {
    let app: AppModel
    @State private var copied = false

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            if let device = app.device {
                Image(systemName: "iphone.and.arrow.forward")
                    .font(.system(size: 48, weight: .light))
                    .foregroundStyle(.tint)
                Text("Enter this code on GitHub")
                    .font(.title2.bold())
                Button {
                    UIPasteboard.general.string = device.userCode
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    HStack(spacing: 12) {
                        Text(device.userCode)
                            .font(.system(.title, design: .monospaced).weight(.semibold))
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)
                    .glassPanel(cornerRadius: 14, interactive: true, fallback: AnyShapeStyle(.quaternary))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy code \(device.userCode)")

                Button {
                    app.browserURL = URL(string: device.verificationURI)
                } label: {
                    Label("Open GitHub", systemImage: "safari")
                        .frame(maxWidth: 320)
                }
                .prominentActionStyle()
                .controlSize(.large)

                Text("Posto will continue automatically after you approve access.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            } else {
                ProgressView()
                Text("Connecting to GitHub")
                    .font(.title2.bold())
                Text("Requesting a one-time sign-in code…")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            CloseButton { app.cancelSignIn() }
        }
        .padding(24)
    }
}
