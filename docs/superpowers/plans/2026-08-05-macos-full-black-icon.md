# macOS Full-Black Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore T4Code's proven macOS enclosure alpha geometry around the current white `BiB` mark so Finder renders the application as a predominantly black icon without the large pale plate.

**Architecture:** Keep the current Tauri, ICNS, DMG, updater, and signing paths. Correct only the checked-in macOS PNG alpha channel, regenerate its ICNS derivative, protect the geometry with a dependency-free PNG/ICNS regression test, and add a macOS `NSWorkspace` verifier for the built application artifact.

**Tech Stack:** TypeScript, Effect Vitest, Node.js `zlib`, Swift/AppKit, macOS `sips` and `iconutil`, Tauri 2.

## Global Constraints

- Preserve the existing white `BiB` mark without changing its size, font, placement, or wording.
- Match the alpha geometry from `/Users/admin/projects/t4code/assets/prod/black-macos-1024.png`, whose SHA-256 is `e2c15e608caa593671b1d38d88eb2b62c4cd2d6e7d3603cd98c18bb0bb44ee6d`.
- Do not make any build, test, or runtime path depend on the sibling T4Code checkout; it is one-time diagnosis and generation input only.
- Keep `assets/prod/black-macos-1024.png` and `assets/prod/bibcode-black-macos.icns` as the checked-in canonical macOS asset and derivative.
- Do not change Windows, Linux, web, marketing, or favicon assets.
- Preserve the macOS 11 minimum version and ad-hoc signing identity.
- Do not add Icon Composer, an asset catalog, a build hook, a production runtime, or a new package dependency.
- `vp check` and `vp run typecheck` must pass before completion.

---

## File Structure

- `scripts/lib/png-rgba.ts`: dependency-free decoder for trusted, non-interlaced 8-bit RGBA PNG assets used by repository hardening checks.
- `scripts/tauri-hardening.test.ts`: portable source-PNG and embedded-ICNS geometry regression.
- `assets/prod/black-macos-1024.png`: corrected BiBCode macOS artwork using the T4Code alpha mask.
- `assets/prod/bibcode-black-macos.icns`: regenerated standard icon family derived from the corrected PNG.
- `scripts/check-macos-app-icon.swift`: macOS-only end-to-end Finder rendering verifier.
- `docs/operations/release.md`: release-checklist entry for the rendering verifier.

### Task 1: Lock Down and Correct the macOS Asset Geometry

**Files:**

- Create: `scripts/lib/png-rgba.ts`
- Modify: `scripts/tauri-hardening.test.ts:1-151`
- Modify: `assets/prod/black-macos-1024.png`
- Modify: `assets/prod/bibcode-black-macos.icns`

**Interfaces:**

- Consumes: a trusted PNG `Uint8Array` containing an 8-bit RGBA, non-interlaced image.
- Produces: `decodeRgbaPng(bytes): DecodedRgbaPng`, where `DecodedRgbaPng` has `width`, `height`, and row-major RGBA `pixels`.
- Produces: a BiBCode macOS PNG whose alpha-at-least-128 top-row bounds are exactly `[171, 852]` and an ICNS whose `ic10` 1024-pixel representation has the same bounds.

- [ ] **Step 1: Install the locked development dependencies**

Run:

```bash
corepack pnpm install --frozen-lockfile
```

Expected: exit 0 without changing `package.json` or `pnpm-lock.yaml`.

- [ ] **Step 2: Add the PNG decoder used by the portable regression**

Create `scripts/lib/png-rgba.ts`:

```ts
import { inflateSync } from "node:zlib";

export interface DecodedRgbaPng {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(left: number, up: number, upLeft: number): number {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upLeftDistance = Math.abs(prediction - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

export function decodeRgbaPng(bytes: Uint8Array): DecodedRgbaPng {
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid PNG signature");
  }

  let width = 0;
  let height = 0;
  const idatChunks: Array<Buffer> = [];
  for (let offset = PNG_SIGNATURE.length; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd + 4 > png.length) throw new Error(`Truncated PNG ${type} chunk`);
    const payload = png.subarray(payloadStart, payloadEnd);
    if (type === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      if (
        payload[8] !== 8 ||
        payload[9] !== 6 ||
        payload[10] !== 0 ||
        payload[11] !== 0 ||
        payload[12] !== 0
      ) {
        throw new Error("PNG must be non-interlaced 8-bit RGBA");
      }
    } else if (type === "IDAT") {
      idatChunks.push(payload);
    }
    offset = payloadEnd + 4;
  }
  if (width === 0 || height === 0 || idatChunks.length === 0) {
    throw new Error("PNG is missing IHDR or IDAT data");
  }

  const rowBytes = width * 4;
  const filtered = inflateSync(Buffer.concat(idatChunks));
  if (filtered.length !== height * (rowBytes + 1)) {
    throw new Error("PNG scanline length does not match its dimensions");
  }
  const pixels = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = filtered[sourceOffset++];
    const rowOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= 4 ? pixels[rowOffset + x - 4]! : 0;
      const up = y > 0 ? pixels[rowOffset - rowBytes + x]! : 0;
      const upLeft = y > 0 && x >= 4 ? pixels[rowOffset - rowBytes + x - 4]! : 0;
      let predictor: number;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[rowOffset + x] = (filtered[sourceOffset++]! + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}
```

