import AppKit
import SwiftUI

// The macOS body editor: the same API as the iOS MarkdownTextView (an
// NSTextView instead of a UITextView), so EditorView and the sheets are
// shared. Cards and pills use the same projection (BodyEmbeds.swift).

/// Shared handle so SwiftUI sheets (image and component pickers) and the
/// formatting bar can edit the body's text view.
@MainActor
final class MarkdownEditorController {
    weak var textView: NSTextView?
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
    /// A card or pill was clicked: (it, the body source, its source range).
    var onOpenEmbed: ((EmbedAttachment, String, NSRange) -> Void)?
    var componentsEnabled = false

    private var storage: NSTextStorage? { textView?.textStorage }

    /// The markdown in the text view, with cards and pills read as source.
    var sourceText: String {
        storage.map(EmbedProjection.source(of:)) ?? ""
    }

    func requestEditComponent() {
        guard let textView, let storage else { return }
        let selected = textView.selectedRange()
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
        guard let storage else { return }
        onOpenEmbed?(attachment, EmbedProjection.source(of: storage), EmbedProjection.sourceRange(in: storage, display: displayRange))
    }

    /// Replaces a range of the markdown source (an edited, rewritten or
    /// removed card) and shows the result with its cards.
    func replaceSource(_ range: NSRange, with string: String) {
        guard let textView, let coordinator else { return }
        coordinator.replaceSource(range, with: string, in: textView)
    }

    func replace(range: NSRange, with string: String) {
        replaceSource(range, with: string)
    }

    /// Inserts at the caret; blocks get blank lines around them.
    func insert(_ snippet: String, asBlock: Bool = false) {
        guard let textView else { return }
        let text = textView.string as NSString
        let range = textView.selectedRange()
        var insertion = snippet
        if asBlock {
            let before = range.location > 0 ? text.substring(with: NSRange(location: 0, length: range.location)) : ""
            let after = text.substring(from: min(text.length, range.location + range.length))
            if !before.isEmpty && !before.hasSuffix("\n\n") { insertion = (before.hasSuffix("\n") ? "\n" : "\n\n") + insertion }
            if !after.hasPrefix("\n\n") { insertion += after.hasPrefix("\n") ? "\n" : "\n\n" }
        }
        replace(range, with: insertion, selecting: nil)
        coordinator?.scheduleEmbedScan(after: 0)
    }

    func replace(_ range: NSRange, with string: String, selecting selection: NSRange?) {
        edit(range, with: string)
        if let selection { textView?.setSelectedRange(selection) }
        changed()
    }

    /// Replaces display text as a user edit (undoable), without notifying.
    private func edit(_ range: NSRange, with string: String) {
        guard let textView, let storage, NSMaxRange(range) <= storage.length else { return }
        guard textView.shouldChangeText(in: range, replacementString: string) else { return }
        coordinator?.suppressNotifications = true
        storage.replaceCharacters(in: range, with: NSAttributedString(string: string, attributes: textView.typingAttributes))
        textView.didChangeText()
        coordinator?.suppressNotifications = false
    }

    func changed() {
        guard let textView else { return }
        coordinator?.textChanged(textView)
    }

    // MARK: Formatting

    func wrap(_ marker: String, placeholder: String) {
        guard let textView else { return }
        let range = textView.selectedRange()
        let length = (marker as NSString).length
        if range.length == 0 {
            let selection = NSRange(location: range.location + length, length: (placeholder as NSString).length)
            replace(range, with: marker + placeholder + marker, selecting: selection)
            return
        }
        edit(NSRange(location: NSMaxRange(range), length: 0), with: marker)
        edit(NSRange(location: range.location, length: 0), with: marker)
        textView.setSelectedRange(NSRange(location: range.location + length, length: range.length))
        changed()
    }

    /// Toggles a prefix on every selected line (`# `, `- `, `> `, `1. `).
    func prefixLines(_ prefix: String) {
        guard let textView else { return }
        let text = textView.string as NSString
        let block = text.lineRange(for: textView.selectedRange())
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
        textView.setSelectedRange(NSRange(location: last.location + shift + last.length + deltas[deltas.count - 1], length: 0))
        changed()
    }

