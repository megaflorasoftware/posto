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
    /// Only the Mac's bar asks; on iOS, tapping a component's card edits it.
    var onRequestEditComponent: ((String, Int) -> Void)?
    /// Scans a body for its cards and pills (the engine's `body.embeds`);
    /// nil when the scan failed, so the cards shown are left alone.
    var loadEmbeds: ((String) async -> [BodyEmbed]?)? {
        didSet { coordinator?.scheduleEmbedScan(after: 0) }
    }
    /// A card or pill was tapped: (it, the body source, its source range).
    var onOpenEmbed: ((EmbedAttachment, String, NSRange) -> Void)?
    var componentsEnabled = false {
        didSet { if componentsEnabled != oldValue { coordinator?.refreshBar() } }
    }

    /// The markdown in the text view, with cards and pills read as source.
    var sourceText: String {
        guard let textView else { return "" }
        return EmbedProjection.source(of: textView.textStorage)
    }

    /// Set while a sheet has the keyboard: the body was being edited.
    private var resumesAfterSheet = false

    /// Ends editing (the keyboard goes); the selection stays for inserts.
    func endEditing() {
        guard let textView, textView.isFirstResponder else { return }
        resumesAfterSheet = true
        textView.resignFirstResponder()
    }

    /// After the sheet that ended editing has closed (nested sheets
    /// included): the keyboard comes back at the caret, after any insert.
    func resumeEditing() {
        guard resumesAfterSheet else { return }
        resumesAfterSheet = false
        textView?.becomeFirstResponder()
    }

    func open(_ attachment: EmbedAttachment, at displayRange: NSRange) {
        guard let textView else { return }
        let storage = textView.textStorage
        onOpenEmbed?(attachment, EmbedProjection.source(of: storage), EmbedProjection.sourceRange(in: storage, display: displayRange))
    }

    /// Replaces a range of the markdown source (an edited, rewritten or
    /// removed card) and shows the result with its cards. `original` is what
    /// the range held when the card was opened; when the body has changed
    /// underneath since (a reload while a sheet was up), nothing is replaced
    /// and this returns false.
    @discardableResult
    func replaceSource(_ range: NSRange, with string: String, expecting original: String? = nil) -> Bool {
        guard let textView, let coordinator else { return false }
        return coordinator.replaceSource(range, with: string, expecting: original, in: textView)
    }

    /// Inserts at the caret; blocks get blank lines around them. In a body
    /// with cards, the insert shows as its card right away and undoes in
    /// one step, like a sheet's edit.
    func insert(_ snippet: String, asBlock: Bool = false) {
        guard let textView else { return }
        let storage = textView.textStorage
        let range = textView.selectedRange
        if let coordinator, coordinator.parent.embeds {
            let source = EmbedProjection.source(of: storage) as NSString
            let sourceRange = EmbedProjection.sourceRange(in: storage, display: range)
            let insertion = asBlock ? MarkdownEdits.block(snippet, in: source, replacing: sourceRange) : snippet
            if coordinator.replaceSource(sourceRange, with: insertion, expecting: nil, in: textView) { return }
        }
        let text = textView.text as NSString
        replace(range, with: asBlock ? MarkdownEdits.block(snippet, in: text, replacing: range) : snippet, selecting: nil)
    }

    /// Whether the caret is inside written text, where components and HTML
    /// go inline (as on desktop) rather than as a block of their own.
    var caretInsideText: Bool {
        guard let textView else { return false }
        let storage = textView.textStorage
        return MarkdownEdits.caretInsideText(textView.text as NSString, at: textView.selectedRange.location) { index in
            (storage.attribute(.attachment, at: index, effectiveRange: nil) as? EmbedAttachment)?.embed.isCard == true
        }
    }

    /// An empty HTML element to fill in (the desktop toolbar's Insert HTML):
    /// a `<span>` inside text, a `<div>` block elsewhere.
    func insertHtml() {
        if caretInsideText {
            insert("<span></span>")
        } else {
            insert("<div>\n</div>", asBlock: true)
        }
    }

    func undo() {
        guard let manager = textView?.undoManager, manager.canUndo else { return }
        manager.undo()
    }

    func redo() {
        guard let manager = textView?.undoManager, manager.canRedo else { return }
        manager.redo()
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

    private func apply(_ plan: MarkdownEdits.Plan) {
        guard let textView else { return }
        for step in plan.edits { edit(step.range, with: step.replacement) }
        textView.selectedRange = plan.selection
        changed()
    }

    /// Bold, italic or strikethrough on, or off inside a run of it.
    func toggle(_ style: MarkdownEdits.Emphasis) {
        guard let textView else { return }
        apply(MarkdownEdits.toggle(style, in: textView.text as NSString, selection: textView.selectedRange))
    }

    func isActive(_ style: MarkdownEdits.Emphasis) -> Bool {
        guard let textView else { return false }
        return MarkdownEdits.isActive(style, in: textView.text as NSString, selection: textView.selectedRange)
    }

    var isInLink: Bool {
        guard let textView else { return false }
        return MarkdownEdits.unlink(in: textView.text as NSString, selection: textView.selectedRange) != nil
    }

    /// Removes the link around the selection, keeping its text.
    func unlink() {
        guard let textView,
              let plan = MarkdownEdits.unlink(in: textView.text as NSString, selection: textView.selectedRange)
        else { return }
        apply(plan)
    }

    /// The link button: removes the link the caret is in, else adds one.
    func toggleLink() {
        if isInLink { unlink() } else { insertLink() }
    }

    var headingLevel: Int? {
        guard let textView else { return nil }
        return MarkdownEdits.headingLevel(in: textView.text as NSString, selection: textView.selectedRange)
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
        // A card's line keeps its shape: `# ` before a multi-line component
        // would leave its closing tag outside the heading and break the MDX.
        let storage = textView.textStorage
        lines.removeAll { line in
            (0..<line.length).contains { offset in
                (storage.attribute(.attachment, at: line.location + offset, effectiveRange: nil) as? EmbedAttachment)?.embed.block == true
            }
        }
        guard !lines.isEmpty else { return }
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

/// The body's text view: notices width changes (cards are full width),
/// copies, cuts and pastes markdown, so a card pastes back as its source,
/// and takes the formatting shortcuts of a hardware keyboard.
final class BodyTextView: UITextView {
    var onWidthChange: (() -> Void)?
    /// Set on a markdown body: ⌘B, ⌘I, ⇧⌘X and ⌘K format it (as on the Mac,
    /// only while it has focus), and ⌘Z/⇧⌘Z step through its undo history.
    weak var formatting: MarkdownTextView.Coordinator?
    private var lastWidth: CGFloat = 0

    override var keyCommands: [UIKeyCommand]? {
        guard formatting != nil else { return super.keyCommands }
        func command(_ title: String, _ input: String, _ flags: UIKeyModifierFlags, _ action: Selector) -> UIKeyCommand {
            let command = UIKeyCommand(title: title, action: action, input: input, modifierFlags: flags)
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
        return (super.keyCommands ?? []) + [
            command("Bold", "b", .command, #selector(boldCommand)),
            command("Italic", "i", .command, #selector(italicCommand)),
            command("Strikethrough", "x", [.command, .shift], #selector(strikethroughCommand)),
            command("Link", "k", .command, #selector(linkCommand)),
            command("Undo", "z", .command, #selector(undoCommand)),
            command("Redo", "z", [.command, .shift], #selector(redoCommand)),
        ]
    }

    @objc private func boldCommand() { formatting?.format { $0.toggle(.bold) } }
    @objc private func italicCommand() { formatting?.format { $0.toggle(.italic) } }
    @objc private func strikethroughCommand() { formatting?.format { $0.toggle(.strikethrough) } }
    @objc private func linkCommand() { formatting?.format { $0.toggleLink() } }
    @objc private func undoCommand() { formatting?.format { $0.undo() } }
    @objc private func redoCommand() { formatting?.format { $0.redo() } }

    // The edit menu's Bold and Italic (and the system's ⌘B, ⌘I) write
    // markdown too, rather than attributes the source can't keep.
    override func toggleBoldface(_ sender: Any?) {
        guard formatting != nil else { return super.toggleBoldface(sender) }
        boldCommand()
    }

    override func toggleItalics(_ sender: Any?) {
        guard formatting != nil else { return super.toggleItalics(sender) }
        italicCommand()
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if formatting != nil, action == #selector(toggleBoldface(_:)) || action == #selector(toggleItalics(_:)) {
            return isEditable
        }
        return super.canPerformAction(action, withSender: sender)
    }

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
        context.coordinator.textView = textView
        textView.inputAccessoryView = styled ? context.coordinator.makeToolbar() : nil
        if styled { textView.formatting = context.coordinator }
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        controller.textView = textView
        controller.coordinator = context.coordinator
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
            updateBar()
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            if parent.embeds { markSelectedAttachments(in: textView) }
            scrollCaretIntoView(textView)
            updateBar()
        }

        /// The bar and shortcuts edit the body being typed in (the form's
        /// and the full-screen editor share a controller).
        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.controller.textView = textView
            parent.controller.coordinator = self
            refreshBar()
        }

        /// Runs a formatting command on this coordinator's text view.
        func format(_ command: (MarkdownEditorController) -> Void) {
            guard let textView else { return }
            let controller = parent.controller
            controller.textView = textView
            controller.coordinator = self
            command(controller)
            updateBar()
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
                apply(source, embeds: [], to: textView, caret: nil, undo: .clear)
                pendingSource = nil
                return
            }
            Task { @MainActor in
                let embeds = await load(source) ?? []
                if self.pendingSource == source { self.pendingSource = nil }
                guard EmbedProjection.source(of: textView.textStorage) == shown else { return }
                self.apply(source, embeds: embeds, to: textView, caret: nil, undo: .clear)
            }
        }

        private static func holds(_ text: String, _ range: NSRange, _ original: String?) -> Bool {
            let text = text as NSString
            guard NSMaxRange(range) <= text.length else { return false }
            return original.map { text.substring(with: range) == $0 } ?? true
        }

        func replaceSource(_ range: NSRange, with string: String, expecting original: String?, in textView: UITextView) -> Bool {
            let shown = EmbedProjection.source(of: textView.textStorage)
            guard Self.holds(shown, range, original) else { return false }
            let expected = original ?? (shown as NSString).substring(with: range)
            let caret = range.location + (string as NSString).length
            let load = parent.embeds ? parent.controller.loadEmbeds : nil
            Task { @MainActor in
                // Typing during the scan: retry on the newer text while the
                // range still holds what was edited.
                var current = shown
                for _ in 0..<3 {
                    let next = (current as NSString).replacingCharacters(in: range, with: string)
                    let embeds = await load?(next) ?? []
                    let now = EmbedProjection.source(of: textView.textStorage)
                    if now == current {
                        self.apply(next, embeds: embeds, to: textView, caret: caret, undo: .edit)
                        self.parent.controller.onChange?(next)
                        return
                    }
                    guard Self.holds(now, range, expected) else { return }
                    current = now
                }
            }
            return true
        }

        // MARK: Undo
        // Showing new cards replaces the text view's contents, which leaves
        // UIKit's typing steps pointing at stale ranges, so they're cleared
        // then. What they did isn't lost: the body keeps its own steps (a
        // sheet's edit, an insert, the typing up to a new card), registers
        // them again after each clear, and restores whole snapshots, which
        // stay valid.

        enum UndoRecord {
            /// A load or a change from outside: no history before it.
            case clear
            /// Only the cards changed (typed text became one): the typing
            /// since the last clear becomes one step.
            case fold
            /// An edit of the source (a sheet, an insert): a step of its
            /// own, after one for the typing before it.
            case edit
        }

        private struct UndoStep {
            let id = UUID()
            let before: NSAttributedString
            let after: NSAttributedString
        }

        /// The body's steps on the undo stack, oldest first.
        private var undoSteps: [UndoStep] = []
        /// The text when UIKit's steps were last cleared.
        private var undoBaseline: NSAttributedString?

        private func record(_ kind: UndoRecord, before: NSAttributedString, after: NSAttributedString, in textView: UITextView) {
            func foldTyping(upTo text: NSAttributedString) {
                guard let baseline = undoBaseline,
                      EmbedProjection.source(of: baseline) != EmbedProjection.source(of: text) else { return }
                undoSteps.append(UndoStep(before: baseline, after: text))
            }
            switch kind {
            case .clear:
                undoSteps.removeAll()
            case .fold:
                foldTyping(upTo: after)
            case .edit:
                foldTyping(upTo: before)
                undoSteps.append(UndoStep(before: before, after: after))
            }
            if undoSteps.count > 100 { undoSteps.removeFirst(undoSteps.count - 100) }
            undoBaseline = after
            guard let manager = textView.undoManager else { return }
            manager.removeAllActions()
            // One undo group per step, rather than one for everything
            // registered in this event.
            let byEvent = manager.groupsByEvent
            manager.groupsByEvent = false
            for step in undoSteps {
                manager.beginUndoGrouping()
                register(step, undoing: true, in: textView)
                manager.endUndoGrouping()
            }
            manager.groupsByEvent = byEvent
        }

        private func register(_ step: UndoStep, undoing: Bool, in textView: UITextView) {
            textView.undoManager?.registerUndo(withTarget: self) { [weak textView] coordinator in
                guard let textView else { return }
                coordinator.perform(step, undoing: undoing, in: textView)
            }
        }

        /// Undoes or redoes one of the body's steps.
        private func perform(_ step: UndoStep, undoing: Bool, in textView: UITextView) {
            register(step, undoing: !undoing, in: textView)
            if undoing {
                if let index = undoSteps.lastIndex(where: { $0.id == step.id }) { undoSteps.removeSubrange(index...) }
            } else {
                undoSteps.append(step)
            }
            let snapshot = undoing ? step.before : step.after
            let storage = textView.textStorage
            let previous = storage.string as NSString
            textView.inputDelegate?.textWillChange(textView)
            storage.beginEditing()
            storage.setAttributedString(snapshot)
            storage.endEditing()
            textView.inputDelegate?.textDidChange(textView)
            undoBaseline = snapshot
            renderAttachments(in: textView)
            if parent.styled { MarkdownStyler.style(textView) }
            // The caret goes to the end of what changed back.
            let next = storage.string as NSString
            var prefix = 0
            while prefix < min(previous.length, next.length), previous.character(at: prefix) == next.character(at: prefix) { prefix += 1 }
            var suffix = 0
            while suffix < min(previous.length, next.length) - prefix,
                  previous.character(at: previous.length - 1 - suffix) == next.character(at: next.length - 1 - suffix) { suffix += 1 }
            textView.selectedRange = NSRange(location: max(prefix, next.length - suffix), length: 0)
            textView.invalidateIntrinsicContentSize()
            parent.controller.onChange?(EmbedProjection.source(of: storage))
            scrollCaretIntoView(textView)
            updateBar()
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
                // Mid-composition (Japanese, Chinese…), swapping the text
                // would break the candidate the user is choosing.
                if textView.markedTextRange != nil {
                    self.scheduleEmbedScan(after: 0.5)
                    return
                }
                let storage = textView.textStorage
                let source = EmbedProjection.source(of: storage)
                // A failed scan leaves the cards as they are.
                guard let embeds = await load(source) else { return }
                guard !Task.isCancelled, textView.markedTextRange == nil,
                      EmbedProjection.source(of: storage) == source else { return }
                let fresh = embeds.map { EmbedProjection.key(start: $0.start, end: $0.end, embed: $0) }
                guard fresh != EmbedProjection.shownKeys(in: storage) else { return }
                let caret = EmbedProjection.sourceOffset(in: storage, display: NSMaxRange(textView.selectedRange))
                self.apply(source, embeds: embeds, to: textView, caret: caret, undo: .fold)
            }
        }

        private func apply(_ source: String, embeds: [BodyEmbed], to textView: UITextView, caret: Int?, undo: UndoRecord) {
            let storage = textView.textStorage
            let before = NSAttributedString(attributedString: storage)
            let previousCaret = EmbedProjection.sourceOffset(in: storage, display: textView.selectedRange.location)
            let font = textView.font ?? .preferredFont(forTextStyle: .body)
            let shown = EmbedProjection.attachments(in: storage).map(\.0)
            let projected = EmbedProjection.project(source, embeds: parent.embeds ? embeds : [], attributes: [.font: font, .foregroundColor: UIColor.label], reusing: shown)
            // The keyboard learns the text changed, so autocorrect and
            // predictions don't work from an outdated copy.
            textView.inputDelegate?.textWillChange(textView)
            storage.beginEditing()
            storage.setAttributedString(projected)
            storage.endEditing()
            textView.inputDelegate?.textDidChange(textView)
            renderAttachments(in: textView)
            if parent.styled { MarkdownStyler.style(textView) }
            let target = min(caret ?? previousCaret, (source as NSString).length)
            textView.selectedRange = NSRange(location: EmbedProjection.displayOffset(in: storage, source: target), length: 0)
            record(undo, before: before, after: NSAttributedString(attributedString: storage), in: textView)
            textView.invalidateIntrinsicContentSize()
            textView.alpha = 1
            updateBar()
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

        // MARK: The formatting bar

        private weak var toolbar: UIToolbar?
        private weak var boldItem: UIBarButtonItem?
        private weak var italicItem: UIBarButtonItem?
        private weak var linkItem: UIBarButtonItem?
        /// Whether the bar was built with the component button.
        private var barHasComponents: Bool?

        /// The bar above the keyboard, a few points clear of it.
        func makeToolbar() -> UIView {
            let toolbar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
            self.toolbar = toolbar
            buildBar()
            toolbar.sizeToFit()
            return KeyboardBarHost(toolbar: toolbar, gap: 8)
        }

        /// The bar's items: few enough to fit an iPhone, with the rarer
        /// commands in the Format menu. Each item has a title as well as its
        /// symbol: the bar shows the symbol, and VoiceOver and the overflow
        /// menu (iOS 26 collapses what doesn't fit into "•••", from the end)
        /// use the title.
        private func buildBar() {
            guard let toolbar else { return }
            let components = parent.controller.componentsEnabled
            guard barHasComponents != components else { return }
            barHasComponents = components
            func item(_ symbol: String, _ title: String, _ command: @escaping (MarkdownEditorController) -> Void) -> UIBarButtonItem {
                UIBarButtonItem(title: title, image: UIImage(systemName: symbol), primaryAction: UIAction { [weak self] _ in
                    self?.format(command)
                })
            }
            let format = UIBarButtonItem(title: "Format", image: UIImage(systemName: "textformat"), menu: UIMenu(children: [
                // Built as it opens, so it shows the caret's heading and styles.
                UIDeferredMenuElement.uncached { [weak self] completion in completion(self?.formatMenu() ?? []) },
            ]))
            // Menus open upward from the keyboard; keep them in reading
            // order (Heading 1 above Heading 2) rather than nearest-first.
            format.preferredMenuElementOrder = .fixed
            let bold = item("bold", "Bold") { $0.toggle(.bold) }
            let italic = item("italic", "Italic") { $0.toggle(.italic) }
            let link = item("link", "Link") { $0.toggleLink() }
            boldItem = bold
            italicItem = italic
            linkItem = link
            var items = [format, bold, italic, link, item("photo", "Insert Media") { $0.onRequestImage?() }]
            items.append(.flexibleSpace())
            if components {
                // Tapping a component's card edits it, so "•••" only inserts.
                // An iPhone bar holds six items: past that the system folds
                // the rest into its own "•••", so this takes Hide Keyboard's
                // place (the keyboard still swipes away, interactively).
                let insertComponent = UIAction(title: "Insert Component", image: UIImage(systemName: "square.on.square")) { [weak self] _ in
                    self?.format { $0.onRequestComponent?() }
                }
                items.append(UIBarButtonItem(title: "More", image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: [insertComponent])))
            } else {
                items.append(item("keyboard.chevron.compact.down", "Hide Keyboard") { $0.textView?.resignFirstResponder() })
            }
            toolbar.items = items
            updateBar()
        }

        private func formatMenu() -> [UIMenuElement] {
            guard let textView else { return [] }
            let text = textView.text as NSString
            let selection = textView.selectedRange
            func action(_ title: String, _ symbol: String, on: Bool = false, _ command: @escaping (MarkdownEditorController) -> Void) -> UIAction {
                UIAction(title: title, image: UIImage(systemName: symbol), state: on ? .on : .off) { [weak self] _ in
                    self?.format(command)
                }
            }
            var styles = [
                action("Strikethrough", "strikethrough", on: MarkdownEdits.isActive(.strikethrough, in: text, selection: selection)) {
                    $0.toggle(.strikethrough)
                },
            ]
            if MarkdownEdits.unlink(in: text, selection: selection) != nil {
                styles.append(action("Remove Link", "minus.circle") { $0.unlink() })
            }
            let level = MarkdownEdits.headingLevel(in: text, selection: selection)
            let headings = (1...4).map { size in
                action("Heading \(size)", "\(size).square", on: level == size) {
                    $0.prefixLines(String(repeating: "#", count: size) + " ")
                }
            }
            let blocks = [
                action("Bulleted List", "list.bullet") { $0.prefixLines("- ") },
                action("Numbered List", "list.number") { $0.prefixLines("1. ") },
                action("Quote", "text.quote") { $0.prefixLines("> ") },
                action("Code Block", "curlybraces") { $0.insert("```\n\n```", asBlock: true) },
                action("Divider", "minus") { $0.insert("---", asBlock: true) },
            ]
            let insert = [action("Insert HTML", "chevron.left.forwardslash.chevron.right") { $0.insertHtml() }]
            return [styles, headings, blocks, insert].map { UIMenu(options: .displayInline, children: $0) }
        }

        /// Bold, Italic and Link show whether the caret is in one (tapping
        /// then takes it off).
        private func updateBar() {
            guard toolbar != nil, let textView else { return }
            let text = textView.text as NSString
            let selection = textView.selectedRange
            func set(_ item: UIBarButtonItem?, _ selected: Bool) {
                if let item, item.isSelected != selected { item.isSelected = selected }
            }
            set(boldItem, MarkdownEdits.isActive(.bold, in: text, selection: selection))
            set(italicItem, MarkdownEdits.isActive(.italic, in: text, selection: selection))
            let inLink = MarkdownEdits.unlink(in: text, selection: selection) != nil
            set(linkItem, inLink)
            let linkTitle = inLink ? "Remove Link" : "Link"
            if linkItem?.title != linkTitle { linkItem?.title = linkTitle }
        }

        /// The component button follows the document (wired after the text
        /// view is made).
        func refreshBar() {
            buildBar()
            updateBar()
        }
    }
}

/// Holds the formatting bar a few points above the keyboard rather than on
/// it; the gap doesn't take touches.
private final class KeyboardBarHost: UIView {
    private let toolbar: UIToolbar

    init(toolbar: UIToolbar, gap: CGFloat) {
        self.toolbar = toolbar
        super.init(frame: CGRect(x: 0, y: 0, width: toolbar.frame.width, height: toolbar.frame.height + gap))
        autoresizingMask = .flexibleWidth
        backgroundColor = .clear
        toolbar.frame = CGRect(x: 0, y: 0, width: bounds.width, height: toolbar.frame.height)
        toolbar.autoresizingMask = [.flexibleWidth, .flexibleBottomMargin]
        addSubview(toolbar)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        toolbar.frame.contains(point)
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
            (regex(#"~~[^~\n]+~~"#), { _ in [.strikethroughStyle: NSUnderlineStyle.single.rawValue] }),
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
