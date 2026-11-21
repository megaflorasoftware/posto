import CoreGraphics
import Foundation
#if canImport(UIKit)
import UIKit
import WebKit
#else
import AppKit
#endif

/// SVG files as bitmaps, for thumbnails. Image I/O can't decode SVG. On
/// macOS, NSImage can; on iOS, a WebKit web view draws the file (as an
/// `<img>`, so scripts in it never run) and is snapshotted.
enum SVGRasterizer {
    static func isSVG(path: String) -> Bool {
        path.lowercased().hasSuffix(".svg")
    }

    /// Markup whose first element is `<svg>` (after any XML prolog,
    /// doctype or comments), for files and responses without a telling
    /// name or type.
    static func looksLikeSVG(_ data: Data) -> Bool {
        String(decoding: data.prefix(2048), as: UTF8.self).range(of: "<svg", options: .caseInsensitive) != nil
    }

    /// The drawing, `maxPixels` on its longer side; nil when it can't be
    /// drawn.
    static func image(data: Data, maxPixels: Int) async -> CGImage? {
        guard maxPixels > 0, looksLikeSVG(data) else { return nil }
        #if canImport(UIKit)
        return await WebSVGRenderer.shared.render(data, maxPixels: maxPixels)
        #else
        return await MainActor.run { drawWithAppKit(data, maxPixels: maxPixels) }
        #endif
    }

    /// The drawing's pixel size: `maxPixels` on the longer side, in the
    /// aspect ratio its `viewBox` (or `width` and `height`) gives; square
    /// when it gives none.
    static func pixelSize(of data: Data, maxPixels: Int) -> CGSize {
        let ratio = aspectRatio(of: data) ?? 1
        let longest = CGFloat(maxPixels)
        return ratio >= 1
            ? CGSize(width: longest, height: max(1, (longest / ratio).rounded()))
            : CGSize(width: max(1, (longest * ratio).rounded()), height: longest)
    }

