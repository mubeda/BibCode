# Linux AppImage XWayland Taskbar Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the BiBCode AppImage publish a usable X11 `_NET_WM_ICON` so KDE Plasma displays the BiBCode icon while the AppImage runs through XWayland.

**Architecture:** Keep the current Tauri and AppImage runtime paths. Add a checked-in 128 by 128 RGBA derivative before the existing 1024-pixel PNG in `bundle.icon`; Tauri embeds the first PNG as the native window icon, while its AppImage bundler continues selecting the largest square PNG for the root AppImage icon. Extend the existing portable hardening test to lock the ordering, dimensions, color type, and GTK3 payload bound.

**Tech Stack:** Tauri 2.11, GTK3/X11, TypeScript, Effect Vitest, Vite+, ImageMagick, AppImage, KDE Plasma/XWayland.

## Global Constraints

- Preserve `assets/prod/black-universal-1024.png` as the canonical high-resolution Linux source and AppImage presentation icon.
- Create only `assets/prod/black-universal-128.png` as the native Linux runtime derivative.
- Do not add `enableGTKAppId`, a custom desktop entry, AppImage self-integration, runtime scaling, or a new dependency.
- Do not change the AppImage GTK hook's forced X11 backend.
- Do not change `WM_CLASS`, the executable name, product name, identifier, macOS ICNS, Windows ICO, web icons, or marketing icons.
- Keep the runtime icon's serialized X11 size below GTK3's 262,144-cardinal cap.
- Run the focused test before and after implementation, then `vp run test:desktop`, `vp check`, `vp run typecheck`, and the canonical Linux artifact build.
- Preserve unrelated worktree changes and do not edit generated `.codegraph/` data.

---

## File Structure

- `assets/prod/black-universal-128.png`: checked-in 128 by 128 RGBA Linux runtime icon derived once from the canonical 1024-pixel artwork.
- `assets/prod/black-universal-1024.png`: unchanged canonical Linux artwork and high-resolution AppImage icon.
- `apps/desktop/src-tauri/tauri.conf.json`: orders the runtime PNG before the high-resolution bundle PNG.
- `scripts/tauri-hardening.test.ts`: enforces icon ordering, existence, dimensions, RGBA encoding, and the GTK3 X11 payload bound.

### Task 1: Add and Lock the XWayland Runtime Icon

**Files:**

- Create: `assets/prod/black-universal-128.png`
- Modify: `apps/desktop/src-tauri/tauri.conf.json:43-49`
- Modify: `scripts/tauri-hardening.test.ts:212-243`

**Interfaces:**

- Consumes: the unchanged `assets/prod/black-universal-1024.png` canonical RGBA artwork.
- Produces: `assets/prod/black-universal-128.png`, an exact 128 by 128 RGBA runtime derivative.
- Produces: a `bundle.icon` ordering in which the 128-pixel PNG is the first PNG and the 1024-pixel PNG remains second.
- Produces: a portable assertion that the selected runtime icon requires exactly `128 * 128 + 2 = 16_386` X11 cardinals, below GTK3's `262_144` cap.

- [ ] **Step 1: Install the frozen workspace dependencies if they are absent**

If `vp` is not already on `PATH`, install it with the repository's documented
Linux command, then open a fresh login shell so the installed binary is on
`PATH`:

```bash
curl -fsSL https://vite.plus | bash
```

From the repository root, install the frozen workspace dependencies:

```bash
vp install --frozen-lockfile
```

Expected: exit 0 without changing `package.json` or `pnpm-lock.yaml`. Do not
substitute npm, pnpm, or upstream Vite test commands.

- [ ] **Step 2: Extend the hardening contract before creating the asset**

Replace the existing `bundles only canonical black desktop icons` test in
`scripts/tauri-hardening.test.ts` with:

