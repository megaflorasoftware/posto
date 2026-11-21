import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// Downsampled thumbnails for local files and remote URLs, cached by source
/// and size. Large library photos never decode at full resolution just to
/// fill a grid cell, and SVGs (which Image I/O can't read) are drawn by
/// SVGRasterizer.
actor ThumbnailCache {
    static let shared = ThumbnailCache()
    private let cache: NSCache<NSString, CGImage> = {
        let cache = NSCache<NSString, CGImage>()
        cache.totalCostLimit = 192 * 1024 * 1024
        return cache
    }()
    /// Loads in flight, so a grid asking twice decodes (or downloads) once.
    private var loading: [String: Task<CGImage?, Never>] = [:]

    func image(path: String, maxPixels: Int) async -> CGImage? {
        await image(key: "\(path)#\(maxPixels)") { await Self.load(path: path, maxPixels: maxPixels) }
    }

    func image(url: String, maxPixels: Int) async -> CGImage? {
        await image(key: "\(url)#\(maxPixels)") { await Self.load(url: url, maxPixels: maxPixels) }
    }

    func invalidate() {
        cache.removeAllObjects()
    }

    private func image(key: String, load: @escaping @Sendable () async -> CGImage?) async -> CGImage? {
        if let cached = cache.object(forKey: key as NSString) { return cached }
        if let pending = loading[key] { return await pending.value }
        let task = Task { await load() }
        loading[key] = task
        let image = await task.value
        loading[key] = nil
        if let image { cache.setObject(image, forKey: key as NSString, cost: image.bytesPerRow * image.height) }
        return image
    }

    private static func load(path: String, maxPixels: Int) async -> CGImage? {
        let url = URL(fileURLWithPath: path)
        if !SVGRasterizer.isSVG(path: path),
           let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
           let image = downsample(source, maxPixels: maxPixels) {
            return image
        }
        // An SVG, or a file Image I/O couldn't read that may be one.
        guard SVGRasterizer.isSVG(path: path) || startsLikeSVG(url),
              let data = try? Data(contentsOf: url)
        else { return nil }
        return await SVGRasterizer.image(data: data, maxPixels: maxPixels)
    }

    private static func load(url string: String, maxPixels: Int) async -> CGImage? {
        guard let url = URL(string: string),
              let (data, response) = try? await URLSession.shared.data(from: url)
        else { return nil }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { return nil }
        if let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
           let image = downsample(source, maxPixels: maxPixels) {
            return image
        }
        return await SVGRasterizer.image(data: data, maxPixels: maxPixels)
    }

    private static func downsample(_ source: CGImageSource, maxPixels: Int) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// Reads just the start of a file to see whether it's SVG markup.
    private static func startsLikeSVG(_ url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let start = try? handle.read(upToCount: 2048) else { return false }
        return SVGRasterizer.looksLikeSVG(start)
    }
}

/// A local file or remote URL shown as a filled, clipped thumbnail.
struct Thumbnail: View {
    var path: String?
    var url: String?
    var maxPixels = 400
    var placeholder = "photo"

    @State private var image: CGImage?
    @State private var failed = false

    /// What to load: a remote URL wins over a path, as before.
    private var source: String? {
        if let url, URL(string: url) != nil { return url }
        return path
    }

    var body: some View {
        // The rectangle takes the frame it's offered; the image fills it and
        // is clipped, so any aspect ratio stays inside its cell.
        Rectangle()
            .fill(.quaternary)
            .overlay {
                if let image {
                    Image(decorative: image, scale: 1).resizable().scaledToFill()
                } else if failed || source == nil {
                    fallback
                } else if url != nil {
                    ProgressView()
                }
            }
            .clipped()
            // clipped() trims the drawing, not hit-testing: without this, a
            // tall image's overflow takes taps meant for whatever sits above.
            .contentShape(.rect)
        .task(id: "\(source ?? "")#\(maxPixels)") {
            image = nil
            failed = false
            let loaded: CGImage?
            if let url, URL(string: url) != nil {
                loaded = await ThumbnailCache.shared.image(url: url, maxPixels: maxPixels)
            } else if let path {
                loaded = await ThumbnailCache.shared.image(path: path, maxPixels: maxPixels)
            } else {
                return
            }
            guard !Task.isCancelled else { return }
            image = loaded
            failed = loaded == nil
        }
    }

    private var fallback: some View {
        Image(systemName: placeholder)
            .font(.title2)
            .foregroundStyle(.secondary)
    }
}

/// SF Symbol for a media file by kind.
func mediaSymbol(for kind: String, name: String = "") -> String {
    switch kind {
    case "image": return "photo"
    case "audio": return "waveform"
    case "video": return "film"
    default: return name.lowercased().hasSuffix(".pdf") ? "doc.richtext" : "doc"
    }
}