- [ ] **Step 3: Add the failing source and ICNS geometry regression**

Add this import to `scripts/tauri-hardening.test.ts`:

```ts
import { decodeRgbaPng, type DecodedRgbaPng } from "./lib/png-rgba.ts";
```

Add these helpers before the test layer:

```ts
function topRowOpaqueBounds(image: DecodedRgbaPng): readonly [number, number] {
  const opaqueColumns: Array<number> = [];
  for (let x = 0; x < image.width; x++) {
    if (image.pixels[x * 4 + 3]! >= 128) opaqueColumns.push(x);
  }
  assert.ok(opaqueColumns.length > 0, "macOS icon top row must contain opaque pixels");
  return [opaqueColumns[0]!, opaqueColumns.at(-1)!];
}

function readIcnsChunks(icns: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const bytes = Buffer.from(icns.buffer, icns.byteOffset, icns.byteLength);
  assert.equal(bytes.toString("ascii", 0, 4), "icns");
  assert.equal(bytes.readUInt32BE(4), bytes.length);
  const chunks = new Map<string, Uint8Array>();
  for (let offset = 8; offset < bytes.length; ) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32BE(offset + 4);
    assert.ok(size >= 8 && offset + size <= bytes.length, `Invalid ICNS ${type} chunk`);
    chunks.set(type, bytes.subarray(offset + 8, offset + size));
    offset += size;
  }
  return chunks;
}
```

Inside `it.layer(NodeServices.layer)("Tauri production hardening", ...)`, add:

```ts
it.effect("uses the proven full-black macOS enclosure geometry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const source = decodeRgbaPng(
      yield* fs.readFile(path.join(repoRoot, "assets/prod/black-macos-1024.png")),
    );

    assert.equal(source.width, 1024);
    assert.equal(source.height, 1024);
    assert.deepEqual(topRowOpaqueBounds(source), [171, 852]);
    assert.equal(source.pixels[(512 * source.width + 512) * 4 + 3], 255);
    assert.ok(
      Array.from({ length: source.width * source.height }, (_, index) => source.pixels[index * 4 + 3]!)
        .filter((alpha) => alpha === 0).length >= 27_000,
      "macOS icon must retain the T4-compatible transparent corner area",
    );
    assert.ok(
      Array.from({ length: source.width * source.height }, (_, index) => source.pixels[index * 4 + 3]!)
        .some((alpha) => alpha > 0 && alpha < 255),
      "macOS icon corners must retain antialiasing",
    );

    const chunks = readIcnsChunks(
      yield* fs.readFile(path.join(repoRoot, "assets/prod/bibcode-black-macos.icns")),
    );
    for (const type of ["ic11", "ic12", "ic13", "ic07", "ic08", "ic14", "ic09", "ic10"]) {
      assert.equal(chunks.has(type), true, `ICNS must contain ${type}`);
    }
    const largest = decodeRgbaPng(chunks.get("ic10")!);
    assert.equal(largest.width, 1024);
    assert.equal(largest.height, 1024);
    assert.deepEqual(topRowOpaqueBounds(largest), [171, 852]);
  }),
);
```

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```bash
vp test scripts/tauri-hardening.test.ts
```

Expected: FAIL because the current source reports top-row bounds `[71, 952]` instead of `[171, 852]`.

- [ ] **Step 5: Replace only the macOS PNG alpha channel**

First verify the one-time T4 reference input:

```bash
shasum -a 256 /Users/admin/projects/t4code/assets/prod/black-macos-1024.png
```

Expected:

```text
e2c15e608caa593671b1d38d88eb2b62c4cd2d6e7d3603cd98c18bb0bb44ee6d  /Users/admin/projects/t4code/assets/prod/black-macos-1024.png
```

Generate the corrected BiBCode PNG with AppKit, retaining BiBCode RGB values and taking only T4Code alpha values:

