import Foundation

/// The text edits behind the body's formatting commands, worked out on the
/// text the editor shows (each card or pill one attachment character), for
/// both the iOS and the macOS text view. Edits only insert and remove
/// markers, never retype the text between them, so cards and pills inside
/// a selection keep their source.
enum MarkdownEdits {
    struct Edit {
        let range: NSRange
        let replacement: String
    }

    /// Edits to apply in order (each range is as the text is when its turn
    /// comes: they run from the end of the text backwards), then the
    /// selection to set.
    struct Plan {
        let edits: [Edit]
        let selection: NSRange
    }

    enum Emphasis {
        case bold, italic, strikethrough

        /// What a new run is written with.
        var marker: String {
            switch self {
            case .bold: return "**"
            case .italic: return "_"
            case .strikethrough: return "~~"
            }
        }

        var placeholder: String {
            switch self {
            case .bold: return "bold"
            case .italic: return "italic"
            case .strikethrough: return "strikethrough"
            }
        }

        /// Every way the style is written. Group 1 is the opening marker
        /// (the closing one matches it), group 2 the styled text.
        fileprivate var runs: [NSRegularExpression] {
            switch self {
            case .bold: return [Self.boldRun]
            case .italic: return Self.italicRuns
            case .strikethrough: return [Self.strikethroughRun]
            }
        }

