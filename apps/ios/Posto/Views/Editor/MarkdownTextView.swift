import SwiftUI
import UIKit

/// Shared handle so SwiftUI sheets (image and component pickers) can insert
/// into the text view the keyboard toolbar belongs to.
@MainActor
final class MarkdownEditorController {
    weak var textView: UITextView?
    weak var coordinator: MarkdownTextView.Coordinator?
    var onChange: ((String) -> Void)?
    var onRequestImage: (() -> Void)?
    var onRequestComponent: (() -> Void)?
    /// Edit the component around the caret: (body source, UTF-16 offset).
    var onRequestEditComponent: ((String, Int) -> Void)?
    /// Scans a body for its cards and pills (the engine's `body.embeds`).
    var loadEmbeds: ((String) async -> [BodyEmbed])? {
        didSet { coordinator?.scheduleEmbedScan(after: 0) }
    }
    /// A card or pill was tapped: (it, the body source, its source range).
    var onOpenEmbed: ((EmbedAttachment, String, NSRange) -> Void)?
    var componentsEnabled = false

    /// The markdown in the text view, with cards and pills read as source.
    var sourceText: String {
        guard let textView else { return "" }
        return EmbedProjection.source(of: textView.textStorage)
    }

    func requestEditComponent() {
        guard let textView else { return }
        let storage = textView.textStorage
        let selected = textView.selectedRange
        // A selected component card, or one just before the caret, opens as if tapped.
        for candidate in [selected.location, selected.location - 1] where candidate >= 0 && candidate < storage.length {
            if let attachment = storage.attribute(.attachment, at: candidate, effectiveRange: nil) as? EmbedAttachment,
               attachment.embed.kind == "component" {
                open(attachment, at: NSRange(location: candidate, length: 1))
                return
            }
        }
        onRequestEditComponent?(EmbedProjection.source(of: storage), EmbedProjection.sourceOffset(in: storage, display: selected.location))
    }

    func open(_ attachment: EmbedAttachment, at displayRange: NSRange) {
        guard let textView else { return }
        let storage = textView.textStorage
        onOpenEmbed?(attachment, EmbedProjection.source(of: storage), EmbedProjection.sourceRange(in: storage, display: displayRange))
    }

    /// Replaces a range of the markdown source (an edited, rewritten or
    /// removed card) and shows the result with its cards.
    func replaceSource(_ range: NSRange, with string: String) {
        guard let textView, let coordinator else { return }
        coordinator.replaceSource(range, with: string, in: textView)
    }

    /// Kept for callers that edit a component by its source range.
    func replace(range: NSRange, with string: String) {
        replaceSource(range, with: string)
    }

    /// Inserts at the caret; blocks get blank lines around them.
    func insert(_ snippet: String, asBlock: Bool = false) {
        guard let textView else { return }
        let text = textView.text as NSString
        let range = textView.selectedRange
        var insertion = snippet
        if asBlock {
            let before = range.location > 0 ? text.substring(with: NSRange(location: 0, length: range.location)) : ""
            let after = text.substring(from: range.location + range.length)
            if !before.isEmpty && !before.hasSuffix("\n\n") { insertion = (before.hasSuffix("\n") ? "\n" : "\n\n") + insertion }
            if !after.hasPrefix("\n\n") { insertion += after.hasPrefix("\n") ? "\n" : "\n\n" }
        }
        replace(range, with: insertion, selecting: nil)
        // An inserted component or image becomes its card right away.
        coordinator?.scheduleEmbedScan(after: 0)
    }

    func replace(_ range: NSRange, with string: String, selecting selection: NSRange?) {
        edit(range, with: string)
        if let selection { textView?.selectedRange = selection }
        changed()
    }

    /// Replaces display text without notifying; callers batch, then call changed().
    @discardableResult
    private func edit(_ range: NSRange, with string: String) -> Bool {
        guard let textView,
              let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
              let end = textView.position(from: start, offset: range.length),
              let textRange = textView.textRange(from: start, to: end)
        else { return false }
        textView.replace(textRange, withText: string)
        return true
    }

