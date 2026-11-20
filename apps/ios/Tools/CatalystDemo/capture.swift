// Prints the Catalyst demo's window id for `screencapture -l`.
import CoreGraphics
import Foundation

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
guard let window = windows.first(where: {
    ($0[kCGWindowOwnerName as String] as? String) == "Posto" && ($0[kCGWindowLayer as String] as? Int) == 0
}), let id = window[kCGWindowNumber as String] as? CGWindowID else {
    exit(1)
}
print(id)
