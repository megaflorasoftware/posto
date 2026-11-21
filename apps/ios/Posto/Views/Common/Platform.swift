import SwiftUI
#if canImport(UIKit)
import UIKit

typealias PlatformImage = UIImage
typealias PlatformColor = UIColor
#else
import AppKit

typealias PlatformImage = NSImage
typealias PlatformColor = NSColor
#endif

// The views are shared with the macOS app (apps/mac). These cover the
// iOS-only API they use, so call sites stay the same on both.

extension Image {
    init(platformImage image: PlatformImage) {
        #if canImport(UIKit)
        self.init(uiImage: image)
        #else
        self.init(nsImage: image)
        #endif
    }
}

extension PlatformImage {
    convenience init(cgImage image: CGImage, platform: Void = ()) {
        #if canImport(UIKit)
        self.init(cgImage: image)
        #else
        self.init(cgImage: image, size: NSSize(width: image.width, height: image.height))
        #endif
    }
}

extension Color {
    /// A card's fill and outline in the body editor.
    static var cardFill: Color {
        #if canImport(UIKit)
        Color(uiColor: .tertiarySystemFill)
        #else
        Color(nsColor: .quaternaryLabelColor).opacity(0.5)
        #endif
    }

    static var cardStroke: Color {
        #if canImport(UIKit)
        Color(uiColor: .separator)
        #else
        Color(nsColor: .separatorColor)
        #endif
    }

    static var placeholderFill: Color {
        #if canImport(UIKit)
        Color(uiColor: .quaternarySystemFill)
        #else
        Color(nsColor: .quaternaryLabelColor).opacity(0.35)
        #endif
    }
}

extension View {
    /// Inline navigation titles; a macOS window's title is always inline.
    @ViewBuilder
    func inlineNavigationTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// A text field's title is its placeholder, as on iOS. A macOS form
    /// would also show it as a label beside the field, doubling the caption
    /// or section header above it.
    func placeholderOnly() -> some View {
        #if os(macOS)
        labelsHidden()
        #else
        self
        #endif
    }

    /// A button that is a whole list row, as on iOS; macOS would draw it as
    /// a bordered button inside the row.
    func rowButtonStyle() -> some View {
        #if os(macOS)
        buttonStyle(.plain)
        #else
        self
        #endif
    }

    /// Inset grouped on iOS; the standard inset list on macOS.
    @ViewBuilder
    func groupedListStyle() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        listStyle(.inset)
        #endif
    }

    /// Pages swiped sideways on iOS; tabs on macOS.
    @ViewBuilder
    func pagedTabViewStyle(showsIndex: Bool) -> some View {
        #if os(iOS)
        tabViewStyle(.page(indexDisplayMode: showsIndex ? .always : .never))
            .indexViewStyle(.page(backgroundDisplayMode: .always))
        #else
        tabViewStyle(.automatic)
        #endif
    }

    /// A picker that pushes its options on iOS; a pop-up menu on macOS.
    @ViewBuilder
    func navigationLinkPickerStyle() -> some View {
        #if os(iOS)
        pickerStyle(.navigationLink)
        #else
        pickerStyle(.menu)
        #endif
    }

    /// A list that is always reorderable (macOS lists reorder by dragging).
    @ViewBuilder
    func alwaysEditing() -> some View {
        #if os(iOS)
        environment(\.editMode, .constant(.active))
        #else
        self
        #endif
    }

    /// A sheet's size on macOS, where sheets otherwise shrink to fit their
    /// content; iOS sheets size themselves.
    @ViewBuilder
    func macSheetSizing() -> some View {
        #if os(macOS)
        // Sheets don't inherit the window's form style; grouped forms
        // scroll and read like the iOS ones.
        if #available(macOS 15.0, *) {
            frame(minWidth: 500, idealWidth: 560, minHeight: 440, idealHeight: 600)
                .formStyle(.grouped)
                .presentationSizing(.form)
        } else {
            frame(minWidth: 500, idealWidth: 560, minHeight: 440, idealHeight: 600)
                .formStyle(.grouped)
        }
        #else
        self
        #endif
    }

    /// A number pad on iOS.
    @ViewBuilder
    func decimalKeyboard() -> some View {
        #if os(iOS)
        keyboardType(.decimalPad)
        #else
        self
        #endif
    }

    /// No automatic capitalization (identifiers, paths, code).
    @ViewBuilder
    func noAutocapitalization() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never)
        #else
        self
        #endif
    }
}

extension ToolbarItemPlacement {
    /// The trailing end of the navigation bar, or the window toolbar.
    static var barTrailing: ToolbarItemPlacement {
        #if os(iOS)
        .topBarTrailing
        #else
        .primaryAction
        #endif
    }

    /// The leading end of the navigation bar, or the window toolbar.
    static var barLeading: ToolbarItemPlacement {
        #if os(iOS)
        .topBarLeading
        #else
        .navigation
        #endif
    }

    /// The bottom toolbar on iOS; the window toolbar on macOS.
    static var bottomControls: ToolbarItemPlacement {
        #if os(iOS)
        .bottomBar
        #else
        .automatic
        #endif
    }
}

extension SearchFieldPlacement {
    /// Always shown under the navigation bar on iOS; the toolbar on macOS.
    static var alwaysVisible: SearchFieldPlacement {
        #if os(iOS)
        .navigationBarDrawer(displayMode: .always)
        #else
        .toolbar
        #endif
    }
}

/// Puts plain text on the system pasteboard.
@MainActor
func copyToPasteboard(_ string: String) {
    #if canImport(UIKit)
    UIPasteboard.general.string = string
    #else
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(string, forType: .string)
    #endif
}
