import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// An element of the body shown as a card or pill instead of text: what the
/// desktop editor renders as a TipTap node. See engine/src/bodyEmbeds.ts.
struct BodyEmbed: Codable, Sendable, Equatable {
    struct ImagePreview: Codable, Sendable, Equatable {
        let path: String?
        let url: String?
    }

    /// "component", "import", "raw", "html" or "image".
    let kind: String
    /// UTF-16 offsets into the markdown source.
    let start: Int
    let end: Int
    /// Opens a line (a card) rather than sitting inside a paragraph.
    let block: Bool
    let label: String
    let detail: String?
    let preview: String?
    let src: String?
    let alt: String?
    let image: ImagePreview?

    var sourceRange: NSRange { NSRange(location: start, length: end - start) }

    /// Full width: components, raw MDX blocks and images on their own lines.
    /// Everything else (inline components, imports, HTML) is a pill.
    var isCard: Bool { block && (kind == "component" || kind == "raw" || kind == "image") }

    var symbol: String {
        switch kind {
        case "component": return "square.on.square"
        case "import": return "arrow.down.right.square"
        case "raw": return "curlybraces"
        case "html": return "chevron.left.forwardslash.chevron.right"
        default: return "photo"
        }
    }
}

/// One embed in the text view: a single attachment character standing for
/// `source`, drawn as a card or pill.
final class EmbedAttachment: NSTextAttachment {
    let source: String
    let embed: BodyEmbed
    var isSelected = false
    var thumbnail: PlatformImage?
    private var renderedKey: String?

    init(source: String, embed: BodyEmbed) {
        self.source = source
        self.embed = embed
        super.init(data: nil, ofType: nil)
    }

    required init?(coder: NSCoder) {
        nil
    }

    /// Draws the card or pill for this width and appearance; skipped when
    /// nothing it depends on changed. `capHeight` centers a pill on the
    /// text's capital letters.
    @MainActor
    func render(width: CGFloat, fontSize: CGFloat, capHeight: CGFloat, dark: Bool, scale: CGFloat) {
        let key = "\(Int(width))|\(fontSize)|\(dark)|\(isSelected)|\(thumbnail != nil)"
        guard key != renderedKey else { return }
        let view = EmbedView(embed: embed, selected: isSelected, thumbnail: thumbnail, fontSize: fontSize, width: width)
            .environment(\.colorScheme, dark ? .dark : .light)
        let renderer = ImageRenderer(content: view)
        renderer.scale = max(scale, 1)
        renderer.isOpaque = false
        #if canImport(UIKit)
        guard let rendered = renderer.uiImage else { return }
        #else
        guard let rendered = renderer.nsImage else { return }
        #endif
        renderedKey = key
        image = rendered
        let size = rendered.size
        if embed.isCard {
            bounds = CGRect(origin: .zero, size: size)
        } else {
            bounds = CGRect(x: 0, y: (capHeight - size.height) / 2, width: size.width, height: size.height)
        }
    }
}

/// Moves between the markdown source and what the text view holds, where
/// each embed is one attachment character.
@MainActor
enum EmbedProjection {
    struct Segment {
        let display: NSRange
        let source: NSRange
        let attachment: EmbedAttachment?
    }

    /// The markdown behind `text`: attachments read as their source, and any
    /// foreign attachment (pasted from elsewhere) is dropped.
    static func source(of text: NSAttributedString) -> String {
        segments(of: text).reduce(into: "") { result, segment in
            if let attachment = segment.attachment {
                result += attachment.source
            } else if segment.source.length > 0 {
                result += (text.string as NSString).substring(with: segment.display)
            }
        }
    }