    func changed() {
        guard let textView else { return }
        if let coordinator {
            coordinator.textChanged(textView)
        } else {
            MarkdownStyler.style(textView)
            onChange?(EmbedProjection.source(of: textView.textStorage))
        }
    }

    // MARK: Formatting
    // Edits insert and remove markers around the selection instead of
    // retyping it, so cards and pills inside it keep their source.

    func wrap(_ marker: String, placeholder: String) {
        guard let textView else { return }
        let range = textView.selectedRange
        let length = (marker as NSString).length
        if range.length == 0 {
            let selection = NSRange(location: range.location + length, length: (placeholder as NSString).length)
            replace(range, with: marker + placeholder + marker, selecting: selection)
            return
        }
        edit(NSRange(location: NSMaxRange(range), length: 0), with: marker)
        edit(NSRange(location: range.location, length: 0), with: marker)
        textView.selectedRange = NSRange(location: range.location + length, length: range.length)
        changed()
    }

    /// Toggles a prefix on every selected line (`# `, `- `, `> `, `1. `).
    func prefixLines(_ prefix: String) {
        guard let textView else { return }
        let text = textView.text as NSString
        let block = text.lineRange(for: textView.selectedRange)
        var lines: [NSRange] = []
        text.enumerateSubstrings(in: block, options: [.byLines, .substringNotRequired]) { _, range, _, _ in
            lines.append(range)
        }
        if lines.isEmpty { lines = [NSRange(location: block.location, length: 0)] }
        let contents = lines.map { text.substring(with: $0) }
        let allPrefixed = contents.allSatisfy { $0.hasPrefix(prefix) }
        let existing = try! NSRegularExpression(pattern: #"^(#{1,6} |[-*+] |> |\d+\. )"#)
        let prefixLength = (prefix as NSString).length
        var deltas: [Int] = []
        // Bottom-up, so the offsets of earlier lines stay valid.
        for (line, content) in zip(lines, contents).reversed() {
            let replaced: Int
            let inserted: String
            if allPrefixed {
                replaced = prefixLength
                inserted = ""
            } else if let match = existing.firstMatch(in: content, range: NSRange(location: 0, length: (content as NSString).length)) {
                replaced = match.range.length
                inserted = prefix
            } else {
                replaced = 0
                inserted = prefix
            }
            edit(NSRange(location: line.location, length: replaced), with: inserted)
            deltas.insert((inserted as NSString).length - replaced, at: 0)
        }
        let last = lines[lines.count - 1]
        let shift = deltas.dropLast().reduce(0, +)
        textView.selectedRange = NSRange(location: last.location + shift + last.length + deltas[deltas.count - 1], length: 0)
        changed()
    }

    func insertLink() {
        guard let textView else { return }
        let range = textView.selectedRange
        if range.length == 0 {
            replace(range, with: "[link text](https://)", selecting: NSRange(location: range.location + 12, length: 8))
            return
        }
        edit(NSRange(location: NSMaxRange(range), length: 0), with: "](https://)")
        edit(NSRange(location: range.location, length: 0), with: "[")
        textView.selectedRange = NSRange(location: NSMaxRange(range) + 3, length: 8)
        changed()
    }
}

/// The body's text view: notices width changes (cards are full width) and
/// copies, cuts and pastes markdown, so a card pastes back as its source.
final class BodyTextView: UITextView {
    var onWidthChange: (() -> Void)?
    private var lastWidth: CGFloat = 0

    override func layoutSubviews() {
        super.layoutSubviews()
        if abs(bounds.width - lastWidth) > 0.5 {
            lastWidth = bounds.width
            onWidthChange?()
        }
    }

    private func hasEmbeds(in range: NSRange) -> Bool {
        var found = false
        textStorage.enumerateAttribute(.attachment, in: range) { value, _, stop in
            if value != nil { found = true; stop.pointee = true }
        }
        return found
    }