    func insertLink() {
        guard let textView else { return }
        let range = textView.selectedRange()
        if range.length == 0 {
            replace(range, with: "[link text](https://)", selecting: NSRange(location: range.location + 12, length: 8))
            return
        }
        edit(NSRange(location: NSMaxRange(range), length: 0), with: "](https://)")
        edit(NSRange(location: range.location, length: 0), with: "[")
        textView.setSelectedRange(NSRange(location: NSMaxRange(range) + 3, length: 8))
        changed()
    }
}

/// The body's text view: copies, cuts and pastes markdown, so a card pastes
/// back as its source.
final class BodyNSTextView: NSTextView {
    var onWidthChange: (() -> Void)?
    private var lastWidth: CGFloat = 0

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        if abs(newSize.width - lastWidth) > 0.5 {
            lastWidth = newSize.width
            onWidthChange?()
        }
    }

    private func hasEmbeds(in range: NSRange) -> Bool {
        guard let storage = textStorage else { return false }
        var found = false
        storage.enumerateAttribute(.attachment, in: range) { value, _, stop in
            if value != nil { found = true; stop.pointee = true }
        }
        return found
    }

    override func copy(_ sender: Any?) {
        let range = selectedRange()
        guard range.length > 0, hasEmbeds(in: range), let storage = textStorage else { return super.copy(sender) }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(EmbedProjection.source(of: storage.attributedSubstring(from: range)), forType: .string)
    }

    override func cut(_ sender: Any?) {
        let range = selectedRange()
        guard range.length > 0, hasEmbeds(in: range) else { return super.cut(sender) }
        copy(sender)
        insertText("", replacementRange: range)
    }

    override func paste(_ sender: Any?) {
        // Plain text only: a foreign attachment has no markdown behind it.
        pasteAsPlainText(sender)
    }
}

/// The markdown body: styled as you type. Inside the form it grows with its
/// content; full screen it scrolls. With `embeds`, components, images and
/// other non-text elements show as cards and pills while the source stays
/// markdown.
struct MarkdownTextView: NSViewRepresentable {
    let text: String
    let controller: MarkdownEditorController
    var scrolls = false
    var monospaced = false
    var styled = true
    var embeds = false

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    private var baseFont: NSFont {
        monospaced
            ? .monospacedSystemFont(ofSize: NSFont.systemFontSize + 1, weight: .regular)
            : .systemFont(ofSize: NSFont.systemFontSize + 2)
    }

