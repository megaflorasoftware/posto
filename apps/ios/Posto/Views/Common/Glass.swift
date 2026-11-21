import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// Liquid Glass for the app's own controls. System bars, toolbars, sheets,
// menus and search fields turn to glass on their own with the iOS 26 SDK.
// The deployment target is iOS 17, so every use here is gated on iOS 26 with
// the earlier look as the fallback, and wrapped in `#if compiler(>=6.2)` so
// scripts/typecheck.sh keeps working with SDKs that predate the API.

extension View {
    /// The screen's main action: prominent glass, or bordered prominent.
    @ViewBuilder
    func prominentActionStyle() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            buttonStyle(.glassProminent)
        } else {
            buttonStyle(.borderedProminent)
        }
        #else
        buttonStyle(.borderedProminent)
        #endif
    }

    /// A secondary action: glass, or bordered (or the default style when
    /// `bordered` is false, for buttons that were plain before iOS 26).
    @ViewBuilder
    func glassActionStyle(bordered: Bool = true) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            buttonStyle(.glass)
        } else {
            borderedUnlessPlain(bordered)
        }
        #else
        borderedUnlessPlain(bordered)
        #endif
    }

    @ViewBuilder
    private func borderedUnlessPlain(_ bordered: Bool) -> some View {
        if bordered { buttonStyle(.bordered) } else { self }
    }

    /// A floating panel: glass in a rounded rectangle, or `fallback` behind it.
    @ViewBuilder
    func glassPanel(
        cornerRadius: CGFloat,
        interactive: Bool = false,
        fallback: AnyShapeStyle = AnyShapeStyle(.regularMaterial)
    ) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: .rect(cornerRadius: cornerRadius))
        } else {
            background(fallback, in: .rect(cornerRadius: cornerRadius))
        }
        #else
        background(fallback, in: .rect(cornerRadius: cornerRadius))
        #endif
    }

    /// Backs a bar pinned to the bottom edge: nothing on iOS 26, where its
    /// glass button floats over the content, and bar material before.
    @ViewBuilder
    func floatingBarBackground() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            self
        } else {
            background(.bar)
        }
        #else
        background(.bar)
        #endif
    }

    /// Fades scrolling content under a bar floating over the bottom edge.
    @ViewBuilder
    func softBottomScrollEdge() -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            scrollEdgeEffectStyle(.soft, for: .bottom)
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// The editor's title with its save state: a navigation subtitle on
    /// iOS 26, a two-line principal item before.
    func editorTitle(_ name: String, saveState: String) -> some View {
        modifier(EditorTitle(name: name, saveState: saveState))
    }

    /// Two runs of toolbar items in one placement. On iOS 26 a ToolbarSpacer
    /// between them gives each its own glass group; before, they share one
    /// group, with a Spacer between them when the gap is flexible. With
    /// `split` false the second run stands alone; with `active` false
    /// neither is added.
    ///
    /// (A modifier rather than toolbar content: ToolbarContentBuilder only
    /// supports `if #available` from iOS 17.5, past the deployment target.)
    func toolbarGroups<First: View, Second: View>(
        _ placement: ToolbarItemPlacement,
        gap: ToolbarGroupGap,
        active: Bool = true,
        split: Bool = true,
        @ViewBuilder _ first: () -> First,
        @ViewBuilder then second: () -> Second
    ) -> some View {
        modifier(ToolbarGroups(placement: placement, gap: gap, active: active, split: split, first: first(), second: second()))
    }
}

enum ToolbarGroupGap {
    case fixed, flexible
}

private struct ToolbarGroups<First: View, Second: View>: ViewModifier {
    let placement: ToolbarItemPlacement
    let gap: ToolbarGroupGap
    let active: Bool
    let split: Bool
    let first: First
    let second: Second

    // `content` sits in one place whatever `active` and `split` are: in
    // separate branches, flipping either would rebuild the whole screen
    // (scroll position, text views, state). Only the availability branch
    // differs, and it can't change while the app runs.
    @ViewBuilder
    func body(content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            content.toolbar {
                if active && split {
                    ToolbarItemGroup(placement: placement) { first }
                    ToolbarSpacer(gap == .flexible ? .flexible : .fixed, placement: placement)
                }
                if active {
                    ToolbarItemGroup(placement: placement) { second }
                }
            }
        } else {
            oneGroup(content)
        }
        #else
        oneGroup(content)
        #endif
    }

    private func oneGroup(_ content: Content) -> some View {
        content.toolbar {
            if active {
                ToolbarItemGroup(placement: placement) {
                    if split {
                        first
                        if gap == .flexible { Spacer() }
                    }
                    second
                }
            }
        }
    }
}

private struct EditorTitle: ViewModifier {
    let name: String
    let saveState: String

    func body(content: Content) -> some View {
        let state = saveStateLabel(saveState)
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .navigationTitle(name)
                .navigationSubtitle(Text(state.text).foregroundStyle(state.color))
        } else {
            principal(content, state)
        }
        #else
        principal(content, state)
        #endif
    }

    private func principal(_ content: Content, _ state: (text: String, symbol: String, color: Color)) -> some View {
        content
            .navigationTitle(name)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(name).font(.headline).lineLimit(1)
                        Label(state.text, systemImage: state.symbol)
                            .labelStyle(.titleAndIcon)
                            .font(.caption2)
                            .foregroundStyle(state.color)
                    }
                }
            }
    }
}

/// Dismisses a sheet without doing anything else: the system close button on
/// iOS 26, a "Cancel" or "Done" text button before.
struct CloseButton: View {
    private let title: String
    private let action: () -> Void

    init(_ title: String = "Cancel", action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            Button(role: .close, action: action)
        } else {
            Button(title, action: action)
        }
        #else
        Button(title, action: action)
        #endif
    }
}

#if canImport(UIKit)
extension UIScrollView {
    /// Hides iOS 26's scroll edge effects. A text view that doesn't scroll
    /// otherwise picks up a nearby bar's effect, which draws over its text.
    func hideScrollEdgeEffects() {
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) {
            topEdgeEffect.isHidden = true
            bottomEdgeEffect.isHidden = true
            leftEdgeEffect.isHidden = true
            rightEdgeEffect.isHidden = true
        }
        #endif
    }
}
#endif

extension ToolbarItemPlacement {
    /// For a close button that replaced a "Done": the confirmation slot
    /// before iOS 26, a plain trailing item on iOS 26, where the confirmation
    /// slot would tint the ✕ as a prominent action.
    static var closeTrailing: ToolbarItemPlacement {
        #if compiler(>=6.2)
        if #available(iOS 26.0, macOS 26.0, *) { return .barTrailing }
        #endif
        return .confirmationAction
    }
}