    override func copy(_ sender: Any?) {
        let range = selectedRange
        guard range.length > 0, hasEmbeds(in: range) else { return super.copy(sender) }
        UIPasteboard.general.string = EmbedProjection.source(of: textStorage.attributedSubstring(from: range))
    }

    override func cut(_ sender: Any?) {
        let range = selectedRange
        guard range.length > 0, hasEmbeds(in: range), let selection = selectedTextRange else { return super.cut(sender) }
        copy(sender)
        replace(selection, withText: "")
        delegate?.textViewDidChange?(self)
    }

    override func paste(_ sender: Any?) {
        // Plain text only: a foreign attachment has no markdown behind it.
        guard let string = UIPasteboard.general.string, let selection = selectedTextRange else { return super.paste(sender) }
        replace(selection, withText: string)
        delegate?.textViewDidChange?(self)
    }
}

/// The markdown body: styled as you type, with a formatting bar above the
/// keyboard. Inside a form it grows with its content; full screen it scrolls.
/// With `embeds`, components, images and other non-text elements show as
/// cards and pills (see BodyEmbeds.swift) while the source stays markdown.
struct MarkdownTextView: UIViewRepresentable {
    let text: String
    let controller: MarkdownEditorController
    var scrolls = false
    var monospaced = false
    var styled = true
    var embeds = false

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> UITextView {
        let textView = BodyTextView()
        textView.delegate = context.coordinator
        textView.isScrollEnabled = scrolls
        // Inside the form a nearby bar's edge effect would draw over the
        // text; the full-screen editor keeps its soft edge under the nav bar.
        if !scrolls { textView.hideScrollEdgeEffects() }
        textView.backgroundColor = .clear
        textView.font = monospaced
            ? .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize * 0.9, weight: .regular)
            : .preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        textView.textContainerInset = scrolls ? UIEdgeInsets(top: 16, left: 12, bottom: 40, right: 12) : .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.smartQuotesType = .no
        textView.smartDashesType = .no
        textView.smartInsertDeleteType = .no
        textView.autocapitalizationType = monospaced ? .none : .sentences
        textView.autocorrectionType = monospaced ? .no : .default
        textView.keyboardDismissMode = .interactive
        textView.alwaysBounceVertical = scrolls
        textView.text = text
        textView.inputAccessoryView = styled ? context.coordinator.makeToolbar() : nil
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        controller.textView = textView
        controller.coordinator = context.coordinator
        context.coordinator.textView = textView
        if styled { MarkdownStyler.style(textView) }
        if embeds {
            // Dragging would carry cards out as bare attachments.
            textView.textDragInteraction?.isEnabled = false
            let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
            tap.delegate = context.coordinator
            textView.addGestureRecognizer(tap)
            let coordinator = context.coordinator
            textView.onWidthChange = { [weak coordinator, weak textView] in
                guard let textView else { return }
                coordinator?.renderAttachments(in: textView)
            }
            textView.registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: UITextView, _: UITraitCollection) in
                coordinator.renderAttachments(in: view)
            }
            // Hidden until its cards are in, so raw JSX doesn't flash.
            textView.alpha = 0
            Task { @MainActor in
                coordinator.setSource(text, in: textView)
                try? await Task.sleep(for: .seconds(1))
                textView.alpha = 1
            }
        }
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.parent = self
        controller.textView = textView
        controller.coordinator = context.coordinator
        // Only external changes (pull, raw edits) replace the text; typing is
        // already in the view.
        guard !textView.isFirstResponder else { return }
        if embeds {
            if EmbedProjection.source(of: textView.textStorage) != text {
                context.coordinator.setSource(text, in: textView)
            }
        } else if textView.text != text {
            textView.text = text
            if styled { MarkdownStyler.style(textView) }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView textView: UITextView, context: Context) -> CGSize? {
        guard !scrolls, let width = proposal.width, width > 0 else { return nil }
        if embeds {
            context.coordinator.layoutWidth = width
            context.coordinator.renderAttachments(in: textView)
        }
        let size = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: max(size.height, 160))
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        var parent: MarkdownTextView
        weak var textView: UITextView?
        /// The width SwiftUI offered the growing (form) text view.
        var layoutWidth: CGFloat?
        private var scanTask: Task<Void, Never>?
        private var pendingSource: String?

        init(parent: MarkdownTextView) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            textChanged(textView)
        }

        func textChanged(_ textView: UITextView) {
            if parent.styled { MarkdownStyler.style(textView) }
            parent.controller.onChange?(parent.embeds ? EmbedProjection.source(of: textView.textStorage) : textView.text)
            if parent.embeds { scheduleEmbedScan(after: 0.5) }
            scrollCaretIntoView(textView)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            if parent.embeds { markSelectedAttachments(in: textView) }
            scrollCaretIntoView(textView)
        }

        /// Backspace next to a card selects it; a second Backspace deletes it.
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard parent.embeds, text.isEmpty, range.length == 1, textView.selectedRange.length == 0,
                  range.location < textView.textStorage.length,
                  textView.textStorage.attribute(.attachment, at: range.location, effectiveRange: nil) is EmbedAttachment
            else { return true }
            textView.selectedRange = range
            return false
        }

        // MARK: Embeds

        /// Shows `source` (a document load or an external change) once its
        /// cards are known, unless the user typed in the meantime.
        func setSource(_ source: String, in textView: UITextView) {
            guard pendingSource != source else { return }
            pendingSource = source
            let shown = EmbedProjection.source(of: textView.textStorage)
            guard parent.embeds, let load = parent.controller.loadEmbeds else {
                apply(source, embeds: [], to: textView, caret: nil)
                pendingSource = nil
                return
            }
            Task { @MainActor in
                let embeds = await load(source)
                if self.pendingSource == source { self.pendingSource = nil }
                guard EmbedProjection.source(of: textView.textStorage) == shown else { return }
                self.apply(source, embeds: embeds, to: textView, caret: nil)
            }
        }

        func replaceSource(_ range: NSRange, with string: String, in textView: UITextView) {
            let shown = EmbedProjection.source(of: textView.textStorage)
            let text = shown as NSString
            guard NSMaxRange(range) <= text.length else { return }
            let next = text.replacingCharacters(in: range, with: string)
            let caret = range.location + (string as NSString).length
            let load = parent.embeds ? parent.controller.loadEmbeds : nil
            Task { @MainActor in
                let embeds = await load?(next) ?? []
                guard EmbedProjection.source(of: textView.textStorage) == shown else { return }
                self.apply(next, embeds: embeds, to: textView, caret: caret)
                self.parent.controller.onChange?(next)
            }
        }

        /// Turns completed elements typed (or inserted) as text into cards,
        /// and cards whose context changed back into text or the other shape.
        func scheduleEmbedScan(after delay: Double) {
            guard parent.embeds else { return }
            scanTask?.cancel()
            scanTask = Task { @MainActor [weak self] in
                if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
                guard !Task.isCancelled, let self, let textView = self.textView,
                      let load = self.parent.controller.loadEmbeds else { return }
                let storage = textView.textStorage
                let source = EmbedProjection.source(of: storage)
                let embeds = await load(source)
                guard !Task.isCancelled, EmbedProjection.source(of: storage) == source else { return }
                let fresh = embeds.map { EmbedProjection.key(start: $0.start, end: $0.end, embed: $0) }
                guard fresh != EmbedProjection.shownKeys(in: storage) else { return }
                let caret = EmbedProjection.sourceOffset(in: storage, display: NSMaxRange(textView.selectedRange))
                self.apply(source, embeds: embeds, to: textView, caret: caret)
            }
        }

        private func apply(_ source: String, embeds: [BodyEmbed], to textView: UITextView, caret: Int?) {
            let storage = textView.textStorage
            let previousCaret = EmbedProjection.sourceOffset(in: storage, display: textView.selectedRange.location)
            let font = textView.font ?? .preferredFont(forTextStyle: .body)
            let projected = EmbedProjection.project(source, embeds: parent.embeds ? embeds : [], attributes: [.font: font, .foregroundColor: UIColor.label])
            storage.beginEditing()
            storage.setAttributedString(projected)
            storage.endEditing()
            renderAttachments(in: textView)
            if parent.styled { MarkdownStyler.style(textView) }
            let target = min(caret ?? previousCaret, (source as NSString).length)
            textView.selectedRange = NSRange(location: EmbedProjection.displayOffset(in: storage, source: target), length: 0)
            // Programmatic edits leave UIKit's undo ranges stale.
            textView.undoManager?.removeAllActions()
            textView.invalidateIntrinsicContentSize()
            textView.alpha = 1
        }

        private func embedWidth(_ textView: UITextView) -> CGFloat {
            let insets = textView.textContainerInset.left + textView.textContainerInset.right + 2 * textView.textContainer.lineFragmentPadding
            let viewWidth = parent.scrolls ? textView.bounds.width : (layoutWidth ?? textView.bounds.width)
            let width = floor(viewWidth - insets - 1)
            return width > 60 ? width : 320
        }

        /// Draws every card and pill for the current width and appearance.
        func renderAttachments(in textView: UITextView) {
            let width = embedWidth(textView)
            let font = UIFont.preferredFont(forTextStyle: .body, compatibleWith: textView.traitCollection)
            var changed: [NSRange] = []
            for (attachment, range) in EmbedProjection.attachments(in: textView.textStorage) {
                if attachment.embed.kind == "image", attachment.thumbnail == nil {
                    if let cached = EmbedThumbnails.shared.cached(attachment.embed.image) {
                        attachment.thumbnail = cached
                    } else {
                        EmbedThumbnails.shared.load(attachment.embed.image) { [weak self, weak textView] in
                            guard let self, let textView else { return }
                            self.renderAttachments(in: textView)
                        }
                    }
                }
                let before = attachment.image
                attachment.render(
                    width: width,
                    fontSize: font.pointSize,
                    capHeight: font.capHeight,
                    dark: textView.traitCollection.userInterfaceStyle == .dark,
                    scale: textView.traitCollection.displayScale
                )
                if attachment.image !== before { changed.append(range) }
            }
            guard !changed.isEmpty else { return }
            let storage = textView.textStorage
            storage.beginEditing()
            for range in changed where NSMaxRange(range) <= storage.length {
                storage.edited(.editedAttributes, range: range, changeInLength: 0)
            }
            storage.endEditing()
            textView.invalidateIntrinsicContentSize()
        }

        private func markSelectedAttachments(in textView: UITextView) {
            let selection = textView.selectedRange
            var dirty = false
            for (attachment, range) in EmbedProjection.attachments(in: textView.textStorage) {
                let selected = selection.length > 0 && selection.location <= range.location && NSMaxRange(selection) >= NSMaxRange(range)
                if attachment.isSelected != selected {
                    attachment.isSelected = selected
                    dirty = true
                }
            }
            if dirty { renderAttachments(in: textView) }
        }

        // MARK: Tapping a card

        @objc func tapped(_ gesture: UITapGestureRecognizer) {
            guard let textView = gesture.view as? UITextView,
                  let (attachment, range) = attachment(at: gesture.location(in: textView), in: textView)
            else { return }
            parent.controller.textView = textView
            parent.controller.open(attachment, at: range)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard let textView = gestureRecognizer.view as? UITextView else { return false }
            return attachment(at: touch.location(in: textView), in: textView) != nil
        }

        private func attachment(at point: CGPoint, in textView: UITextView) -> (EmbedAttachment, NSRange)? {
            let storage = textView.textStorage
            guard storage.length > 0, let position = textView.closestPosition(to: point) else { return nil }
            let offset = textView.offset(from: textView.beginningOfDocument, to: position)
            for candidate in [offset, offset - 1] where candidate >= 0 && candidate < storage.length {
                guard let attachment = storage.attribute(.attachment, at: candidate, effectiveRange: nil) as? EmbedAttachment,
                      let start = textView.position(from: textView.beginningOfDocument, offset: candidate),
                      let end = textView.position(from: start, offset: 1),
                      let range = textView.textRange(from: start, to: end)
                else { continue }
                let rect = textView.firstRect(for: range)
                if !rect.isNull, rect.insetBy(dx: -2, dy: -2).contains(point) {
                    return (attachment, NSRange(location: candidate, length: 1))
                }
            }
            return nil
        }

        /// A growing text view inside a form doesn't scroll itself; keep the
        /// caret visible in the enclosing scroll view.
        private func scrollCaretIntoView(_ textView: UITextView) {
            guard !parent.scrolls, textView.isFirstResponder, let caret = textView.selectedTextRange?.end else { return }
            DispatchQueue.main.async {
                var container = textView.superview
                while let view = container, !(view is UIScrollView) { container = view.superview }
                guard let scrollView = container as? UIScrollView else { return }
                let rect = textView.caretRect(for: caret).insetBy(dx: 0, dy: -24)
                scrollView.scrollRectToVisible(textView.convert(rect, to: scrollView), animated: false)
            }
        }

        func makeToolbar() -> UIToolbar {
            let toolbar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
            let controller = parent.controller
            // Each item carries a title as well as its symbol: the bar shows
            // the symbol, and the overflow menu (iOS 26 collapses what doesn't
            // fit into "•••") and VoiceOver use the title.
            func item(_ symbol: String, _ label: String, _ action: @escaping () -> Void) -> UIBarButtonItem {
                UIBarButtonItem(title: label, image: UIImage(systemName: symbol), primaryAction: UIAction { _ in action() })
            }
            func menuItem(_ symbol: String, _ label: String, _ menu: UIMenu) -> UIBarButtonItem {
                let button = UIBarButtonItem(title: label, image: UIImage(systemName: symbol), menu: menu)
                // Menus open upward from the keyboard; keep them in reading
                // order (Heading 1 on top) rather than nearest-first.
                button.preferredMenuElementOrder = .fixed
                return button
            }
            let headings = UIMenu(title: "Heading", children: (1...4).map { level in
                UIAction(title: "Heading \(level)", image: UIImage(systemName: "\(level).square")) { _ in
                    controller.prefixLines(String(repeating: "#", count: level) + " ")
                }
            })
            let heading = menuItem("textformat.size", "Heading", headings)
            let lists = UIMenu(children: [
                UIAction(title: "Bulleted List", image: UIImage(systemName: "list.bullet")) { _ in controller.prefixLines("- ") },
                UIAction(title: "Numbered List", image: UIImage(systemName: "list.number")) { _ in controller.prefixLines("1. ") },
                UIAction(title: "Quote", image: UIImage(systemName: "text.quote")) { _ in controller.prefixLines("> ") },
                UIAction(title: "Code Block", image: UIImage(systemName: "curlybraces")) { _ in controller.insert("```\n\n```", asBlock: true) },
                UIAction(title: "Divider", image: UIImage(systemName: "minus")) { _ in controller.insert("---", asBlock: true) },
            ])
            let block = menuItem("list.bullet", "Blocks", lists)
            var items: [UIBarButtonItem] = [
                heading,
                item("bold", "Bold") { controller.wrap("**", placeholder: "bold") },
                item("italic", "Italic") { controller.wrap("_", placeholder: "italic") },
                block,
                item("link", "Link") { controller.insertLink() },
                item("photo", "Insert media") { controller.onRequestImage?() },
            ]
            if controller.componentsEnabled {
                let components = UIMenu(children: [
                    UIAction(title: "Insert Component", image: UIImage(systemName: "plus.square.on.square")) { _ in
                        controller.onRequestComponent?()
                    },
                    UIAction(title: "Edit Component at Cursor", image: UIImage(systemName: "slider.horizontal.3")) { _ in
                        controller.requestEditComponent()
                    },
                ])
                let component = menuItem("square.on.square", "Components", components)
                items.append(component)
            }
            items.append(.flexibleSpace())
            items.append(item("keyboard.chevron.compact.down", "Hide keyboard") { controller.textView?.resignFirstResponder() })
            let spaced = items.flatMap { [$0, .fixedSpace(4)] }.dropLast()
            toolbar.items = Array(spaced)
            toolbar.sizeToFit()
            return toolbar
        }
    }
}