    /// Width over height, from the root element's attributes.
    static func aspectRatio(of data: Data) -> CGFloat? {
        let text = String(decoding: data.prefix(16_384), as: UTF8.self)
        guard let open = text.range(of: "<svg", options: .caseInsensitive),
              let close = text.range(of: ">", range: open.upperBound..<text.endIndex)
        else { return nil }
        let tag = String(text[open.upperBound..<close.lowerBound])
        func attribute(_ name: String) -> String? {
            let pattern = "(?:^|\\s)\(name)\\s*=\\s*([\"'])(.*?)\\1"
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]),
                  let match = regex.firstMatch(in: tag, range: NSRange(tag.startIndex..., in: tag)),
                  let range = Range(match.range(at: 2), in: tag)
            else { return nil }
            return String(tag[range])
        }
        if let viewBox = attribute("viewBox") {
            let numbers = viewBox.split(whereSeparator: { $0 == " " || $0 == "," || $0.isNewline || $0 == "\t" })
                .compactMap { Double($0) }
            if numbers.count == 4, numbers[2] > 0, numbers[3] > 0 { return CGFloat(numbers[2] / numbers[3]) }
        }
        // Lengths in pixels (or unitless); percentages and other units say
        // nothing about the shape.
        func length(_ value: String?) -> Double? {
            guard let value = value?.trimmingCharacters(in: .whitespaces).lowercased() else { return nil }
            let number = value.hasSuffix("px") ? String(value.dropLast(2)) : value
            return Double(number).flatMap { $0 > 0 ? $0 : nil }
        }
        if let width = length(attribute("width")), let height = length(attribute("height")) {
            return CGFloat(width / height)
        }
        return nil
    }

    #if !canImport(UIKit)
    @MainActor
    private static func drawWithAppKit(_ data: Data, maxPixels: Int) -> CGImage? {
        guard let image = NSImage(data: data), image.isValid else { return nil }
        // NSImage knows the drawing's own size; fall back to the markup's.
        var size = pixelSize(of: data, maxPixels: maxPixels)
        if image.size.width > 0, image.size.height > 0 {
            let ratio = image.size.width / image.size.height
            let longest = CGFloat(maxPixels)
            size = ratio >= 1
                ? CGSize(width: longest, height: max(1, (longest / ratio).rounded()))
                : CGSize(width: max(1, (longest * ratio).rounded()), height: longest)
        }
        guard let context = CGContext(
            data: nil,
            width: Int(size.width),
            height: Int(size.height),
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        image.draw(in: CGRect(origin: .zero, size: size), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        return context.makeImage()
    }
    #endif
}

#if canImport(UIKit)
/// Draws SVGs one at a time in a web view and snapshots them. WebKit only
/// paints a web view that's in a window, so while it works the view sits at
/// the back of the app's window, under the app's own views; a few seconds
/// after the last drawing it's taken down, which ends its web process.
@MainActor
private final class WebSVGRenderer: NSObject, WKNavigationDelegate {
    static let shared = WebSVGRenderer()

    private var webView: WKWebView?
    /// The drawing in progress; each waits for the one before.
    private var queue: Task<Void, Never>?
    private var pendingLoad: (navigation: WKNavigation?, continuation: CheckedContinuation<Bool, Never>)?
    private var teardown: Task<Void, Never>?

    func render(_ data: Data, maxPixels: Int) async -> CGImage? {
        let previous = queue
        let drawing = Task { () -> CGImage? in
            await previous?.value
            return await self.draw(data, maxPixels: maxPixels)
        }
        queue = Task { _ = await drawing.value }
        return await drawing.value
    }

    private func draw(_ data: Data, maxPixels: Int) async -> CGImage? {
        teardown?.cancel()
        defer { scheduleTeardown() }
        guard let window = Self.hostWindow() else { return nil }
        let scale = max(1, window.traitCollection.displayScale)
        let pixels = SVGRasterizer.pixelSize(of: data, maxPixels: maxPixels)
        let size = CGSize(width: max(1, (pixels.width / scale).rounded()), height: max(1, (pixels.height / scale).rounded()))
        let webView = self.webView ?? makeWebView()
        self.webView = webView
        webView.frame = CGRect(origin: .zero, size: size)
        if webView.superview !== window { window.insertSubview(webView, at: 0) }

        let width = Int(size.width), height = Int(size.height)
        let html = """
        <!doctype html><html><head>\
        <meta name="viewport" content="width=\(width),initial-scale=1,user-scalable=no">\
        <style>html,body{margin:0;padding:0;background:transparent;width:\(width)px;height:\(height)px;overflow:hidden}\
        img{display:block;width:100%;height:100%;object-fit:contain}</style>\
        </head><body><img alt="" src="data:image/svg+xml;base64,\(data.base64EncodedString())"></body></html>
        """
        guard await load(html, in: webView) else { return nil }
        // Wait for the image to decode (false if it can't: not an SVG, or a
        // broken one), then for two frames so it's painted. Each wait gives
        // up after a moment, so one bad file can't stall the queue.
        let script = """
        const image = document.images[0];
        if (!image) return false;
        const after = (ms, value) => new Promise((done) => setTimeout(() => done(value), ms));
        const decoded = await Promise.race([image.decode().then(() => true, () => false), after(3000, false)]);
        if (!decoded) return false;
        await Promise.race([new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))), after(500)]);
        return true;
        """
        guard (try? await webView.callAsyncJavaScript(script, contentWorld: .defaultClient)) as? Bool == true
        else { return nil }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = webView.bounds
        configuration.afterScreenUpdates = true
        return try? await webView.takeSnapshot(configuration: configuration).cgImage
    }

    private func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The page is this file's own markup; the SVG is an <img>, which
        // WebKit draws without running its scripts or loading anything else.
        configuration.websiteDataStore = .nonPersistent()
        configuration.suppressesIncrementalRendering = true
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 64, height: 64), configuration: configuration)
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isUserInteractionEnabled = false
        webView.accessibilityElementsHidden = true
        return webView
    }

    /// Loads the page; false if it fails or takes more than a few seconds.
    private func load(_ html: String, in webView: WKWebView) async -> Bool {
        await withCheckedContinuation { continuation in
            let navigation = webView.loadHTMLString(html, baseURL: nil)
            pendingLoad = (navigation, continuation)
            Task {
                try? await Task.sleep(for: .seconds(5))
                if pendingLoad?.navigation === navigation { finishLoad(navigation, loaded: false) }
            }
        }
    }

    private func finishLoad(_ navigation: WKNavigation?, loaded: Bool) {
        guard let pending = pendingLoad, pending.navigation === navigation else { return }
        pendingLoad = nil
        pending.continuation.resume(returning: loaded)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finishLoad(navigation, loaded: true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finishLoad(navigation, loaded: false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finishLoad(navigation, loaded: false)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let pending = pendingLoad { finishLoad(pending.navigation, loaded: false) }
        webView.removeFromSuperview()
        if self.webView === webView { self.webView = nil }
    }

    private func scheduleTeardown() {
        teardown?.cancel()
        teardown = Task {
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled, pendingLoad == nil else { return }
            webView?.removeFromSuperview()
            webView = nil
        }
    }

    private static func hostWindow() -> UIWindow? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        return windows.first(where: \.isKeyWindow) ?? windows.first
    }
}
#endif
