import SwiftUI

/// The sheets the editor's Site menu opens.
enum SiteSheet: String, Identifiable {
    case seo
    case deployments

    var id: String { rawValue }
}

/// The editor's Site menu: the open page on the live site, its search and
/// social preview, and (on iOS, where an iPhone's editor covers the
/// sidebar) Publish and the deployment it starts.
struct SiteMenu: View {
    let document: DocumentModel
    /// Gives up the body's keyboard before anything presents over it.
    let endEditing: @MainActor () -> Void
    let present: (SiteSheet) -> Void
    @State private var page: SitePage?
    @Environment(\.openURL) private var openURL

    /// What the page's address and notes depend on.
    private struct PageKey: Equatable {
        let file: String
        let siteUrlVersion: Int
        let canPublish: Bool?
    }

    var body: some View {
        let repo = document.repo
        // Known not to be on the site (no address, or not a page): say why
        // in the item rather than open nothing.
        let unavailable = page != nil && page?.url == nil
        Menu {
            Section {
                Button {
                    Task { await viewOnSite() }
                } label: {
                    Text("View on Site")
                    if let note = page?.shortNote { Text(note) }
                    Image(systemName: "safari")
                }
                .disabled(unavailable)
                Button {
                    endEditing()
                    present(.seo)
                } label: {
                    Text("Search & Social Preview")
                    Image(systemName: "text.magnifyingglass")
                }
                .disabled(unavailable)
            }
            #if os(iOS)
            Section {
                let git = repo.view?.git
                Button {
                    endEditing()
                    repo.openPublish()
                } label: {
                    Text(git?.publishing == true ? "Publishing…" : git?.canPublish == true ? "Publish…" : "Up to Date")
                    Image(systemName: "paperplane")
                }
                .disabled(git?.canPublish != true || git?.publishing == true || git?.checkingChanges == true)
                if repo.view?.repo != nil {
                    let deployments = repo.deployments
                    Button {
                        endEditing()
                        present(.deployments)
                    } label: {
                        Text("Deployments")
                        if deployments.unavailable {
                            Text("Deployments unavailable")
                        } else if deployments.status != nil {
                            Text(deploymentStateText((deployments.ring ?? deployments.status?.ring)?.state))
                        }
                        Image(systemName: "antenna.radiowaves.left.and.right")
                    }
                }
            }
            #endif
        } label: {
            Label("Site", systemImage: "globe")
        }
        .task(id: PageKey(file: document.key, siteUrlVersion: repo.siteUrlVersion, canPublish: repo.view?.git.canPublish)) {
            page = try? await repo.engine.call("site.page")
        }
    }

    /// Opens the page in the in-app browser (the default browser on macOS),
    /// with the address worked out afresh.
    private func viewOnSite() async {
        endEditing()
        if let fresh: SitePage = try? await document.repo.engine.call("site.page") { page = fresh }
        guard let url = page?.pageURL else { return }
        #if os(iOS)
        document.repo.app.browserURL = url
        #else
        openURL(url)
        #endif
    }
}

/// A Site menu sheet, on its own navigation stack.
struct SiteSheetView: View {
    let sheet: SiteSheet
    let repo: RepoModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        switch sheet {
        case .seo:
            SeoPreviewView(repo: repo)
        case .deployments:
            NavigationStack {
                DeploymentsView(repo: repo)
                    .toolbar {
                        ToolbarItem(placement: .closeTrailing) { CloseButton("Done") { dismiss() } }
                    }
            }
        }
    }
}

// MARK: - Search and social preview

/// The open page's search result and social cards, from the page the live
/// site serves now: what people see when it's shared, labeled as such,
/// with notes when the file has unpublished changes or its address is a
/// guess. (The desktop app reads the same tags from its local dev server.)
struct SeoPreviewView: View {
    let repo: RepoModel
    @Environment(\.dismiss) private var dismiss
    @State private var page: SitePage?
    @State private var preview: SeoPreview?
    @State private var shownURL: URL?
    @State private var fetchedAt: Date?
    @State private var error: String?
    @State private var loading = false
    @State private var browsing: URL?