        private static let boldRun = try! NSRegularExpression(pattern: #"(\*\*|__)(?=\S)(.+?)(?<=\S)\1"#)
        // A single `*` or `_` that isn't half of a bold marker.
        private static let italicRuns = [
            try! NSRegularExpression(pattern: #"(?<![\w_\\])(_)(?![\s_])(.+?)(?<![\s\\_])_(?![\w_])"#),
            try! NSRegularExpression(pattern: #"(?<![*\\])(\*)(?![\s*])(.+?)(?<![\s\\*])\*(?!\*)"#),
        ]
        private static let strikethroughRun = try! NSRegularExpression(pattern: #"(~~)(?=\S)(.+?)(?<=\S)~~"#)

        /// Markers that may sit right around the selection (an empty run
        /// left by deleting its placeholder, say).
        fileprivate var markers: [String] {
            switch self {
            case .bold: return ["**", "__"]
            case .italic: return ["_", "*"]
            case .strikethrough: return ["~~"]
            }
        }
    }

    /// Bold, italic or strikethrough on and off, as the desktop toolbar's
    /// toggles: inside a run of the style (or with the whole run selected),
    /// its markers go; otherwise the selection is wrapped, or a placeholder
    /// inserted and selected.
    static func toggle(_ style: Emphasis, in text: NSString, selection: NSRange) -> Plan {
        if let run = run(of: style, in: text, around: selection) {
            let marker = run.opening.length
            let selected = selection == run.whole
                ? NSRange(location: run.whole.location, length: run.content.length)
                : NSRange(location: selection.location - marker, length: selection.length)
            return Plan(edits: [
                Edit(range: NSRange(location: NSMaxRange(run.content), length: marker), replacement: ""),
                Edit(range: run.opening, replacement: ""),
            ], selection: selected)
        }
        let marker = style.marker
        let length = (marker as NSString).length
        // Spaces at the ends stay outside: `** bold**` isn't bold.
        let target = trimmed(selection, in: text)
        if target.length == 0 {
            let placeholder = style.placeholder
            return Plan(
                edits: [Edit(range: NSRange(location: selection.location, length: selection.length), replacement: marker + placeholder + marker)],
                selection: NSRange(location: selection.location + length, length: (placeholder as NSString).length)
            )
        }
        return Plan(edits: [
            Edit(range: NSRange(location: NSMaxRange(target), length: 0), replacement: marker),
            Edit(range: NSRange(location: target.location, length: 0), replacement: marker),
        ], selection: NSRange(location: target.location + length, length: target.length))
    }

    /// Whether the selection is in a run of `style`: the toggle shows as on,
    /// and removes it.
    static func isActive(_ style: Emphasis, in text: NSString, selection: NSRange) -> Bool {
        run(of: style, in: text, around: selection) != nil
    }

    private struct Run {
        let whole: NSRange
        let opening: NSRange
        let content: NSRange
    }

    /// The run of `style` the selection is in (or is exactly).
    private static func run(of style: Emphasis, in text: NSString, around selection: NSRange) -> Run? {
        let end = NSMaxRange(selection)
        guard end <= text.length else { return nil }
        // Markers right around the selection, even with nothing between.
        for marker in style.markers {
            let length = (marker as NSString).length
            guard selection.location >= length, end + length <= text.length,
                  text.substring(with: NSRange(location: selection.location - length, length: length)) == marker,
                  text.substring(with: NSRange(location: end, length: length)) == marker
            else { continue }
            // A lone `*` or `_` next to another is part of a bolder marker.
            if length == 1 {
                let before = selection.location - 2
                let after = end + 1
                if before >= 0, text.substring(with: NSRange(location: before, length: 1)) == marker { continue }
                if after < text.length, text.substring(with: NSRange(location: after, length: 1)) == marker { continue }
            }
            return Run(
                whole: NSRange(location: selection.location - length, length: selection.length + 2 * length),
                opening: NSRange(location: selection.location - length, length: length),
                content: selection
            )
        }
        let lines = text.lineRange(for: selection)
        for expression in style.runs {
            for match in expression.matches(in: text as String, range: lines) {
                let content = match.range(at: 2)
                let inside = selection.location >= content.location && end <= NSMaxRange(content)
                if inside || selection == match.range {
                    return Run(whole: match.range, opening: match.range(at: 1), content: content)
                }
            }
        }
        return nil
    }

    private static func trimmed(_ range: NSRange, in text: NSString) -> NSRange {
        var start = range.location
        var end = NSMaxRange(range)
        let spaces = CharacterSet.whitespacesAndNewlines
        func isSpace(_ index: Int) -> Bool {
            guard let scalar = UnicodeScalar(text.character(at: index)) else { return false }
            return spaces.contains(scalar)
        }
        while start < end, isSpace(start) { start += 1 }
        while end > start, isSpace(end - 1) { end -= 1 }
        return NSRange(location: start, length: end - start)
    }

    // A link (not an image): `[text](destination "title")`.
    private static let link = try! NSRegularExpression(
        pattern: #"(?<!!)\[((?:\\.|[^\]\\\n])*)\]\((?:<[^>\n]*>|[^\s()\n]*(?:\([^\s()\n]*\)[^\s()\n]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)"#
    )

    /// Removes the link at the selection, keeping its text (the desktop
    /// toolbar's Unlink); nil when the selection isn't in a link.
    static func unlink(in text: NSString, selection: NSRange) -> Plan? {
        let end = NSMaxRange(selection)
        guard end <= text.length else { return nil }
        for match in link.matches(in: text as String, range: text.lineRange(for: selection)) {
            let whole = match.range
            guard selection.location >= whole.location, end <= NSMaxRange(whole) else { continue }
            let label = match.range(at: 1)
            return Plan(edits: [
                Edit(range: NSRange(location: NSMaxRange(label), length: NSMaxRange(whole) - NSMaxRange(label)), replacement: ""),
                Edit(range: NSRange(location: whole.location, length: 1), replacement: ""),
            ], selection: NSRange(location: whole.location, length: label.length))
        }
        return nil
    }

    /// The heading level (1–6) of the line the selection starts on, or nil.
    static func headingLevel(in text: NSString, selection: NSRange) -> Int? {
        let line = text.lineRange(for: NSRange(location: min(selection.location, text.length), length: 0))
        guard let match = heading.firstMatch(in: text as String, range: line) else { return nil }
        return match.range(at: 1).length
    }

    private static let heading = try! NSRegularExpression(pattern: #"^(#{1,6}) "#)

    // Quote, list and heading markers that open a line.
    private static let lineMarkers = try! NSRegularExpression(
        pattern: #"^(?:[ \t]*>[ \t]?)*(?:[ \t]*(?:[-*+]|\d+[.)])[ \t]+)?(?:#{1,6}(?:[ \t]+|$))?"#
    )

    /// Whether the caret at `location` is inside written text, where the
    /// desktop editor inserts components and HTML inline: its line holds
    /// more than markers, spaces and full-width cards (`isCard`).
    static func caretInsideText(_ text: NSString, at location: Int, isCard: (Int) -> Bool) -> Bool {
        let at = min(max(location, 0), text.length)
        var line = text.lineRange(for: NSRange(location: at, length: 0))
        while line.length > 0, let last = UnicodeScalar(text.character(at: NSMaxRange(line) - 1)),
              CharacterSet.newlines.contains(last) {
            line.length -= 1
        }
        let markers = lineMarkers.firstMatch(in: text as String, range: line)?.range.length ?? 0
        for index in (line.location + markers)..<NSMaxRange(line) {
            let character = text.character(at: index)
            if character == 0x20 || character == 0x09 { continue }
            if character == 0xFFFC, isCard(index) { continue }
            return true
        }
        return false
    }

    /// `snippet` with blank lines around it, so it stands as its own block
    /// at `range` of `text`.
    static func block(_ snippet: String, in text: NSString, replacing range: NSRange) -> String {
        let before = range.location > 0 ? text.substring(to: range.location) : ""
        let after = text.substring(from: min(text.length, NSMaxRange(range)))
        var insertion = snippet
        if !before.isEmpty && !before.hasSuffix("\n\n") { insertion = (before.hasSuffix("\n") ? "\n" : "\n\n") + insertion }
        if !after.hasPrefix("\n\n") { insertion += after.hasPrefix("\n") ? "\n" : "\n\n" }
        return insertion
    }
}
