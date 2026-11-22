import Foundation
#if canImport(UIKit)
import UIKit

typealias TextStorageEditActions = NSTextStorage.EditActions
#else
import AppKit

typealias TextStorageEditActions = NSTextStorageEditActions
#endif

// Shared by the iOS and macOS body editors: after an edit, the styler
// restyles only the text around it rather than the whole body, so typing in
// a long document doesn't reset and lay out everything on each keystroke.

/// The characters edited since the body was last styled. As the text
/// storage's delegate it hears of every edit (typing, the bar's commands,
/// pastes, composition) as the edit is processed.
final class EditedRange: NSObject, NSTextStorageDelegate {
    /// In the text's current offsets; nil when nothing was edited.
    private(set) var range: NSRange?

    func textStorage(_ textStorage: NSTextStorage, didProcessEditing editedMask: TextStorageEditActions, range editedRange: NSRange, changeInLength delta: Int) {
        guard editedMask.contains(.editedCharacters) else { return }
        guard let previous = range else {
            range = editedRange
            return
        }
        // The earlier edit moves with the text after this one; an end
        // inside the replaced text lands at the end of what replaced it.
        let replacedEnd = NSMaxRange(editedRange) - delta
        func moved(_ offset: Int) -> Int {
            if offset <= editedRange.location { return offset }
            if offset >= replacedEnd { return offset + delta }
            return NSMaxRange(editedRange)
        }
        let start = moved(previous.location)
        let end = max(start, moved(NSMaxRange(previous)))
        range = NSUnionRange(NSRange(location: start, length: end - start), editedRange)
    }

    func reset() {
        range = nil
    }
}

enum MarkdownRestyle {
    /// Marks the styling of the rules that can run over several lines (tags
    /// and code blocks), so a restyle can take in one the edit broke.
    static let spansLines = NSAttributedString.Key("PostoSpansLines")

    private static let fenceLine = try! NSRegularExpression(pattern: "^```", options: [.anchorsMatchLines])
    /// The styler's own code block rule.
    private static let codeBlock = try! NSRegularExpression(pattern: #"^```[\s\S]*?^```"#, options: [.anchorsMatchLines])

    /// What to restyle after an edit: the blocks around it (lines up to
    /// the blank lines on either side, so a multi-line tag or list item
    /// stays whole), widened to any fenced code block they touch and to a
    /// tag crossing their ends, or the styling of one before the edit. All
    /// of the text without an edit, or when the fences changed, since a
    /// fence restyles everything after it. `styled` is the text as last
    /// styled (with the edits since); `fences` holds the fence count from
    /// the last styling, and is updated.
    ///
    /// The styler's other rules stay within a line, so styling these lines
    /// gives what styling everything would.
    static func scope(of edited: NSRange?, in text: NSString, styled: NSAttributedString, fences: inout Int?) -> NSRange {
        let full = NSRange(location: 0, length: text.length)
        let string = text as String
        let count = fenceLine.numberOfMatches(in: string, range: full)
        let previous = fences
        fences = count
        guard let edited, previous == count else { return full }
        let start = min(edited.location, text.length)
        let edit = NSRange(location: start, length: min(edited.length, text.length - start))
        if count > 0, fenceLine.firstMatch(in: string, range: text.lineRange(for: edit)) != nil {
            // Typed on a fence line (a language, a backtick): everything.
            return full
        }
        let codeBlocks = count > 0 ? codeBlock.matches(in: string, range: full).map { text.lineRange(for: $0.range) } : []
        // Each widening can reach another block or tag; until none does.
        var scope = blocks(around: edit, in: text)
        while true {
            var next = scope
            for block in codeBlocks where NSIntersectionRange(block, next).length > 0 || NSLocationInRange(next.location, block) {
                next = NSUnionRange(next, block)
            }
            next = widenedToTags(next, in: text)
            next = widenedToStyledSpans(next, in: styled, text: text)
            if next == scope { return scope }
            scope = next
        }
    }

    /// A tag or code block styled before the edit (which may have broken
    /// it) crossing either end of `scope`: its old styling is taken in, to
    /// be redone.
    private static func widenedToStyledSpans(_ scope: NSRange, in styled: NSAttributedString, text: NSString) -> NSRange {
        var start = scope.location
        var end = NSMaxRange(scope)
        guard styled.length == text.length else { return scope }
        var run = NSRange()
        if start > 0, styled.attribute(spansLines, at: start - 1, longestEffectiveRange: &run, in: NSRange(location: 0, length: start)) != nil {
            start = text.lineRange(for: NSRange(location: run.location, length: 0)).location
        }
        if end < text.length, styled.attribute(spansLines, at: end, longestEffectiveRange: &run, in: NSRange(location: end, length: text.length - end)) != nil {
            end = NSMaxRange(text.lineRange(for: NSRange(location: NSMaxRange(run) - 1, length: 0)))
        }
        return NSRange(location: start, length: end - start)
    }

    private static let angles = CharacterSet(charactersIn: "<>")

    /// A tag's attributes can run over lines, and blank lines
    /// (`<Card\n\n  big />`); one crossing either end of `scope` is taken in
    /// whole. A tag holds no `<` or `>` before its closing `>`, so one
    /// crosses the start when the last of them before it opens a tag, and
    /// the end when the last inside opens one and the first after is a `>`.
    private static func widenedToTags(_ scope: NSRange, in text: NSString) -> NSRange {
        var start = scope.location
        var end = NSMaxRange(scope)
        func opensTag(_ found: NSRange) -> Bool {
            guard found.location != NSNotFound, text.character(at: found.location) == UInt16(UInt8(ascii: "<")),
                  found.location + 1 < text.length,
                  let next = Unicode.Scalar(text.character(at: found.location + 1))
            else { return false }
            return next == "/" || (next.isASCII && CharacterSet.letters.contains(next))
        }
        let before = text.rangeOfCharacter(from: angles, options: .backwards, range: NSRange(location: 0, length: start))
        if opensTag(before) {
            start = text.lineRange(for: NSRange(location: before.location, length: 0)).location
        }
        // From the new start, so a tag opened before the scope counts.
        let inside = text.rangeOfCharacter(from: angles, options: .backwards, range: NSRange(location: start, length: end - start))
        if opensTag(inside) {
            let after = text.rangeOfCharacter(from: angles, range: NSRange(location: end, length: text.length - end))
            if after.location != NSNotFound, text.character(at: after.location) == UInt16(UInt8(ascii: ">")) {
                end = NSMaxRange(text.lineRange(for: NSRange(location: after.location, length: 0)))
            }
        }
        return NSRange(location: start, length: end - start)
    }

    /// The lines of `range`, and the lines around them up to a blank line.
    private static func blocks(around range: NSRange, in text: NSString) -> NSRange {
        // With the character after the edit: its line was the edited one's
        // before (a newline typed or removed there), and keeps that styling.
        let lines = text.lineRange(for: NSRange(location: range.location, length: min(range.length + 1, text.length - range.location)))
        var start = lines.location
        var end = NSMaxRange(lines)
        func isBlank(_ line: NSRange) -> Bool {
            text.substring(with: line).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        while start > 0 {
            let line = text.lineRange(for: NSRange(location: start - 1, length: 0))
            if isBlank(line) { break }
            start = line.location
        }
        while end < text.length {
            let line = text.lineRange(for: NSRange(location: end, length: 0))
            if isBlank(line) { break }
            end = NSMaxRange(line)
        }
        return NSRange(location: start, length: end - start)
    }
}