    var body: some View {
        NavigationStack {
            List {
                pageSection
                if let error {
                    Section {
                        NoticeRow(message: error, systemImage: "exclamationmark.triangle.fill", tint: .orange)
                    }
                }
                if let preview { cards(preview) }
            }
            .groupedListStyle()
            .overlay {
                if loading && preview == nil && error == nil { ProgressView() }
            }
            .navigationTitle("Search & Social")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .closeTrailing) { CloseButton("Done") { dismiss() } }
            }
            .refreshable { await load() }
            .task { await load() }
            .modifier(LinkBrowser(url: $browsing))
        }
        .presentationDetents([.large])
    }

    @ViewBuilder
    private var pageSection: some View {
        Section {
            if let url = shownURL ?? page?.pageURL {
                Button {
                    browsing = url
                } label: {
                    Label {
                        Text(url.absoluteString).lineLimit(2).truncationMode(.middle)
                    } icon: {
                        Image(systemName: "safari")
                    }
                }
            }
            ForEach(page?.notes ?? [], id: \.self) { note in
                NoticeRow(message: note, systemImage: "info.circle", tint: .secondary)
            }
            if page?.pageURL != nil {
                AsyncButton {
                    await load()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(loading)
            }
        } header: {
            Text("As Published")
        } footer: {
            if let fetchedAt {
                Text("These previews come from the page the live site serves, fetched at \(fetchedAt.formatted(date: .omitted, time: .shortened)).")
            } else {
                Text("These previews come from the page the live site serves.")
            }
        }
    }

    @ViewBuilder
    private func cards(_ preview: SeoPreview) -> some View {
        Section("Google") {
            GoogleResultCard(preview: preview)
        }
        Section {
            SocialCard(preview: preview, text: preview.card, style: .large)
        } header: {
            Text("X — Large Card")
        } footer: {
            if let card = preview.twitterCard, card != "summary_large_image" {
                Text("The page's twitter:card is “\(card)”, so X shows the small card.")
            }
        }
        Section("X — Small Card") {
            SocialCard(preview: preview, text: preview.card, style: .small)
        }
        Section("Facebook / Open Graph") {
            SocialCard(preview: preview, text: preview.facebook, style: .facebook)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        error = nil
        do {
            page = try await repo.engine.call("site.page", as: SitePage.self)
        } catch {
            self.error = error.localizedDescription
            return
        }
        guard let page, let url = page.pageURL else {
            // The notes say why there's no page to fetch.
            preview = nil
            shownURL = nil
            fetchedAt = nil
            return
        }
        do {
            let fetched = try await PageFetcher.fetch(url)
            preview = try await repo.engine.call("seo.preview", [
                "html": .string(fetched.html), "url": .string(fetched.url.absoluteString),
            ])
            shownURL = fetched.url
            fetchedAt = Date()
        } catch {
            preview = nil
            fetchedAt = nil
            self.error = PageFetcher.message(for: error, page: page)
        }
    }
}

/// A Google search result for the page.
private struct GoogleResultCard: View {
    let preview: SeoPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Thumbnail(url: preview.favicon, maxPixels: 96, placeholder: "globe")
                    .frame(width: 28, height: 28)
                    .clipShape(.circle)
                VStack(alignment: .leading, spacing: 1) {
                    Text(preview.siteName).font(.subheadline)
                    Text(preview.breadcrumb)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            if let title = preview.google.title {
                Text(title).font(.title3).foregroundStyle(.blue)
            } else {
                MissingTag(what: "<title>")
            }
            if let description = preview.google.description {
                Text(description).font(.subheadline).foregroundStyle(.secondary)
            } else {
                MissingTag(what: "meta description")
            }
        }
        .padding(.vertical, 6)
    }
}

/// An X (large or small) or Facebook link card.
private struct SocialCard: View {
    enum Style { case large, small, facebook }

    let preview: SeoPreview
    let text: SeoPreview.Text
    let style: Style

