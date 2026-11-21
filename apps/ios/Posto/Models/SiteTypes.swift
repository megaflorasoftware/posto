import Foundation

/// Where the open file is on the live site (`site.page`), and why it might
/// not be there yet.
struct SitePage: Codable, Hashable, Sendable {
    let siteUrl: String?
    let route: String?
    /// False when the route is guessed from a collection and slug.
    let certain: Bool
    let url: String?
    /// "new" (not on the site yet) or "modified" (the site has an older
    /// version), from git.
    let localChanges: String?
    let draft: Bool

    var pageURL: URL? { url.flatMap(URL.init(string:)) }

    /// A few words for a menu item's subtitle: why the page can't be opened,
    /// or why it may not match.
    var shortNote: String? {
        if siteUrl == nil { return "No site address found" }
        if route == nil { return "Not a page on the site" }
        if localChanges == "new" { return "Not published yet" }
        if draft { return "Marked as a draft" }
        if !certain { return "Address guessed from its slug" }
        return nil
    }

    /// The same, in full, for the notices above a preview.
    var notes: [String] {
        if siteUrl == nil {
            return ["Posto couldn't find this site's address. It looks for the site option in the Astro config, a public/CNAME file, a homepage in package.json, and GitHub Pages."]
        }
        if route == nil {
            return ["Posto can't tell which page this file becomes on the site."]
        }
        var notes: [String] = []
        if localChanges == "new" {
            notes.append("This file hasn't been published yet, so the live site may not have this page.")
        } else if localChanges == "modified" {
            notes.append("This file has unpublished changes. The live site shows the last published version.")
        }
        if draft {
            notes.append("This entry is marked as a draft, so the site may leave it out.")
        }
        if !certain {
            notes.append("Posto guessed this page's address from its collection and slug; the site may use a different one.")
        }
        return notes
    }
}

/// The search and social cards for a deployed page (`seo.preview`). Text is
/// already clipped to each card's length; nil means the page is missing it.
struct SeoPreview: Codable, Sendable {
    struct Text: Codable, Sendable {
        let title: String?
        let description: String?
    }

    let host: String
    let breadcrumb: String
    let siteName: String
    let favicon: String?
    let image: String?
    let twitterCard: String?
    let google: Text
    let card: Text
    let facebook: Text
}