```bash
BIBCODE_MAC_ICON=assets/prod/black-macos-1024.png \
T4CODE_MAC_ICON=/Users/admin/projects/t4code/assets/prod/black-macos-1024.png \
swift -e 'import AppKit
let env = ProcessInfo.processInfo.environment
let outputUrl = URL(fileURLWithPath: env["BIBCODE_MAC_ICON"]!)
let bib = NSBitmapImageRep(data: try Data(contentsOf: outputUrl))!
let t4 = NSBitmapImageRep(
  data: try Data(contentsOf: URL(fileURLWithPath: env["T4CODE_MAC_ICON"]!))
)!
guard bib.pixelsWide == 1024, bib.pixelsHigh == 1024,
      t4.pixelsWide == bib.pixelsWide, t4.pixelsHigh == bib.pixelsHigh else {
  fatalError("macOS icon inputs must both be 1024 by 1024")
}
for y in 0..<bib.pixelsHigh {
  for x in 0..<bib.pixelsWide {
    let color = bib.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
    let alpha = t4.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!.alphaComponent
    bib.setColor(
      NSColor(
        deviceRed: color.redComponent,
        green: color.greenComponent,
        blue: color.blueComponent,
        alpha: alpha
      ),
      atX: x,
      y: y
    )
  }
}
try bib.representation(using: .png, properties: [:])!.write(to: outputUrl)'
```

- [ ] **Step 6: Regenerate the ICNS from the corrected PNG**

Run:

```bash
icon_probe_root=$(mktemp -d /private/tmp/bibcode-macos-icon.XXXXXX)
iconset="$icon_probe_root/bibcode-black-macos.iconset"
mkdir "$iconset"
sips -z 16 16 assets/prod/black-macos-1024.png --out "$iconset/icon_16x16.png" >/dev/null
sips -z 32 32 assets/prod/black-macos-1024.png --out "$iconset/icon_16x16@2x.png" >/dev/null
sips -z 32 32 assets/prod/black-macos-1024.png --out "$iconset/icon_32x32.png" >/dev/null
sips -z 64 64 assets/prod/black-macos-1024.png --out "$iconset/icon_32x32@2x.png" >/dev/null
sips -z 128 128 assets/prod/black-macos-1024.png --out "$iconset/icon_128x128.png" >/dev/null
sips -z 256 256 assets/prod/black-macos-1024.png --out "$iconset/icon_128x128@2x.png" >/dev/null
sips -z 256 256 assets/prod/black-macos-1024.png --out "$iconset/icon_256x256.png" >/dev/null
sips -z 512 512 assets/prod/black-macos-1024.png --out "$iconset/icon_256x256@2x.png" >/dev/null
sips -z 512 512 assets/prod/black-macos-1024.png --out "$iconset/icon_512x512.png" >/dev/null
cp assets/prod/black-macos-1024.png "$iconset/icon_512x512@2x.png"
iconutil -c icns "$iconset" -o assets/prod/bibcode-black-macos.icns
trash "$icon_probe_root"
```

- [ ] **Step 7: Run the focused test and verify GREEN**

Run:

```bash
vp test scripts/tauri-hardening.test.ts
```

Expected: PASS, including the source PNG and embedded `ic10` top-row bounds `[171, 852]`.

- [ ] **Step 8: Verify only macOS product assets changed**

Run:

```bash
git diff --name-only -- assets/prod
```

Expected exactly:

```text
assets/prod/bibcode-black-macos.icns
assets/prod/black-macos-1024.png
```

- [ ] **Step 9: Commit the asset correction and portable regression**

Run:

```bash
git add scripts/lib/png-rgba.ts scripts/tauri-hardening.test.ts assets/prod/black-macos-1024.png assets/prod/bibcode-black-macos.icns
git commit -m "fix: restore macOS icon enclosure mask"
```

### Task 2: Add and Exercise the Finder Rendering Regression

**Files:**

- Create: `scripts/check-macos-app-icon.swift`
- Modify: `docs/operations/release.md:174-205`

**Interfaces:**

- Consumes: one `.app` path as the first command-line argument on macOS.
- Produces: exit 0 when Finder's `NSWorkspace` rendering is at least 70% dark and no more than 25% pale; otherwise prints the measured ratios and exits 1.

- [ ] **Step 1: Add the macOS rendering verifier**

Create `scripts/check-macos-app-icon.swift`:

```swift
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
```

- [ ] **Step 2: Verify the rendering harness is RED against the original mounted DMG**

Run while the original v0.3.2 DMG remains mounted:

```bash
swift scripts/check-macos-app-icon.swift /Volumes/BiBCode/BiBCode.app
```

Expected: exit 1 with approximately `dark 42.6%, pale 57.2%`.

