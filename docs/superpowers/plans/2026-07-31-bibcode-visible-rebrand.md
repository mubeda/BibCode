# BiBCode Visible Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every user-visible retired identity with BiBCode and every application icon mark with BiB, without changing compatibility-sensitive runtime identifiers.

**Architecture:** Change the canonical desktop/web branding roots first, then update dependent UI, release, installer, documentation, and image surfaces. Generate every icon format from the existing SVG master through Sharp and the installed Tauri CLI, and finish with text plus visual audits.

**Tech Stack:** TypeScript 7, React, Astro, Rust 1.97.1, Tauri 2.11.4, Vite+, Sharp, WebdriverIO.

## Global Constraints

- Canonical application name: `BiBCode`.
- Canonical icon text: `BiB`.
- Preserve the existing black background, white heavy type, and compact rounded-square icon style.
- Keep `@bibcode/*`, Rust crate/binary names, `BIBCODE_*`, the retired
  filesystem path, storage keys, protocol values, and Tauri identifier unchanged
  in this plan unless the value is a user-facing release artifact name.
- Do not modify `.repos`, dependency directories, build output, caches, or CodeGraph data.
- Do not stage, commit, push, release, or publish anything.

---

### Task 1: Canonical Application Branding

**Files:**

- Modify: `apps/web/src/branding.ts`
- Modify: `apps/web/src/branding.logic.ts`
- Modify: `apps/web/src/branding.test.ts`
- Modify: `apps/web/src/tauriDesktopBridge.ts`
- Modify: `apps/web/src/tauriDesktopBridge.test.ts`
- Modify: `apps/desktop/src-tauri/src/config.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src-tauri/Cargo.toml`

**Interfaces:**

- Consumes: existing `DesktopAppBranding`, `formatAppDisplayName`, and Tauri `app_branding` contracts.
- Produces: `baseName: "BiBCode"`; stable display name `BiBCode`; development/nightly display names `BiBCode (Dev)` and `BiBCode (Nightly)`.

- [ ] **Step 1: Change branding tests to the approved name**

Update the focused assertions to require:

```ts
expect(APP_BASE_NAME).toBe("BiBCode");
expect(formatAppDisplayName({ baseName: "BiBCode", stageLabel: "Alpha" })).toBe("BiBCode");
expect(formatAppDisplayName({ baseName: "BiBCode", stageLabel: "Dev" })).toBe("BiBCode (Dev)");
expect(branding?.baseName).toBe("BiBCode");
expect(branding?.displayName).toBe(`BiBCode (${branding?.stageLabel})`);
```

For the Rust branding test, require `baseName == "BiBCode"` and omit the
`(Alpha)` suffix from the stable display name.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
vp test apps/web/src/branding.test.ts apps/web/src/tauriDesktopBridge.test.ts
cargo test -j 2 -p bibcode-desktop config::tests -- --test-threads=1
```

Expected: failures containing the pre-rebrand display values.

- [ ] **Step 3: Change the canonical branding roots**

Use the following display-name rule:

```ts
export function formatAppDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string;
}): string {
  return input.stageLabel === "Alpha" || input.stageLabel === "Latest"
    ? input.baseName
    : `${input.baseName} (${input.stageLabel})`;
}
```

Set both TypeScript and Rust `APP_BASE_NAME` values to `BiBCode`. In Rust,
derive `displayName` with the same stable/dev/nightly rule. Change Tauri
`productName` and the main-window title to `BiBCode`, and change package/Cargo
descriptions and authorship text that presents the old product brand. Keep
the pre-rebrand Tauri identifier, package names, crate names, and build filters
unchanged.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 commands. Expected: all selected tests pass.

- [ ] **Step 5: Review checkpoint without staging or committing**

```powershell
git diff --check -- apps/web/src/branding.ts apps/web/src/branding.logic.ts apps/web/src/branding.test.ts apps/web/src/tauriDesktopBridge.ts apps/web/src/tauriDesktopBridge.test.ts apps/desktop/src-tauri/src/config.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tauri.conf.json apps/desktop/package.json apps/desktop/src-tauri/Cargo.toml
```

### Task 2: Application and Marketing Copy

**Files:**

- Modify: `apps/web/index.html`
- Modify: `apps/web/src/components/SplashScreen.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Modify: `apps/web/src/components/chat/composerCommandItems.ts`
- Modify: `apps/web/src/components/chat/ComposerCommandMenu.tsx`
- Modify: `apps/web/src/components/cloud/RelayClientInstallDialog.tsx`
- Modify: `apps/web/src/components/desktop/SshPasswordPromptDialog.tsx`
- Modify: `apps/web/src/components/desktopUpdate.logic.ts`
- Modify: `apps/web/src/components/preview/PreviewPanel.tsx`
- Modify: `apps/web/src/components/RightPanelTabs.tsx`
- Modify: `apps/web/src/components/settings/ConnectionsSettings.tsx`
- Modify: `apps/web/src/components/settings/DiagnosticsSettings.tsx`
- Modify: `apps/web/src/components/settings/KeybindingsSettings.tsx`
- Modify: `apps/web/src/components/settings/providerStatus.ts`
- Modify: `apps/web/src/components/settings/RemoteDirectoryPickerDialog.tsx`
- Modify: `apps/web/src/components/settings/resourceDiagnosticsPresentation.ts`
- Modify: `apps/web/src/components/settings/ResourceDiagnosticsSections.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `apps/web/src/components/status-bar/ResourceUsageSegment.tsx`
- Modify: `apps/web/src/components/status-bar/statusBarPresentation.ts`
- Modify: `apps/web/src/routes/_chat.tsx`
- Modify: `apps/web/src/tauriDesktopBridge.ts`
- Modify: `apps/web/src/versionSkew.ts`
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/src/lib/terminalFont.ts`
- Modify: adjacent `*.test.ts` and `*.test.tsx` files for every production file above
- Modify: `apps/marketing/src/layouts/Layout.astro`
- Modify: `apps/marketing/src/pages/index.astro`
- Modify: `apps/marketing/src/pages/download.astro`
- Modify: `apps/marketing/src/lib/tweets.ts`