    func makeNSView(context: Context) -> NSView {
        let textView = BodyNSTextView(usingTextLayoutManager: false)
        textView.delegate = context.coordinator
        textView.isRichText = true
        textView.importsGraphics = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.font = baseFont
        textView.textColor = .labelColor
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isContinuousSpellCheckingEnabled = !monospaced
        textView.textContainerInset = scrolls ? NSSize(width: 24, height: 20) : NSSize(width: 0, height: 4)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.string = text
        controller.textView = textView
        controller.coordinator = context.coordinator
        context.coordinator.textView = textView
        if styled { MarkdownStyler.style(textView) }
        if embeds {
            let coordinator = context.coordinator
            textView.onWidthChange = { [weak coordinator, weak textView] in
                guard let textView else { return }
                coordinator?.renderAttachments(in: textView)
            }
            textView.alphaValue = 0
            Task { @MainActor in
                coordinator.setSource(text, in: textView)
                try? await Task.sleep(for: .seconds(1))
                textView.alphaValue = 1
            }
        }
        guard scrolls else { return textView }
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.documentView = textView
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        return scrollView
    }

    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.parent = self
        guard let textView = context.coordinator.textView else { return }
        controller.textView = textView
        controller.coordinator = context.coordinator
        // Only external changes (pull, raw edits) replace the text; typing is
        // already in the view.
        guard textView.window?.firstResponder !== textView else { return }
        if embeds {
            if let storage = textView.textStorage, EmbedProjection.source(of: storage) != text {
                context.coordinator.setSource(text, in: textView)
            }
        } else if textView.string != text {
            textView.string = text
            if styled { MarkdownStyler.style(textView) }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSView, context: Context) -> CGSize? {
        guard !scrolls, let width = proposal.width, width > 0,
              let textView = context.coordinator.textView,
              let container = textView.textContainer, let layout = textView.layoutManager
        else { return nil }
        if embeds {
            context.coordinator.layoutWidth = width
            context.coordinator.renderAttachments(in: textView)
        }
        container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let height = layout.usedRect(for: container).height + textView.textContainerInset.height * 2
        return CGSize(width: width, height: max(height, 160))
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MarkdownTextView
        weak var textView: NSTextView?
        var layoutWidth: CGFloat?
        /// Set while the controller makes a batch of edits.
        var suppressNotifications = false
        private var scanTask: Task<Void, Never>?
        private var pendingSource: String?

        init(parent: MarkdownTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard !suppressNotifications, let textView = notification.object as? NSTextView else { return }
            textChanged(textView)
        }

        func textChanged(_ textView: NSTextView) {
            if parent.styled { MarkdownStyler.style(textView) }
            let source = parent.embeds ? textView.textStorage.map(EmbedProjection.source(of:)) ?? "" : textView.string
            parent.controller.onChange?(source)
            if parent.embeds { scheduleEmbedScan(after: 0.5) }
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard parent.embeds, let textView = notification.object as? NSTextView else { return }
            markSelectedAttachments(in: textView)
        }

        /// Delete next to a card selects it; a second Delete removes it.
        func textView(_ textView: NSTextView, shouldChangeTextIn range: NSRange, replacementString text: String?) -> Bool {
            guard parent.embeds, text == "", range.length == 1, textView.selectedRange().length == 0,
                  let storage = textView.textStorage, range.location < storage.length,
                  storage.attribute(.attachment, at: range.location, effectiveRange: nil) is EmbedAttachment
            else { return true }
            textView.setSelectedRange(range)
            return false
        }

        /// Clicking a card or pill opens its editor.
        func textView(_ textView: NSTextView, clickedOn cell: any NSTextAttachmentCellProtocol, in cellFrame: NSRect, at charIndex: Int) {
            guard let storage = textView.textStorage, charIndex < storage.length,
                  let attachment = storage.attribute(.attachment, at: charIndex, effectiveRange: nil) as? EmbedAttachment
            else { return }
            parent.controller.textView = textView
            parent.controller.open(attachment, at: NSRange(location: charIndex, length: 1))
        }

        // MARK: Embeds

        func setSource(_ source: String, in textView: NSTextView) {
            guard pendingSource != source, let storage = textView.textStorage else { return }
            pendingSource = source
            let shown = EmbedProjection.source(of: storage)
            guard parent.embeds, let load = parent.controller.loadEmbeds else {
                apply(source, embeds: [], to: textView, caret: nil)
                pendingSource = nil
                return
            }
            Task { @MainActor in
                let embeds = await load(source)
                if self.pendingSource == source { self.pendingSource = nil }
                guard EmbedProjection.source(of: storage) == shown else { return }
                self.apply(source, embeds: embeds, to: textView, caret: nil)
            }
        }

        func replaceSource(_ range: NSRange, with string: String, in textView: NSTextView) {
            guard let storage = textView.textStorage else { return }
            let shown = EmbedProjection.source(of: storage)
            let text = shown as NSString
            guard NSMaxRange(range) <= text.length else { return }
            let next = text.replacingCharacters(in: range, with: string)
            let caret = range.location + (string as NSString).length
            let load = parent.embeds ? parent.controller.loadEmbeds : nil
            Task { @MainActor in
                let embeds = await load?(next) ?? []
                guard EmbedProjection.source(of: storage) == shown else { return }
                self.apply(next, embeds: embeds, to: textView, caret: caret)
                self.parent.controller.onChange?(next)
            }
        }

        func scheduleEmbedScan(after delay: Double) {
            guard parent.embeds else { return }
            scanTask?.cancel()
            scanTask = Task { @MainActor [weak self] in
                if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
                guard !Task.isCancelled, let self, let textView = self.textView, let storage = textView.textStorage,
                      let load = self.parent.controller.loadEmbeds else { return }
                let source = EmbedProjection.source(of: storage)
                let embeds = await load(source)
                guard !Task.isCancelled, EmbedProjection.source(of: storage) == source else { return }
                let fresh = embeds.map { EmbedProjection.key(start: $0.start, end: $0.end, embed: $0) }
                guard fresh != EmbedProjection.shownKeys(in: storage) else { return }
                let caret = EmbedProjection.sourceOffset(in: storage, display: NSMaxRange(textView.selectedRange()))
                self.apply(source, embeds: embeds, to: textView, caret: caret)
            }
        }

        private func apply(_ source: String, embeds: [BodyEmbed], to textView: NSTextView, caret: Int?) {
            guard let storage = textView.textStorage else { return }
            let previousCaret = EmbedProjection.sourceOffset(in: storage, display: textView.selectedRange().location)
            let font = textView.font ?? .systemFont(ofSize: NSFont.systemFontSize + 2)
            let projected = EmbedProjection.project(source, embeds: parent.embeds ? embeds : [], attributes: [.font: font, .foregroundColor: NSColor.labelColor])
            suppressNotifications = true
            storage.beginEditing()
            storage.setAttributedString(projected)
            storage.endEditing()
            suppressNotifications = false
            renderAttachments(in: textView)
            if parent.styled { MarkdownStyler.style(textView) }
            let target = min(caret ?? previousCaret, (source as NSString).length)
            textView.setSelectedRange(NSRange(location: EmbedProjection.displayOffset(in: storage, source: target), length: 0))
            textView.undoManager?.removeAllActions()
            textView.alphaValue = 1
            textView.invalidateIntrinsicContentSize()
            textView.enclosingScrollView?.invalidateIntrinsicContentSize()
        }

        private func embedWidth(_ textView: NSTextView) -> CGFloat {
            let inset = textView.textContainerInset.width * 2 + 2 * (textView.textContainer?.lineFragmentPadding ?? 0)
            let viewWidth = parent.scrolls ? (textView.enclosingScrollView?.contentSize.width ?? textView.bounds.width) : (layoutWidth ?? textView.bounds.width)
            let width = floor(min(viewWidth - inset - 1, 720))
            return width > 60 ? width : 420
        }

        func renderAttachments(in textView: NSTextView) {
            guard let storage = textView.textStorage else { return }
            let width = embedWidth(textView)
            let font = textView.font ?? .systemFont(ofSize: NSFont.systemFontSize + 2)
            let dark = textView.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let scale = textView.window?.backingScaleFactor ?? 2
            var changed: [NSRange] = []
            for (attachment, range) in EmbedProjection.attachments(in: storage) {
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
                attachment.render(width: width, fontSize: font.pointSize, capHeight: font.capHeight, dark: dark, scale: scale)
                if attachment.image !== before { changed.append(range) }
            }
            guard !changed.isEmpty, let layout = textView.layoutManager else { return }
            for range in changed where NSMaxRange(range) <= storage.length {
                layout.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
                layout.invalidateDisplay(forCharacterRange: range)
            }
            textView.invalidateIntrinsicContentSize()
        }

        private func markSelectedAttachments(in textView: NSTextView) {
            guard let storage = textView.textStorage else { return }
            let selection = textView.selectedRange()
            var dirty = false
            for (attachment, range) in EmbedProjection.attachments(in: storage) {
                let selected = selection.length > 0 && selection.location <= range.location && NSMaxRange(selection) >= NSMaxRange(range)
                if attachment.isSelected != selected {
                    attachment.isSelected = selected
                    dirty = true
                }
            }
            if dirty { renderAttachments(in: textView) }
        }
    }
}