- [ ] **Step 3: Document the artifact-level check**

Add this command after the macOS native artifact command in `docs/operations/release.md`:

````markdown
On macOS 26, verify Finder's rendered application icon from the generated app
bundle before publishing the DMG:

```powershell
swift scripts/check-macos-app-icon.swift target/aarch64-apple-darwin/release/bundle/macos/BiBCode.app
```
````

- [ ] **Step 4: Build the corrected arm64 application and DMG**

Run:

```bash
icon_release_dir=/private/tmp/bibcode-icon-release-20260805
test ! -e "$icon_release_dir"
mkdir "$icon_release_dir"
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --output-dir "$icon_release_dir" --verbose
printf 'icon_release_dir=%s\n' "$icon_release_dir"
```

Expected: exit 0 with a DMG in the printed directory and `target/aarch64-apple-darwin/release/bundle/macos/BiBCode.app` present.

- [ ] **Step 5: Verify the built application at the user-visible seam**

Run:

```bash
swift scripts/check-macos-app-icon.swift target/aarch64-apple-darwin/release/bundle/macos/BiBCode.app
```

Expected: exit 0, dark ratio at least 70%, pale ratio no more than 25%, and `PASS: BiBCode renders as a predominantly black macOS icon`.

- [ ] **Step 6: Verify the packaged icon and recursive signature**

Run:

```bash
cmp assets/prod/bibcode-black-macos.icns target/aarch64-apple-darwin/release/bundle/macos/BiBCode.app/Contents/Resources/bibcode-black-macos.icns
codesign --verify --deep --strict --verbose=2 target/aarch64-apple-darwin/release/bundle/macos/BiBCode.app
```

Expected: both commands exit 0.

- [ ] **Step 7: Mount the generated DMG read-only and verify its application icon**

Run:

```bash
icon_release_dir=/private/tmp/bibcode-icon-release-20260805
icon_dmg=$(find "$icon_release_dir" -maxdepth 1 -name '*.dmg' -print -quit)
icon_mount=/private/tmp/bibcode-icon-dmg-20260805
test ! -e "$icon_mount"
mkdir "$icon_mount"
hdiutil attach -readonly -nobrowse -noverify -mountpoint "$icon_mount" "$icon_dmg"
swift scripts/check-macos-app-icon.swift "$icon_mount/BiBCode.app"
hdiutil detach "$icon_mount"
trash "$icon_mount" "$icon_release_dir"
```

Expected: the verifier exits 0 for the application inside the DMG, the image detaches cleanly, and only temporary build-output copies are trashed.

- [ ] **Step 8: Commit the artifact verifier and release documentation**

Run:

```bash
git add scripts/check-macos-app-icon.swift docs/operations/release.md
git commit -m "test: verify Finder-rendered macOS icon"
```

### Task 3: Complete Repository and Regression Verification

**Files:**

- Verify only; no additional files should change.

**Interfaces:**

- Consumes: the corrected assets and both regression seams from Tasks 1 and 2.
- Produces: fresh evidence that the focused test, repository gates, artifact build, signature, and original Finder symptom all pass.

- [ ] **Step 1: Run the focused and release regression tests**

Run:

```bash
vp test scripts/tauri-hardening.test.ts scripts/build-desktop-artifact.test.ts scripts/ci-platform-contract.test.ts scripts/release-workflow.test.ts
```

Expected: all tests pass with no failures.

- [ ] **Step 2: Run the required repository gates**

Run:

```bash
vp check
vp run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 3: Confirm the asset scope against the approved design commit**

Run:

```bash
git diff --name-only 55c1369..HEAD -- assets/prod
```

Expected exactly:

```text
assets/prod/bibcode-black-macos.icns
assets/prod/black-macos-1024.png
```

- [ ] **Step 4: Confirm all diagnostic instrumentation and temporary prototypes are gone**

Run:

```bash
rg -n '\[DEBUG-' scripts apps packages || true
find /private/tmp -maxdepth 1 -type d \( -name 'bibcode-macos-icon.*' -o -name 'bibcode-icon-release.*' -o -name 'bibcode-icon-dmg.*' \) -print
git status --short
```

Expected: no debug-tag output, no task-owned temporary directories, and a clean worktree.

- [ ] **Step 5: Record the root cause in the final handoff**

State that the BiB rebrand reduced the macOS transparent-corner mask from T4Code's 2.7% to 0.5%, causing macOS 26 Finder to treat the nearly square artwork as inset legacy content on a pale plate. Include the final Finder-rendered dark/pale ratios from the built DMG and note that Windows, Linux, web, and marketing assets were unchanged.
