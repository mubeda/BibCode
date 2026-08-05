#!/usr/bin/env swift

import AppKit

guard CommandLine.arguments.count == 2 else {
  fputs("Usage: check-macos-app-icon.swift /path/to/BiBCode.app\n", stderr)
  exit(2)
}

let appPath = CommandLine.arguments[1]
guard FileManager.default.fileExists(atPath: appPath) else {
  fputs("Application bundle does not exist: \(appPath)\n", stderr)
  exit(2)
}

let image = NSWorkspace.shared.icon(forFile: appPath)
image.size = NSSize(width: 256, height: 256)
guard
  let tiff = image.tiffRepresentation,
  let bitmap = NSBitmapImageRep(data: tiff)
else {
  fputs("Could not render application icon: \(appPath)\n", stderr)
  exit(2)
}

var opaque = 0
var dark = 0
var pale = 0
for y in 0..<bitmap.pixelsHigh {
  for x in 0..<bitmap.pixelsWide {
    guard
      let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
      color.alphaComponent > 0.5
    else { continue }
    opaque += 1
    let luminance =
      0.2126 * color.redComponent +
      0.7152 * color.greenComponent +
      0.0722 * color.blueComponent
    if luminance < 0.15 { dark += 1 }
    if luminance > 0.70 { pale += 1 }
  }
}
guard opaque > 0 else {
  fputs("Rendered application icon has no opaque pixels: \(appPath)\n", stderr)
  exit(2)
}

let darkRatio = Double(dark) / Double(opaque)
let paleRatio = Double(pale) / Double(opaque)
print(
  String(
    format: "Finder-rendered icon: dark %.1f%%, pale %.1f%%",
    darkRatio * 100,
    paleRatio * 100
  )
)
if darkRatio < 0.70 || paleRatio > 0.25 {
  fputs("FAIL: macOS adds a large pale surround to the BiBCode icon\n", stderr)
  exit(1)
}
print("PASS: BiBCode renders as a predominantly black macOS icon")
