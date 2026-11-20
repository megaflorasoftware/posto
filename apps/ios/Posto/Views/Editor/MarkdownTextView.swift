import SwiftUI
import UIKit

/// Shared handle so SwiftUI sheets (image and component pickers) can insert
/// into the text view the keyboard toolbar belongs to.
@MainActor
final class MarkdownEditorController {
    weak var textView: UITextView?
    var onChange: ((String) -> Void)?
    var onRequestImage: (() -> Void)?
    var onRequestComponent: (() -> Void)?
    /// Edit the component around the caret: (body text, UTF-16 offset).
    var onRequestEditComponent: ((String, Int) -> Void)?
    var componentsEnabled = false

    func requestEditComponent() {
        guard let textView else { return }
        onRequestEditComponent?(textView.text, textView.selectedRange.location)
    }

    /// Replaces a UTF-16 range of the body (an edited component block).
    func replace(range: NSRange, with string: String) {
        replace(range, with: string, selecting: NSRange(location: range.location + (string as NSString).length, length: 0))
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
    }

    func replace(_ range: NSRange, with string: String, selecting selection: NSRange?) {
        guard let textView,
              let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
              let end = textView.position(from: start, offset: range.length),
              let textRange = textView.textRange(from: start, to: end)
        else { return }
        textView.replace(textRange, withText: string)
        if let selection { textView.selectedRange = selection }
        changed()
    }

    func changed() {
        guard let textView else { return }
        MarkdownStyler.style(textView)
        onChange?(textView.text)
    }

    // MARK: Formatting

    func wrap(_ marker: String, placeholder: String) {
        guard let textView else { return }
        let range = textView.selectedRange
        let selected = (textView.text as NSString).substring(with: range)
        let body = selected.isEmpty ? placeholder : selected
        let replacement = marker + body + marker
        let selection = NSRange(location: range.location + marker.count, length: (body as NSString).length)
        replace(range, with: replacement, selecting: selection)
    }

    /// Toggles a prefix on every selected line (`# `, `- `, `> `, `1. `).
    func prefixLines(_ prefix: String) {
        guard let textView else { return }
        let text = textView.text as NSString
        let lines = text.lineRange(for: textView.selectedRange)
        let block = text.substring(with: lines)
        let hasTrailingNewline = block.hasSuffix("\n")
        let content = hasTrailingNewline ? String(block.dropLast()) : block
        let split = content.components(separatedBy: "\n")
        let allPrefixed = split.allSatisfy { $0.hasPrefix(prefix) }
        let updated = split.map { line -> String in
            if allPrefixed { return String(line.dropFirst(prefix.count)) }
            let stripped = line.replacingOccurrences(of: #"^(#{1,6} |[-*+] |> |\d+\. )"#, with: "", options: .regularExpression)
            return prefix + stripped
        }.joined(separator: "\n") + (hasTrailingNewline ? "\n" : "")
        let caret = NSRange(location: lines.location + (updated as NSString).length - (hasTrailingNewline ? 1 : 0), length: 0)
        replace(lines, with: updated, selecting: caret)
    }

    func insertLink() {
        guard let textView else { return }
        let range = textView.selectedRange
        let selected = (textView.text as NSString).substring(with: range)
        let label = selected.isEmpty ? "link text" : selected
        let replacement = "[\(label)](https://)"
        let urlStart = range.location + (label as NSString).length + 3
        replace(range, with: replacement, selecting: NSRange(location: urlStart, length: 8))
    }
}

/// The markdown body: styled as you type, with a formatting bar above the
/// keyboard. Inside a form it grows with its content; full screen it scrolls.
struct MarkdownTextView: UIViewRepresentable {
    let text: String
    let controller: MarkdownEditorController
    var scrolls = false
    var monospaced = false
    var styled = true

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.delegate = context.coordinator
        textView.isScrollEnabled = scrolls
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
        if styled { MarkdownStyler.style(textView) }
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.parent = self
        controller.textView = textView
        // Only external changes (pull, raw edits) replace the text; typing is
        // already in the view.
        if textView.text != text && !textView.isFirstResponder {
            textView.text = text
            if styled { MarkdownStyler.style(textView) }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView textView: UITextView, context: Context) -> CGSize? {
        guard !scrolls, let width = proposal.width, width > 0 else { return nil }
        let size = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: max(size.height, 160))
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MarkdownTextView

        init(parent: MarkdownTextView) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            if parent.styled { MarkdownStyler.style(textView) }
            parent.controller.onChange?(textView.text)
            scrollCaretIntoView(textView)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            scrollCaretIntoView(textView)
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
            func item(_ symbol: String, _ label: String, _ action: @escaping () -> Void) -> UIBarButtonItem {
                let button = UIBarButtonItem(image: UIImage(systemName: symbol), primaryAction: UIAction { _ in action() })
                button.accessibilityLabel = label
                return button
            }
            let headings = UIMenu(title: "Heading", children: (1...4).map { level in
                UIAction(title: "Heading \(level)", image: UIImage(systemName: "\(level).square")) { _ in
                    controller.prefixLines(String(repeating: "#", count: level) + " ")
                }
            })
            let heading = UIBarButtonItem(image: UIImage(systemName: "textformat.size"), menu: headings)
            heading.accessibilityLabel = "Heading"
            let lists = UIMenu(children: [
                UIAction(title: "Bulleted List", image: UIImage(systemName: "list.bullet")) { _ in controller.prefixLines("- ") },
                UIAction(title: "Numbered List", image: UIImage(systemName: "list.number")) { _ in controller.prefixLines("1. ") },
                UIAction(title: "Quote", image: UIImage(systemName: "text.quote")) { _ in controller.prefixLines("> ") },
                UIAction(title: "Code Block", image: UIImage(systemName: "curlybraces")) { _ in controller.insert("```\n\n```", asBlock: true) },
                UIAction(title: "Divider", image: UIImage(systemName: "minus")) { _ in controller.insert("---", asBlock: true) },
            ])
            let block = UIBarButtonItem(image: UIImage(systemName: "list.bullet"), menu: lists)
            block.accessibilityLabel = "Blocks"
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
                let component = UIBarButtonItem(image: UIImage(systemName: "square.on.square"), menu: components)
                component.accessibilityLabel = "Components"
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
        let base = textView.font ?? .preferredFont(forTextStyle: .body)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        storage.beginEditing()
        storage.setAttributes([.font: base, .foregroundColor: UIColor.label, .paragraphStyle: paragraph], range: full)
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