    static func segments(of text: NSAttributedString) -> [Segment] {
        var segments: [Segment] = []
        var sourceOffset = 0
        text.enumerateAttribute(.attachment, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            if let attachment = value as? EmbedAttachment {
                for index in 0..<range.length {
                    let length = (attachment.source as NSString).length
                    segments.append(Segment(
                        display: NSRange(location: range.location + index, length: 1),
                        source: NSRange(location: sourceOffset, length: length),
                        attachment: attachment
                    ))
                    sourceOffset += length
                }
            } else if value != nil {
                segments.append(Segment(display: range, source: NSRange(location: sourceOffset, length: 0), attachment: nil))
            } else {
                segments.append(Segment(display: range, source: NSRange(location: sourceOffset, length: range.length), attachment: nil))
                sourceOffset += range.length
            }
        }
        return segments
    }

    /// The source offset for a display offset (an attachment's start or end).
    static func sourceOffset(in text: NSAttributedString, display: Int) -> Int {
        var last = 0
        for segment in segments(of: text) {
            if display < NSMaxRange(segment.display) {
                if segment.attachment != nil || segment.source.length == 0 {
                    return segment.source.location + (display > segment.display.location ? segment.source.length : 0)
                }
                return segment.source.location + (display - segment.display.location)
            }
            last = NSMaxRange(segment.source)
        }
        return last
    }

    /// The display offset for a source offset; inside an embed it snaps to
    /// the embed's end.
    static func displayOffset(in text: NSAttributedString, source: Int) -> Int {
        var last = 0
        for segment in segments(of: text) {
            if segment.attachment != nil {
                if source <= segment.source.location { return segment.display.location }
                if source < NSMaxRange(segment.source) { return NSMaxRange(segment.display) }
            } else if source < NSMaxRange(segment.source) {
                return segment.display.location + max(0, source - segment.source.location)
            }
            last = NSMaxRange(segment.display)
        }
        return last
    }

    static func sourceRange(in text: NSAttributedString, display range: NSRange) -> NSRange {
        let start = sourceOffset(in: text, display: range.location)
        let end = sourceOffset(in: text, display: NSMaxRange(range))
        return NSRange(location: start, length: max(0, end - start))
    }

    /// What the text view shows now, comparable with a fresh scan.
    static func shownKeys(in text: NSAttributedString) -> [String] {
        segments(of: text).compactMap { segment in
            segment.attachment.map { key(start: segment.source.location, end: NSMaxRange(segment.source), embed: $0.embed) }
        }
    }

    static func key(start: Int, end: Int, embed: BodyEmbed) -> String {
        "\(start)-\(end)-\(embed.block)-\(embed.kind)"
    }

    /// `source` with each embed replaced by an attachment character.
    static func project(_ source: String, embeds: [BodyEmbed], attributes: [NSAttributedString.Key: Any]) -> NSMutableAttributedString {
        let text = source as NSString
        let result = NSMutableAttributedString()
        var cursor = 0
        for embed in embeds.sorted(by: { $0.start < $1.start })
        where embed.start >= cursor && embed.end <= text.length && embed.end > embed.start {
            if embed.start > cursor {
                result.append(NSAttributedString(string: text.substring(with: NSRange(location: cursor, length: embed.start - cursor)), attributes: attributes))
            }
            let attachment = EmbedAttachment(source: text.substring(with: embed.sourceRange), embed: embed)
            let character = NSMutableAttributedString(attachment: attachment)
            character.addAttributes(attributes, range: NSRange(location: 0, length: character.length))
            result.append(character)
            cursor = embed.end
        }
        if cursor < text.length {
            result.append(NSAttributedString(string: text.substring(from: cursor), attributes: attributes))
        }
        return result
    }

    static func attachments(in text: NSAttributedString) -> [(EmbedAttachment, NSRange)] {
        var found: [(EmbedAttachment, NSRange)] = []
        text.enumerateAttribute(.attachment, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            if let attachment = value as? EmbedAttachment {
                for index in 0..<range.length {
                    found.append((attachment, NSRange(location: range.location + index, length: 1)))
                }
            }
        }
        return found
    }
}

/// Thumbnails for image embeds, kept across re-projections.
@MainActor
final class EmbedThumbnails {
    static let shared = EmbedThumbnails()
    private var images: [String: PlatformImage] = [:]
    private var loading: Set<String> = []