```ts
it.effect("bundles only canonical black desktop icons", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const tauri = yield* decodeTauriConfiguration(
      yield* fs.readFileString(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json")),
    );
    const expectedIcons = [
      "../../../assets/prod/black-universal-128.png",
      "../../../assets/prod/black-universal-1024.png",
      "../../../assets/prod/bibcode-black-windows.ico",
      "../../../assets/prod/bibcode-black-macos.icns",
    ];

    assert.deepEqual(tauri.bundle.icon, expectedIcons);
    assert.equal(tauri.bundle.macOS.minimumSystemVersion, "11.0");
    for (const iconPath of [
      "assets/prod/black-universal-128.png",
      "assets/prod/black-universal-1024.png",
      "assets/prod/bibcode-black-windows.ico",
      "assets/prod/bibcode-black-macos.icns",
    ]) {
      assert.equal(yield* fs.exists(path.join(repoRoot, iconPath)), true, iconPath);
    }

    const linuxRuntimeIconBytes = yield* fs.readFile(
      path.join(repoRoot, "assets/prod/black-universal-128.png"),
    );
    assert.equal(
      linuxRuntimeIconBytes[25],
      6,
      "Linux runtime icon must use the RGBA PNG color type",
    );
    const linuxRuntimeIcon = decodeRgbaPng(linuxRuntimeIconBytes);
    assert.equal(linuxRuntimeIcon.width, 128);
    assert.equal(linuxRuntimeIcon.height, 128);
    assert.ok(
      linuxRuntimeIcon.width * linuxRuntimeIcon.height + 2 < 262_144,
      "Linux runtime icon must fit GTK3's capped X11 property request",
    );

    const linuxBundleIconBytes = yield* fs.readFile(
      path.join(repoRoot, "assets/prod/black-universal-1024.png"),
    );
    assert.equal(
      linuxBundleIconBytes[25],
      6,
      "Linux AppImage icon must use the RGBA PNG color type",
    );
    const linuxBundleIcon = decodeRgbaPng(linuxBundleIconBytes);
    assert.equal(linuxBundleIcon.width, 1024);
    assert.equal(linuxBundleIcon.height, 1024);
    assert.equal(yield* fs.exists(path.join(repoRoot, "apps/desktop/resources")), false);
  }),
);
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
vp test scripts/tauri-hardening.test.ts
```

Expected: FAIL in `bundles only canonical black desktop icons` because
`bundle.icon` does not yet contain
`../../../assets/prod/black-universal-128.png`. If execution reaches the file
check first, the same test fails because `assets/prod/black-universal-128.png`
does not exist.

- [ ] **Step 4: Generate the checked-in runtime derivative**

Run this one-time asset generation command from the repository root:

```bash
magick assets/prod/black-universal-1024.png \
  -filter Lanczos \
  -resize 128x128 \
  -strip \
  PNG32:assets/prod/black-universal-128.png
```

Confirm with:

```bash
magick identify -format '%m %wx%h %[channels]\n' \
  assets/prod/black-universal-128.png
```

Expected exactly: `PNG 128x128 srgba 4.0`.

- [ ] **Step 5: Select the runtime derivative first in Tauri configuration**

Change `bundle.icon` in `apps/desktop/src-tauri/tauri.conf.json` to:

```json
"icon": [
  "../../../assets/prod/black-universal-128.png",
  "../../../assets/prod/black-universal-1024.png",
  "../../../assets/prod/bibcode-black-windows.ico",
  "../../../assets/prod/bibcode-black-macos.icns"
]
```

Do not change any other Tauri configuration key.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
vp test scripts/tauri-hardening.test.ts
```

Expected: PASS, including the icon-order, 128 by 128 dimension, RGBA, payload,
1024 by 1024 bundle-icon, updater, CSP, and existing macOS assertions.

- [ ] **Step 7: Review the implementation diff**

Run:

```bash
git diff --check
git diff -- apps/desktop/src-tauri/tauri.conf.json scripts/tauri-hardening.test.ts
git status --short
```

Expected: only the Tauri configuration, hardening test, and new 128-pixel PNG
are changed. `package.json`, `pnpm-lock.yaml`, existing icon assets, and
`.codegraph/` are unchanged.

- [ ] **Step 8: Commit the test-driven implementation**

```bash
git add \
  apps/desktop/src-tauri/tauri.conf.json \
  scripts/tauri-hardening.test.ts \
  assets/prod/black-universal-128.png