/// The formatting bar above the body (the iOS keyboard bar's commands),
/// with the usual shortcuts.
struct MarkdownFormatBar: View {
    let controller: MarkdownEditorController

    var body: some View {
        HStack(spacing: 2) {
            Menu {
                ForEach(1...4, id: \.self) { level in
                    Button("Heading \(level)") { controller.prefixLines(String(repeating: "#", count: level) + " ") }
                }
            } label: {
                Label("Heading", systemImage: "textformat.size")
            }
            .menuIndicator(.hidden)
            .fixedSize()
            button("Bold", "bold", "b") { controller.wrap("**", placeholder: "bold") }
            button("Italic", "italic", "i") { controller.wrap("_", placeholder: "italic") }
            Menu {
                Button("Bulleted List") { controller.prefixLines("- ") }
                Button("Numbered List") { controller.prefixLines("1. ") }
                Button("Quote") { controller.prefixLines("> ") }
                Button("Code Block") { controller.insert("```\n\n```", asBlock: true) }
                Button("Divider") { controller.insert("---", asBlock: true) }
            } label: {
                Label("Blocks", systemImage: "list.bullet")
            }
            .menuIndicator(.hidden)
            .fixedSize()
            button("Link", "link", "k") { controller.insertLink() }
            button("Insert Media", "photo", nil) { controller.onRequestImage?() }
            if controller.componentsEnabled {
                Menu {
                    Button("Insert Component") { controller.onRequestComponent?() }
                    Button("Edit Component at Cursor") { controller.requestEditComponent() }
                } label: {
                    Label("Components", systemImage: "square.on.square")
                }
                .menuIndicator(.hidden)
                .fixedSize()
            }
            Spacer(minLength: 0)
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .controlSize(.regular)
    }

    private func button(_ title: String, _ symbol: String, _ key: KeyEquivalent?, action: @escaping () -> Void) -> some View {
        let button = Button(action: action) { Label(title, systemImage: symbol) }
            .help(title)
        return Group {
            if let key { button.keyboardShortcut(key, modifiers: .command) } else { button }
        }
    }
}

/// Live markdown styling: headings, emphasis, code, links, quotes, list
/// markers, and MDX/HTML tags. Text is never changed, only attributes.
@MainActor
enum MarkdownStyler {
    private static let rules: [(NSRegularExpression, (NSFont) -> [NSAttributedString.Key: Any])] = {
        func regex(_ pattern: String, _ options: NSRegularExpression.Options = [.anchorsMatchLines]) -> NSRegularExpression {
            try! NSRegularExpression(pattern: pattern, options: options)
        }
        let secondary: [NSAttributedString.Key: Any] = [.foregroundColor: NSColor.secondaryLabelColor]
        return [
            (regex(#"^#{1,6} .*$"#), { font in [.font: NSFont.systemFont(ofSize: font.pointSize * 1.25, weight: .bold)] }),
            (regex(#"\*\*[^*\n]+\*\*|__[^_\n]+__"#), { font in [.font: NSFont.systemFont(ofSize: font.pointSize, weight: .semibold)] }),
            (regex(#"(?<![*\w])\*[^*\s][^*\n]*\*(?!\*)|(?<![_\w])_[^_\s][^_\n]*_(?!\w)"#), { font in
                [.font: NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)]
            }),
            (regex(#"`[^`\n]+`"#), { font in
                [.font: NSFont.monospacedSystemFont(ofSize: font.pointSize * 0.92, weight: .regular),
                 .backgroundColor: NSColor.quaternaryLabelColor.withAlphaComponent(0.3)]
            }),
            (regex(#"^```[\s\S]*?^```"#, [.anchorsMatchLines]), { font in
                [.font: NSFont.monospacedSystemFont(ofSize: font.pointSize * 0.88, weight: .regular),
                 .foregroundColor: NSColor.secondaryLabelColor]
            }),
            (regex(#"!?\[[^\]\n]*\]\([^)\n]*\)"#), { _ in [.foregroundColor: NSColor.controlAccentColor] }),
            (regex(#"^> .*$"#), { _ in secondary }),
            (regex(#"^\s*([-*+]|\d+\.) "#), { _ in [.foregroundColor: NSColor.controlAccentColor] }),
            (regex(#"</?[A-Za-z][\w.:-]*(?:\s[^<>]*)?/?>"#), { font in
                [.foregroundColor: NSColor.systemPurple,
                 .font: NSFont.monospacedSystemFont(ofSize: font.pointSize * 0.9, weight: .regular)]
            }),
        ]
    }()

    static func style(_ textView: NSTextView) {
        guard let storage = textView.textStorage else { return }
        let full = NSRange(location: 0, length: storage.length)
        let base = NSFont.systemFont(ofSize: NSFont.systemFontSize + 2)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 4
        var attachments: [(Any, NSRange)] = []
        storage.enumerateAttribute(.attachment, in: full) { value, range, _ in
            if let value { attachments.append((value, range)) }
        }
        storage.beginEditing()
        storage.setAttributes([.font: base, .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph], range: full)
        for (attachment, range) in attachments { storage.addAttribute(.attachment, value: attachment, range: range) }
        let text = storage.string
        for (expression, attributes) in rules {
            for match in expression.matches(in: text, range: full) {
                storage.addAttributes(attributes(base), range: match.range)
            }
        }
        storage.endEditing()
        textView.typingAttributes = [.font: base, .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph]
    }
}