**Interfaces:**

- Consumes: the canonical `APP_BASE_NAME`/`APP_DISPLAY_NAME` values from Task 1.
- Produces: BiBCode UI copy, accessibility text, metadata, diagnostics labels, update prompts, and marketing copy.

- [ ] **Step 1: Update focused expectations to BiBCode**

Change visible expectations, for example:

```ts
expect(prompt).toContain("Install update and restart BiBCode?");
expect(menuSections).toContain("BiBCode");
expect(markup).toContain("BiBCode Core");
expect(markup).toContain('alt="BiBCode"');
```

Use `BiBCode Connect` for the visible cloud-connect feature and `BiBCode
JetBrainsMono Nerd Font Mono` for the bundled font-family display name. Do not
rename TypeScript symbols or files containing the retired brand yet.

- [ ] **Step 2: Run affected web tests and verify RED**

```powershell
vp test apps/web/src/components/desktopUpdate.logic.test.ts apps/web/src/components/SidebarBrand.test.tsx apps/web/src/components/chat/ComposerCommandMenu.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/settings/DiagnosticsSettings.test.tsx apps/web/src/components/settings/ResourceDiagnosticsSections.test.tsx apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/versionSkew.test.ts
```

Expected: assertions still receive pre-rebrand strings.

- [ ] **Step 3: Replace visible copy without renaming compatibility identifiers**

Apply these context-aware replacements across the listed production and
adjacent test files:

```text
retired product name       -> BiBCode
retired core label         -> BiBCode Core
retired server label       -> BiBCode Server
retired UI label           -> BiBCode UI
retired connect label      -> BiBCode Connect
retired font-family label  -> BiBCode JetBrainsMono...
```

Keep lower-case imports, storage keys, data attributes, environment variables,
and protocol values unchanged.

- [ ] **Step 4: Run affected web and marketing checks**

```powershell
vp test apps/web/src/components/desktopUpdate.logic.test.ts apps/web/src/components/SidebarBrand.test.tsx apps/web/src/components/chat/ComposerCommandMenu.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx apps/web/src/components/settings/DiagnosticsSettings.test.tsx apps/web/src/components/settings/ResourceDiagnosticsSections.test.tsx apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/versionSkew.test.ts
corepack pnpm --filter @bibcode/marketing build
```

Expected: all tests and the marketing build pass.

- [ ] **Step 5: Review checkpoint without staging or committing**

```powershell
git diff --check -- apps/web apps/marketing
```

### Task 3: Releases, Installers, CI, and Published Artifact Names

**Files:**

- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/desktop-ui-smoke.yml`
- Modify: `.github/workflows/deploy-relay.yml`
- Modify: `scripts/resolve-nightly-release.ts`
- Modify: `scripts/resolve-nightly-release.test.ts`
- Modify: `scripts/build-desktop-artifact.ts`
- Modify: `scripts/build-desktop-artifact.test.ts`
- Modify: `scripts/build-tauri-update-manifest.test.ts`
- Modify: `scripts/release-smoke.ts`
- Modify: `scripts/release-smoke.test.ts`
- Modify: `scripts/release-workflow.test.ts`
- Modify: `scripts/tauri-hardening.test.ts`

**Interfaces:**

- Consumes: Tauri `productName: "BiBCode"` from Task 1.
- Produces: `BiBCode vX.Y.Z`, `BiBCode Nightly ...`, BiBCode installer names, and `bibcode-update-<target>.app.tar.gz`.

- [ ] **Step 1: Change release and artifact expectations**

```ts
expect(metadata.name).toBe("BiBCode Nightly 0.3.1-nightly.20260731.1 (0123456789ab)");
expect(descriptor.artifact).toBe("bibcode-update-darwin-aarch64.app.tar.gz");
expect(releaseWorkflow).toContain('echo "name=BiBCode v$version"');
```

Update desktop-smoke expectations to locate `BiBCode.exe`/`BiBCode.app` while
leaving Cargo package selectors and `BIBCODE_E2E_*` variables unchanged.

- [ ] **Step 2: Run release tests and verify RED**

```powershell
vp test scripts/resolve-nightly-release.test.ts scripts/build-desktop-artifact.test.ts scripts/build-tauri-update-manifest.test.ts scripts/release-smoke.test.ts scripts/release-workflow.test.ts scripts/tauri-hardening.test.ts
```

- [ ] **Step 3: Implement the published-name changes**

Change release titles and notes to BiBCode. Change only the published macOS
updater archive prefix in `build-desktop-artifact.ts`:

```ts
const publishedArtifact = updaterBundleDir
  ? `bibcode-update-${plan.updaterManifestTarget}.app.tar.gz`
  : stagedArtifacts.find(({ source }) => source === path.join(bundleDir, artifact))!.target;