git commit -m "fix(desktop): provide Linux runtime window icon"
```

### Task 2: Verify the Desktop Package and Real AppImage Boundary

**Files:**

- Verify: `apps/desktop/src-tauri/tauri.conf.json`
- Verify: `scripts/tauri-hardening.test.ts`
- Verify: `assets/prod/black-universal-128.png`
- Verify: `assets/prod/black-universal-1024.png`
- Verify: `release/desktop/linux-x64/BiBCode_0.3.5_amd64.AppImage`

**Interfaces:**

- Consumes: the Task 1 icon ordering and checked-in 128-pixel runtime asset.
- Produces: a Linux AppImage containing both hicolor icon sizes, retaining a
  1024-pixel root icon, and publishing a non-empty `_NET_WM_ICON` at runtime.

- [ ] **Step 1: Run the broader native desktop package test**

Run:

```bash
vp run test:desktop
```

Expected: all `bibcode-desktop` Rust tests pass. No Rust source changed, so
Rust formatting and Clippy are not additional change-specific gates.

- [ ] **Step 2: Run the repository quality gates**

Run:

```bash
vp check
vp run typecheck
```

Expected: both commands exit 0 with no formatting, lint, TypeScript, or Rust
check failures.

- [ ] **Step 3: Build the canonical Linux AppImage**

Run:

```bash
vp run dist:desktop:linux
```

Expected: exit 0 and publish
`release/desktop/linux-x64/BiBCode_0.3.5_amd64.AppImage`. The build may update
ignored `target/` output, but must not change tracked dependencies or source.

- [ ] **Step 4: Extract and inspect both packaged icon roles**

Run in one shell from the repository root, and keep that shell open through
Step 6 so `inspection_dir` and `app_pid` remain available:

```bash
artifact_path="$PWD/release/desktop/linux-x64/BiBCode_0.3.5_amd64.AppImage"
inspection_dir="$(mktemp -d /tmp/bibcode-appimage-icon.XXXXXX)"
chmod u+x "$artifact_path"
(cd "$inspection_dir" && "$artifact_path" --appimage-extract >/dev/null)
magick identify \
  "$inspection_dir/squashfs-root/usr/share/icons/hicolor/128x128/apps/bibcode-desktop.png" \
  "$inspection_dir/squashfs-root/usr/share/icons/hicolor/1024x1024/apps/bibcode-desktop.png" \
  "$inspection_dir/squashfs-root/.DirIcon"
```

Expected: the first icon is 128 by 128, the second is 1024 by 1024, and
`.DirIcon` resolves to a 1024 by 1024 PNG. This proves the runtime icon was
added without lowering the AppImage presentation icon.

- [ ] **Step 5: Verify the running artifact publishes `_NET_WM_ICON`**

Run the extracted AppRun path so AppImageLauncher does not intercept the
diagnostic launch:

```bash
cd "$inspection_dir/squashfs-root"
./AppRun >/tmp/bibcode-appimage-icon.stdout 2>/tmp/bibcode-appimage-icon.stderr &
app_pid=$!
for attempt in $(seq 1 40); do
  if xprop -name BiBCode WM_CLASS >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
xprop -name BiBCode WM_CLASS
xprop -name BiBCode _NET_WM_ICON | rg -q '^_NET_WM_ICON\(CARDINAL\) = [0-9]'
```

Expected: `WM_CLASS` reports `bibcode-desktop`, and the final command exits 0
because `_NET_WM_ICON` contains numeric pixel data instead of being absent.

- [ ] **Step 6: Confirm the KDE taskbar appearance and stop the diagnostic app**

While the application from Step 5 remains open, inspect its KDE Plasma taskbar
entry. Expected: it displays the BiBCode icon rather than an empty or generic
icon.

Then stop the diagnostic process:

```bash
kill "$app_pid"
wait "$app_pid" || true
```

- [ ] **Step 7: Perform the final repository review**

Run from the repository root:

```bash
git diff HEAD^ --check
git show --stat --oneline HEAD
git status --short
```

Expected: the implementation commit contains only the two source/test edits and
new runtime PNG. The worktree is clean; there is no dependency drift, debug
output, generated tracked content, or living-documentation gap.