    func cached(_ preview: BodyEmbed.ImagePreview?) -> PlatformImage? {
        key(preview).flatMap { images[$0] }
    }

    /// Loads the thumbnail once; `done` runs when it arrives.
    func load(_ preview: BodyEmbed.ImagePreview?, done: @escaping @MainActor () -> Void) {
        guard let preview, let key = key(preview), images[key] == nil, !loading.contains(key) else { return }
        loading.insert(key)
        Task {
            var image: PlatformImage?
            if let path = preview.path {
                if let cgImage = await ThumbnailCache.shared.image(path: path, maxPixels: 900) {
                    image = PlatformImage(cgImage: cgImage, platform: ())
                }
            } else if let url = preview.url.flatMap(URL.init(string:)),
                      let (data, _) = try? await URLSession.shared.data(from: url) {
                image = PlatformImage(data: data)
            }
            loading.remove(key)
            if let image {
                images[key] = image
                done()
            }
        }
    }

    private func key(_ preview: BodyEmbed.ImagePreview?) -> String? {
        preview?.path ?? preview?.url
    }
}

/// The drawing of one embed: a full-width card, or a pill that sits in a
/// line of text.
private struct EmbedView: View {
    let embed: BodyEmbed
    let selected: Bool
    let thumbnail: PlatformImage?
    let fontSize: CGFloat
    let width: CGFloat

    var body: some View {
        if embed.isCard {
            card.padding(.vertical, 4)
        } else {
            pill
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 6) {
            if embed.kind == "image" {
                imageContent
            } else {
                HStack(spacing: 6) {
                    Image(systemName: embed.symbol)
                        .font(.system(size: fontSize * 0.8, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                    Text(embed.label)
                        .font(.system(size: fontSize * 0.88, weight: .semibold))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                if let detail = embed.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: fontSize * 0.75, design: embed.kind == "raw" ? .monospaced : .default))
                        .foregroundStyle(.secondary)
                        .lineLimit(embed.kind == "raw" ? 4 : 2)
                }
                if let preview = embed.preview, !preview.isEmpty {
                    Text(preview)
                        .font(.system(size: fontSize * 0.85))
                        .foregroundStyle(.primary)
                        .lineLimit(3)
                }
            }
        }
        .padding(embed.kind == "image" ? 6 : 12)
        .frame(width: width, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.cardFill))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(selected ? Color.accentColor : Color.cardStroke, lineWidth: selected ? 2 : 0.5)
        )
    }

    @ViewBuilder
    private var imageContent: some View {
        let imageWidth = width - 12
        if let thumbnail {
            let aspect = thumbnail.size.width / max(thumbnail.size.height, 1)
            Image(platformImage: thumbnail)
                .resizable()
                .scaledToFill()
                .frame(width: imageWidth, height: min(260, max(80, imageWidth / max(aspect, 0.1))))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.placeholderFill)
                .frame(width: imageWidth, height: 120)
                .overlay(Image(systemName: "photo").font(.system(size: 28)).foregroundStyle(.secondary))
        }
        if !embed.label.isEmpty {
            Text(embed.label)
                .font(.system(size: fontSize * 0.75))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .padding(.horizontal, 6)
                .padding(.bottom, 2)
        }
    }

    private var pill: some View {
        HStack(spacing: 4) {
            if let thumbnail, embed.kind == "image" {
                Image(platformImage: thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(width: fontSize * 1.1, height: fontSize * 1.1)
                    .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
            } else {
                Image(systemName: embed.symbol).font(.system(size: fontSize * 0.7, weight: .semibold))
            }
            Text(embed.label.count > 32 ? embed.label.prefix(31) + "…" : embed.label)
                .font(.system(size: fontSize * 0.82, weight: .medium))
                .lineLimit(1)
        }
        .foregroundStyle(Color.accentColor)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(Capsule().fill(Color.accentColor.opacity(selected ? 0.28 : 0.12)))
        .overlay(Capsule().strokeBorder(Color.accentColor.opacity(selected ? 0.9 : 0.3), lineWidth: selected ? 1.5 : 0.5))
    }
}