```

Remove stale comments and URLs naming retired upstream deployment domains; do
not invent a replacement domain. Keep the updater repository argument as
`${{ github.repository }}` and the committed endpoint on `mubeda/BibCode`.

- [ ] **Step 4: Run release tests and verify GREEN**

Run the Step 2 command. Expected: all selected release tests pass.

- [ ] **Step 5: Review checkpoint without staging or committing**

```powershell
git diff --check -- .github scripts
```

### Task 4: Documentation and Repository Metadata

**Files:**

- Modify: `README.md`
- Modify: `LICENSE`
- Modify: `AGENTS.md`
- Modify: `.env.example`
- Modify: `.devcontainer/devcontainer.json`
- Modify: every project-owned `*.md`, `*.html`, `*.json`, `*.yaml`, and `*.yml` returned by the audit command below

**Interfaces:**

- Consumes: approved brand mapping and the new release/installer names.
- Produces: project-owned prose and metadata with no user-visible retired identity.

- [ ] **Step 1: Capture the failing documentation audit**

Run a project-owned text audit for every retired visible product-name and mark
variant, excluding VCS metadata, vendored repositories, dependencies, build
outputs, and CodeGraph data. Keep the audit pattern self-hiding so the command
does not match its own definition.

Expected: the current README, docs, metadata, and historical measurement files
are listed.

- [ ] **Step 2: Apply the documentation mapping**

Update every match that identifies the product. Preserve lower-case commands,
environment variables, paths, package names, protocol examples, and explicit
third-party provenance until the internal plans. Change visible `T4 Connect`
to `BiBCode Connect`. Update screenshot alt text and installer/release examples
to the names from Task 3.

- [ ] **Step 3: Repeat the audit and inspect every remaining line**

Run the Step 1 audit. Expected: no product-facing match; any unrelated T4
technical term must be manually confirmed and recorded in the review notes.

- [ ] **Step 4: Verify documentation links and formatting**

```powershell
vp test apps/web/src/markdown-links.test.ts scripts/privacy-contract.test.ts
vp fmt --check README.md docs .github .env.example .devcontainer/devcontainer.json
```

- [ ] **Step 5: Review checkpoint without staging or committing**

```powershell
git diff --check -- README.md LICENSE AGENTS.md .env.example .devcontainer docs
```

### Task 5: BiB Icon Set

**Files:**

- Modify: `assets/prod/logo.svg`
- Modify: `assets/prod/black-macos-1024.png`
- Modify: `assets/prod/black-universal-1024.png`
- Rename: `assets/prod/t4-black-macos.icns` -> `assets/prod/bibcode-black-macos.icns`
- Rename: `assets/prod/t4-black-windows.ico` -> `assets/prod/bibcode-black-windows.ico`
- Rename: `assets/prod/t4-black-web-favicon.ico` -> `assets/prod/bibcode-black-web-favicon.ico`
- Rename: `assets/prod/t4-black-web-favicon-16x16.png` -> `assets/prod/bibcode-black-web-favicon-16x16.png`
- Rename: `assets/prod/t4-black-web-favicon-32x32.png` -> `assets/prod/bibcode-black-web-favicon-32x32.png`
- Rename: `assets/prod/t4-black-web-apple-touch-180.png` -> `assets/prod/bibcode-black-web-apple-touch-180.png`
- Modify: `apps/web/public/favicon.ico`
- Modify: `apps/web/public/favicon-16x16.png`
- Modify: `apps/web/public/favicon-32x32.png`
- Modify: `apps/web/public/apple-touch-icon.png`
- Modify: `apps/marketing/public/favicon.ico`
- Modify: `apps/marketing/public/favicon-16x16.png`
- Modify: `apps/marketing/public/favicon-32x32.png`
- Modify: `apps/marketing/public/apple-touch-icon.png`
- Modify: `apps/marketing/public/icon.png`
- Modify: corresponding `apps/marketing/public/*.webp` files
- Modify: `scripts/lib/brand-assets.ts`
- Modify: `scripts/lib/brand-assets.test.ts`
- Modify: `scripts/apply-web-brand-assets.test.ts`
- Modify: `scripts/tauri-hardening.test.ts`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

**Interfaces:**

- Consumes: the installed `sharp` package and Tauri CLI 2.11.4.
- Produces: one `BiB` SVG master and matching PNG, WebP, ICO, and ICNS assets.

- [ ] **Step 1: Change asset-path tests to the BiBCode filenames**

```ts
expect(BRAND_ASSET_PATHS.windowsIconIco).toBe("assets/prod/bibcode-black-windows.ico");
expect(BRAND_ASSET_PATHS.macIconIcns).toBe("assets/prod/bibcode-black-macos.icns");
expect(BRAND_ASSET_PATHS.webFaviconIco).toBe("assets/prod/bibcode-black-web-favicon.ico");
```

- [ ] **Step 2: Run asset tests and verify RED**

```powershell
vp test scripts/lib/brand-assets.test.ts scripts/apply-web-brand-assets.test.ts scripts/tauri-hardening.test.ts
```

- [ ] **Step 3: Change the SVG master**

Keep the 128-square view box and black rounded rectangle; use this mark:

```svg
<text x="64" y="81" fill="white" font-family="Arial Black, Arial, sans-serif" font-size="48" font-weight="900" text-anchor="middle">BiB</text>
```

- [ ] **Step 4: Generate platform and web assets from the master**

Render 1024px transparent-corner and full-black masters with Sharp, generate
ICO/ICNS through the installed Tauri CLI, resize 16/32/180px web PNGs, and
generate the matching marketing WebP files. Run from the repository root:

```powershell
@'
import sharp from "sharp";

const source = "assets/prod/logo.svg";
await sharp(source).resize(1024, 1024).png().toFile("assets/prod/black-macos-1024.png");
await sharp(source)
  .resize(1024, 1024)
  .flatten({ background: "#000" })
  .png()
  .toFile("assets/prod/black-universal-1024.png");

for (const [size, output] of [
  [16, "assets/prod/bibcode-black-web-favicon-16x16.png"],
  [32, "assets/prod/bibcode-black-web-favicon-32x32.png"],
  [180, "assets/prod/bibcode-black-web-apple-touch-180.png"],
]) {
  await sharp(source).resize(size, size).png().toFile(output);
}
'@ | node --input-type=module

corepack pnpm --filter @bibcode/desktop exec tauri icon assets/prod/black-macos-1024.png --output .tmp/bibcode-icons

Copy-Item -LiteralPath '.tmp/bibcode-icons/icon.icns' -Destination 'assets/prod/bibcode-black-macos.icns'
Copy-Item -LiteralPath '.tmp/bibcode-icons/icon.ico' -Destination 'assets/prod/bibcode-black-windows.ico'
Copy-Item -LiteralPath '.tmp/bibcode-icons/icon.ico' -Destination 'assets/prod/bibcode-black-web-favicon.ico'
```

Then copy the production favicon assets into both public directories and create
the marketing WebP siblings:

```powershell
@'
import sharp from "sharp";
import { copyFile } from "node:fs/promises";

const copies = [
  ["assets/prod/bibcode-black-web-favicon.ico", "apps/web/public/favicon.ico"],
  ["assets/prod/bibcode-black-web-favicon-16x16.png", "apps/web/public/favicon-16x16.png"],
  ["assets/prod/bibcode-black-web-favicon-32x32.png", "apps/web/public/favicon-32x32.png"],
  ["assets/prod/bibcode-black-web-apple-touch-180.png", "apps/web/public/apple-touch-icon.png"],
  ["assets/prod/bibcode-black-web-favicon.ico", "apps/marketing/public/favicon.ico"],
  ["assets/prod/bibcode-black-web-favicon-16x16.png", "apps/marketing/public/favicon-16x16.png"],
  ["assets/prod/bibcode-black-web-favicon-32x32.png", "apps/marketing/public/favicon-32x32.png"],
  ["assets/prod/bibcode-black-web-apple-touch-180.png", "apps/marketing/public/apple-touch-icon.png"],
  ["assets/prod/black-universal-1024.png", "apps/marketing/public/icon.png"],
];
await Promise.all(copies.map(([source, target]) => copyFile(source, target)));

for (const [source, target] of [
  ["apps/marketing/public/favicon-16x16.png", "apps/marketing/public/favicon-16x16.webp"],
  ["apps/marketing/public/favicon-32x32.png", "apps/marketing/public/favicon-32x32.webp"],
  ["apps/marketing/public/apple-touch-icon.png", "apps/marketing/public/apple-touch-icon.webp"],
  ["apps/marketing/public/icon.png", "apps/marketing/public/icon.webp"],
]) {
  await sharp(source).webp({ quality: 90 }).toFile(target);
}
'@ | node --input-type=module
```

Remove only the six superseded `assets/prod/t4-black-*` files after every
replacement exists and decodes successfully.

- [ ] **Step 5: Update all asset references and verify GREEN**

Update `BRAND_ASSET_PATHS`, Tauri `bundle.icon`, and their tests, then run the
Step 2 command. Expected: all asset tests pass.

- [ ] **Step 6: Decode and visually inspect representative assets**

Use `view_image` on:

```text
assets/prod/black-universal-1024.png
assets/prod/black-macos-1024.png
assets/prod/bibcode-black-web-favicon-16x16.png
assets/prod/bibcode-black-web-apple-touch-180.png
```

Confirm `BiB` is centered, legible, uncropped, and consistent at all sizes.
Verify ICO layers and ICNS decoding through Tauri's hardening tests.

- [ ] **Step 7: Review checkpoint without staging or committing**

```powershell
git diff --check -- assets apps/web/public apps/marketing/public scripts/lib/brand-assets.ts scripts/lib/brand-assets.test.ts scripts/apply-web-brand-assets.test.ts scripts/tauri-hardening.test.ts apps/desktop/src-tauri/tauri.conf.json
```

### Task 6: Brand-Clean Marketing Screenshots

**Files:**

- Modify: `apps/desktop/e2e/specs/main-window.e2e.ts`
- Modify: `apps/marketing/public/screenshot.webp`
- Modify: `apps/marketing/public/updated-screenshot.webp`
- Modify: `.artifacts/diagnostics-log-bundle/before-desktop.png`
- Modify: `.artifacts/diagnostics-log-bundle/after-desktop.png`
- Modify: `.artifacts/diagnostics-log-bundle/before-compact.png`
- Modify: `.artifacts/diagnostics-log-bundle/after-compact.png`
- Modify: marketing image references/alt text in `apps/marketing/src/pages/index.astro`

**Interfaces:**

- Consumes: the rebranded packaged app and E2E fixture.
- Produces: two current BiBCode product screenshots with no T3/T4 identity.

- [ ] **Step 1: Add reproducible marketing captures to the existing E2E spec**

After the project is visible, add:

```ts
await setDesktopUiWindowSize(1280, 900);
await browser.saveScreenshot(NodePath.join(artifactDirectory, "main-window-marketing.png"));
```

Keep the existing 960x640 minimum-size capture as the second source image.

- [ ] **Step 2: Build and run the focused packaged UI test**

```powershell
$captureRoot = Join-Path (Resolve-Path '.artifacts') 'bibcode-marketing'
New-Item -ItemType Directory -Force -Path $captureRoot | Out-Null
$env:BIBCODE_E2E_ARTIFACT_DIR = $captureRoot
corepack pnpm --filter @bibcode/desktop test:ui:build
corepack pnpm --filter @bibcode/desktop test:ui -- --spec ./e2e/specs/main-window.e2e.ts
```

Expected: the two PNG captures exist in the configured E2E artifact directory
and show BiBCode/BiB branding.

- [ ] **Step 3: Convert the captures to the existing marketing WebP paths**

Use Sharp with quality 90, preserving each capture's aspect ratio. Replace
`screenshot.webp` with the 960x640 capture and `updated-screenshot.webp` with
the 1280x900 capture:

```powershell
@'
import sharp from "sharp";

await sharp(".artifacts/bibcode-marketing/main-window-minimum-size.png")
  .webp({ quality: 90 })
  .toFile("apps/marketing/public/screenshot.webp");
await sharp(".artifacts/bibcode-marketing/main-window-marketing.png")
  .webp({ quality: 90 })
  .toFile("apps/marketing/public/updated-screenshot.webp");
'@ | node --input-type=module
```

Update alt text to describe BiBCode.

- [ ] **Step 4: Inspect both screenshots at original detail**

Use `view_image` on both WebP files. Check the title/sidebar/icon, visible
workspace/project labels, terminal content, file paths, and tool-call text for
every retired-brand leftover. Recapture rather than paint over any bad content.

- [ ] **Step 5: Edit the four retained diagnostics artifacts**

After inspecting each PNG with `view_image`, use the image-editing tool with all
four exact source paths and this constrained instruction:

```text
Preserve the screenshot pixel dimensions, layout, colors, controls, spacing,
and all non-brand text. Replace visible retired product and process labels with
their `BiBCode` and `bibcode` equivalents. Make no other changes.
```

Inspect all four edited files again at original detail. Reject and retry any
edit that changes non-brand UI or leaves old text.

- [ ] **Step 6: Build marketing and review without staging or committing**

```powershell
corepack pnpm --filter @bibcode/marketing build
git diff --check -- apps/desktop/e2e/specs/main-window.e2e.ts apps/marketing/public apps/marketing/src/pages/index.astro .artifacts/diagnostics-log-bundle
```

### Task 7: Phase 1 Identity Gate and Full Verification

**Files:**

- Modify the identity guard script under its then-current retired filename.

**Interfaces:**

- Consumes: all Phase 1 changes.
- Produces: an automated guard against standalone visible legacy product labels while allowing embedded compatibility identifiers until later plans.

- [ ] **Step 1: Add self-hiding visible-brand patterns**

Define self-hiding patterns for every retired visible product-name and standalone
mark variant. The guard must not match its own source.

Scan project-owned text and paths, excluding `.repos`, dependencies, outputs,
CodeGraph, the guard itself, and ignored design/plan documents. Embedded source
identifiers such as `BiBCodeConnectSidebarSignIn` remain allowed until the code
identity plan.

- [ ] **Step 2: Run the guard and remove every accidental visible match**

Run the identity guard test at its then-current retired path.

Expected: PASS with no allowlist for product-facing strings.

- [ ] **Step 3: Run all project checks**

```powershell
vp check
vp run typecheck
vp test
cargo test --workspace --locked -j 2 -- --test-threads=1
corepack pnpm --filter @bibcode/web build
corepack pnpm --filter @bibcode/marketing build
```

Expected: every command exits 0.

- [ ] **Step 4: Perform the final Phase 1 path/text/image audit**

Run the self-hiding retired-identity content audit and the equivalent tracked and
untracked path audit, excluding VCS metadata, vendored repositories, dependencies,
build outputs, and CodeGraph data. Then run `git status --short` and
`git diff --check`.

Inspect every result. Only compatibility-sensitive lowercase/internal paths and
embedded source identifiers scheduled for later plans may remain. Re-open all
project-owned images that contained legacy identity.

- [ ] **Step 5: Report the Phase 1 gate without staging or committing**

Report exact check results, remaining compatibility identifier categories, and
the unstaged diff summary. Proceed immediately to the code-identity plan only
after this gate is green.
