import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// Downsampled thumbnails for local images, cached by path and size. Large
/// library photos never decode at full resolution just to fill a grid cell.
actor ThumbnailCache {
    static let shared = ThumbnailCache()
    private var cache: [String: CGImage] = [:]

    func image(path: String, maxPixels: Int) -> CGImage? {
        let key = "\(path)#\(maxPixels)"
        if let cached = cache[key] { return cached }
        let url = URL(fileURLWithPath: path)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        cache[key] = image
        return image
    }

    func invalidate() {
        cache.removeAll()
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

    var body: some View {
        ZStack {
            Rectangle().fill(.quaternary)
            if let url, let remote = URL(string: url) {
                AsyncImage(url: remote) { phase in
                    if let loaded = phase.image {
                        loaded.resizable().scaledToFill()
                    } else if phase.error != nil {
                        fallback
                    } else {
                        ProgressView()
                    }
                }
            } else if let image {
                Image(decorative: image, scale: 1).resizable().scaledToFill()
            } else if failed || path == nil {
                fallback
            }
        }
        .clipped()
        .task(id: path) {
            guard url == nil, let path else { return }
            let loaded = await ThumbnailCache.shared.image(path: path, maxPixels: maxPixels)
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