    var body: some View {
        Group {
            if style == .small {
                HStack(spacing: 0) {
                    CardImage(url: preview.image)
                        .frame(width: 96, height: 96)
                    Divider()
                    details.frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    CardImage(url: preview.image)
                        .aspectRatio(1.91, contentMode: .fit)
                    Divider()
                    details
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(style == .facebook ? Color.cardFill : Color.clear)
                }
            }
        }
        .clipShape(.rect(cornerRadius: style == .facebook ? 4 : 14))
        .overlay {
            RoundedRectangle(cornerRadius: style == .facebook ? 4 : 14).strokeBorder(Color.cardStroke)
        }
        .padding(.vertical, 6)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(style == .facebook ? preview.host.uppercased() : preview.host)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let title = text.title {
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(2)
            } else {
                MissingTag(what: "og:title")
            }
            if let description = text.description {
                Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(style == .small ? 2 : 3)
            } else {
                MissingTag(what: "og:description")
            }
        }
        .padding(10)
    }
}

/// A card's image, filling the frame it's given and clipped to it, or a
/// note that the page names none.
private struct CardImage: View {
    let url: String?

    var body: some View {
        Color.clear
            .overlay {
                if let url {
                    Thumbnail(url: url, maxPixels: 1200)
                } else {
                    ZStack {
                        Color.placeholderFill
                        Text("No image").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .clipped()
    }
}

private struct MissingTag: View {
    let what: String

    var body: some View {
        Label("Missing \(what)", systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.orange)
    }
}

/// Fetches a page from the live site for its metadata.
enum PageFetcher {
    struct HTTPError: Error {
        let status: Int
    }

    /// The page's HTML and its address after redirects. A throwaway query
    /// asks the CDN for a fresh copy: GitHub Pages serves a cached page for
    /// minutes after a deploy.
    static func fetch(_ url: URL) async throws -> (html: String, url: URL) {
        var fresh = url
        if var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            let stamp = URLQueryItem(name: cacheBuster, value: String(Int(Date().timeIntervalSince1970)))
            components.queryItems = (components.queryItems ?? []) + [stamp]
            fresh = components.url ?? url
        }
        var request = URLRequest(url: fresh, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw HTTPError(status: http.statusCode)
        }
        // The head is near the top; a few megabytes is plenty.
        let html = decode(data.prefix(4_000_000), encodingName: response.textEncodingName)
        return (html, withoutCacheBuster(response.url ?? url))
    }

    private static let cacheBuster = "posto-preview"

    private static func withoutCacheBuster(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        let kept = components.queryItems?.filter { $0.name != cacheBuster } ?? []
        components.queryItems = kept.isEmpty ? nil : kept
        return components.url ?? url
    }

    private static func decode(_ data: Data, encodingName: String?) -> String {
        if let encodingName {
            let encoding = CFStringConvertIANACharSetNameToEncoding(encodingName as CFString)
            if encoding != kCFStringEncodingInvalidId,
               let text = String(data: data, encoding: String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(encoding))) {
                return text
            }
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// Why a page couldn't be read, in terms of what the user can do.
    static func message(for error: Error, page: SitePage) -> String {
        if let http = error as? HTTPError {
            guard http.status == 404 else { return "The site answered with HTTP \(http.status)." }
            if page.localChanges == "new" {
                return "The live site has no page here yet. Publish this file and wait for the deploy to finish."
            }
            if !page.certain {
                return "The live site has no page at this address. Posto guessed it from the file's slug, and the site may use a different one."
            }
            return "The live site has no page at this address."
        }
        return "Couldn't reach the site: \(error.localizedDescription)"
    }
}

/// Opens a link from inside a sheet: in an in-app Safari view presented
/// from here on iOS (the app's own browser sheet can't present over a
/// sheet), in the default browser on macOS.
struct LinkBrowser: ViewModifier {
    @Binding var url: URL?
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        #if os(iOS)
        content.sheet(item: $url) { url in
            SafariView(url: url).ignoresSafeArea()
        }
        #else
        content.onChange(of: url) { _, next in
            guard let next else { return }
            openURL(next)
            url = nil
        }
        #endif
    }
}