/// Live markdown styling: headings, emphasis, code, links, quotes, list
/// markers, and MDX/HTML tags. Text is never changed, only attributes, so
/// the caret and undo stay put.
@MainActor
enum MarkdownStyler {
    private static let rules: [(NSRegularExpression, (UIFont) -> [NSAttributedString.Key: Any])] = {
        func regex(_ pattern: String, _ options: NSRegularExpression.Options = [.anchorsMatchLines]) -> NSRegularExpression {
            try! NSRegularExpression(pattern: pattern, options: options)
        }
        let secondary: [NSAttributedString.Key: Any] = [.foregroundColor: UIColor.secondaryLabel]
        return [
            (regex(#"^#{1,6} .*$"#), { font in
                [.font: UIFont.systemFont(ofSize: font.pointSize * 1.18, weight: .bold)]
            }),
            (regex(#"\*\*[^*\n]+\*\*|__[^_\n]+__"#), { font in
                [.font: UIFont.systemFont(ofSize: font.pointSize, weight: .semibold)]
            }),
            (regex(#"(?<![*\w])\*[^*\s][^*\n]*\*(?!\*)|(?<![_\w])_[^_\s][^_\n]*_(?!\w)"#), { font in
                [.font: font.withTraits(.traitItalic)]
            }),
            (regex(#"`[^`\n]+`"#), { font in
                [.font: UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.92, weight: .regular),
                 .backgroundColor: UIColor.tertiarySystemFill]
            }),
            (regex(#"^```[\s\S]*?^```"#, [.anchorsMatchLines]), { font in
                [.font: UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.88, weight: .regular),
                 .foregroundColor: UIColor.secondaryLabel]
            }),
            (regex(#"!?\[[^\]\n]*\]\([^)\n]*\)"#), { _ in [.foregroundColor: UIColor.tintColor] }),
            (regex(#"^> .*$"#), { _ in secondary }),
            (regex(#"^\s*([-*+]|\d+\.) "#), { _ in [.foregroundColor: UIColor.tintColor] }),
            (regex(#"</?[A-Za-z][\w.:-]*(?:\s[^<>]*)?/?>"#), { font in
                [.foregroundColor: UIColor.systemPurple,
                 .font: UIFont.monospacedSystemFont(ofSize: font.pointSize * 0.9, weight: .regular)]
            }),
        ]
    }()

    static func style(_ textView: UITextView) {
        let storage = textView.textStorage
        let full = NSRange(location: 0, length: storage.length)
        // Not textView.font: with mixed attributes it reports the font near
        // the caret, so a restyle inside bold text would make everything bold
        // (and inside a heading, grow with every keystroke).
        let base = UIFont.preferredFont(forTextStyle: .body, compatibleWith: textView.traitCollection)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        // Cards and pills are attachments; resetting attributes keeps them.
        var attachments: [(Any, NSRange)] = []
        storage.enumerateAttribute(.attachment, in: full) { value, range, _ in
            if let value { attachments.append((value, range)) }
        }
        storage.beginEditing()
        storage.setAttributes([.font: base, .foregroundColor: UIColor.label, .paragraphStyle: paragraph], range: full)
        for (attachment, range) in attachments { storage.addAttribute(.attachment, value: attachment, range: range) }
        let text = storage.string
        for (expression, attributes) in rules {
            for match in expression.matches(in: text, range: full) {
                storage.addAttributes(attributes(base), range: match.range)
            }
        }
        storage.endEditing()
        textView.typingAttributes = [.font: base, .foregroundColor: UIColor.label, .paragraphStyle: paragraph]
    }
}

private extension UIFont {
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        guard let descriptor = fontDescriptor.withSymbolicTraits(fontDescriptor.symbolicTraits.union(traits)) else { return self }
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
