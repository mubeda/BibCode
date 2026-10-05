#!/usr/bin/env swift

import AppKit

enum IconVerificationStage: String {
  case swiftEntry = "swift-entry"
  case fileCheckSucceeded = "file-check-succeeded"
  case workspaceDispatched = "workspace-dispatched"
  case workspaceReturned = "workspace-returned"
  case imageSizeDispatched = "image-size-dispatched"
  case imageSizeReturned = "image-size-returned"
  case tiffDispatched = "tiff-dispatched"
  case tiffReturned = "tiff-returned"
  case bitmapDispatched = "bitmap-dispatched"
  case bitmapReturned = "bitmap-returned"
  case pixelScanDispatched = "pixel-scan-dispatched"
  case pixelScanReturned = "pixel-scan-returned"
  case verdictRejected = "verdict-rejected"
  case verdictAccepted = "verdict-accepted"
}

// Closed CI observations exclude application paths, arguments, and native errors.
func observeIconStage(
  _ stage: IconVerificationStage,
  counts: (opaque: Int, dark: Int, pale: Int)? = nil,
  dimensions: (width: Int, height: Int)? = nil
) {
  var fields = "\"stage\":\"\(stage.rawValue)\""
  if let counts = counts {
    let cap = 1_048_576
    fields += ",\"opaque\":\(min(counts.opaque, cap)),\"dark\":\(min(counts.dark, cap)),\"pale\":\(min(counts.pale, cap))"
    fields += ",\"countsCapped\":\(counts.opaque > cap || counts.dark > cap || counts.pale > cap)"
  }
  if let dimensions = dimensions {
    let cap = 16_384
    fields += ",\"width\":\(min(dimensions.width, cap)),\"height\":\(min(dimensions.height, cap))"
    fields += ",\"dimensionsCapped\":\(dimensions.width > cap || dimensions.height > cap)"
  }
  // Logging remains optional; write or flush refusal cannot replace the verdict.
  fputs("mac-icon-observation {\(fields)}\n", stderr)
  fflush(stderr)
}

observeIconStage(.swiftEntry)

guard CommandLine.arguments.count == 2 else {
  fputs("Usage: check-macos-app-icon.swift /path/to/BiBCode.app\n", stderr)
  exit(2)
}

let appPath = CommandLine.arguments[1]
guard FileManager.default.fileExists(atPath: appPath) else {
  fputs("Application bundle does not exist: \(appPath)\n", stderr)
  exit(2)
}

observeIconStage(.fileCheckSucceeded)
observeIconStage(.workspaceDispatched)
let image = NSWorkspace.shared.icon(forFile: appPath)
observeIconStage(.workspaceReturned)
observeIconStage(.imageSizeDispatched)
image.size = NSSize(width: 256, height: 256)
observeIconStage(.imageSizeReturned)
observeIconStage(.tiffDispatched)
let renderedTIFF = image.tiffRepresentation
observeIconStage(.tiffReturned)
guard let tiff = renderedTIFF else {
  fputs("Could not render application icon: \(appPath)\n", stderr)
  exit(2)
}
observeIconStage(.bitmapDispatched)
let renderedBitmap = NSBitmapImageRep(data: tiff)
observeIconStage(.bitmapReturned)
guard let bitmap = renderedBitmap else {
  fputs("Could not render application icon: \(appPath)\n", stderr)
  exit(2)
}

var opaque = 0
var dark = 0
var pale = 0
observeIconStage(.pixelScanDispatched, dimensions: (width: bitmap.pixelsWide, height: bitmap.pixelsHigh))
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
observeIconStage(.pixelScanReturned, counts: (opaque: opaque, dark: dark, pale: pale))
guard opaque > 0 else {
  observeIconStage(.verdictRejected)
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
  observeIconStage(.verdictRejected)
  fputs("FAIL: macOS adds a large pale surround to the BiBCode icon\n", stderr)
  exit(1)
}
observeIconStage(.verdictAccepted)
print("PASS: BiBCode renders as a predominantly black macOS icon")
