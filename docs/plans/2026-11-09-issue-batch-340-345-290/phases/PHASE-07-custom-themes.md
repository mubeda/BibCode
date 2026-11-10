# Phase 7: Custom color themes

- Goal: A person picks from six built-in themes and creates, edits, imports and exports custom themes in a new Appearance section, with the app, the terminal and the pre-paint step following the choice and the default look unchanged, with a reviewed design note and tests (#290).
- Round: 1
- Depends on: none
- Owns: `apps/web/src/themes/**`, `apps/web/src/browser/**`, `apps/web/src/index.css`, `apps/web/src/hooks/useTheme.ts`, `apps/web/src/hooks/useTheme.test.ts`, `apps/web/src/themeTokens.test.ts`, `apps/web/public/theme-bootstrap.js`, `scripts/lib/theme-bootstrap.ts`, `scripts/lib/theme-bootstrap.test.ts`, `apps/web/src/components/terminalTheme.ts`, `apps/web/src/components/terminalTheme.test.ts`, `apps/web/src/components/ThreadTerminalPanel.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/pipelines/log/**`, `apps/web/src/components/settings/**`, `apps/web/src/routes/settings*.tsx`, `apps/web/src/routeTree.gen.ts`, `apps/web/src/components/ui/**`, `apps/web/src/components/chat/ComposerPrimaryActions.tsx`, `apps/web/src/browser/annotationTheme.ts`, `apps/web/src/browser/annotationTheme.test.ts`, `packages/contracts/src/theme.ts`, `packages/contracts/src/theme.test.ts`, `packages/contracts/src/index.ts`, `docs/plans/2026-11-09-custom-themes-design.md`, and the selected-state class in the files Task 7.3 lists
- Must not touch: `apps/web/src/components/files/**` (Phase 6), `apps/web/src/components/pipelines/detail/**` (Phase 1; Task 8.4 switches its one selected-state class), `apps/web/src/components/GitActionsControl.tsx`, `apps/web/src/components/SourceControlPanel.tsx`, `apps/web/src/components/gitManager/GitManagerPanel.tsx` and `apps/web/src/components/gitManager/toolbar/GitManagerOperationBanner.tsx` (Phase 4), `apps/web/package.json` and `pnpm-lock.yaml` (Phase 6; this phase adds no dependency), `apps/web/THIRD_PARTY_NOTICES.md`, `docs/user/workspace-ui.md`, `apps/desktop/**`, `apps/server/**`
- Skills: test-driven-development (every theme behavior starts from a failing test); vercel-react-best-practices (AGENTS.md requires it for changed React components); ui-ux-pro-max (the Appearance list and editor layout)
- Read first: `spec.md` section G (R36 to R61, D9, D17 to D20, the Fixed pairs and Supported tokens definitions) and its Constraints; `theme-palettes.md` (every built-in value); `UI.md`; `AGENTS.md` (Task Completion Requirements)
- Checkpoint: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/themes src/hooks/useTheme.test.ts src/components/settings` exits 0 and `vp test run scripts` exits 0. Settings shows an Appearance section where picking Tokyo Night repaints the app.

Web test command used below, always run from `apps/web`: `node ../../scripts/run-local-vp.mjs test run --project unit <path>`, written as `WEBTEST <path>`.

Tasks in this phase run one after another, in the order their Depends on lines give (7.1, 7.2, 7.3, 7.13, 7.4, 7.5, 7.6, 7.7, 7.14, 7.8, 7.9, 7.10, 7.11, 7.12); several of them change `index.css`, `useTheme.ts` and `AppearanceSettingsPanel.tsx`. Round-1 phases do not run the repository-wide `vp run typecheck`, which also checks Rust; Phase 8 does.

Color syntax (plan decision P16): a theme color is a hex color, `rgb()`, `hsl()` or `oklch()`. Named colors and every other function are rejected, so one parser serves validation, contrast, previews and the pre-paint record.

Storage keys (plan decision P6): `bibcode:theme` (existing mode, unchanged), `bibcode:themes:v1` (custom library), `bibcode:theme-slots:v1` (`{ light: ThemeId, dark: ThemeId }`), and `bibcode:theme-paint:v1` (a precomputed `{ light: PaintRecord, dark: PaintRecord }` that the pre-paint script reads, where `PaintRecord = { base: "light" | "dark"; background: string; vars: Record<string, string> }`, every color normalized to hex, plus `stamp`, a hash of the slots and of the two slot themes). The slots record stores the same value as `paintStamp`. Writes go paint record first, slots second, so after an interrupted write the stamps differ; the pre-paint script applies a paint record only when its `stamp` equals the slots' `paintStamp`, and otherwise paints the built-in base. The store rebuilds the paint record at start when it is missing, unreadable or has a different stamp.

## Tasks

### Task 7.1: Write and review the design note

- Satisfies: support (unblocks 7.2 to 7.12; the spec's Constraints require a reviewed design note for #290)
- Depends on: none
- Files: create `docs/plans/2026-11-09-custom-themes-design.md`
- Interfaces: consumes `spec.md` section G, `theme-palettes.md` and decisions D9 and D17 to D20; produces the design note sections named in step 1. The names in the Interfaces lines of Tasks 7.2 to 7.12 are binding; a note that needs to change one logs a Ruling in `progress.md`.
- Skills: none
- Read first: `docs/plans/2026-11-07-git-manager-interactive-sign-in-design.md` (house format); `apps/web/src/index.css` lines 243-335 (the token blocks) and 354, 465-480, 1046-1065 (colors outside them); GitHub issue #290 (`gh issue view 290`) sections "Prior art" and "Proposal"
- Tier: most capable
- TDD: exempt (a design document has no behavior to test)
- Done when: the file exists, its first lines read `Status: Approved 2026-11-09 (pre-approved: reviewed by Codex and the advisor)`, it has a "Review handling" section, and `vp run check:markdown-links` exits 0

Steps

1. [ ] Write the note with these sections: Problem and scope; Alternatives (base plus overrides chosen; a full palette per theme and server-side storage rejected, with the reasons in D9); Theme file format (the schema of Task 7.2); Token list (every supported color token with its group in the editor, the six new color tokens of D17 with the exact default recipe of each, and the non-color tokens with their ranges); Where `foreground-strong` is used (at minimum Markdown headings and settings section titles); Selection model (mode plus two slots, R39 and R40); Storage (the four keys above, the paint record, cross-window sync, corrupt-entry handling); Applying a theme (inline properties set and cleared, the pre-paint script, the content policy constraint); Terminal (R51, R52); Validation and security (R48: what counts as a color, the deny list, limits); Contrast (the fixed pairs, the editor warning, the import reset rule of R55); Focus ring and control shadow (the CSS-only approach of Task 7.12); Built-in themes (pointer to `theme-palettes.md`, the subtitle text of each, license notices); Risks; Test plan.
2. [ ] Get a read-only Codex review of the note (`codex exec --sandbox read-only`, prompt: review this design against `spec.md` section G and `theme-palettes.md` for gaps, contradictions and injection risks). Get a second review from the advisor tool when the session has one, otherwise from a fresh read-only subagent. Process both with `receiving-review.md`.
3. [ ] Fix every accepted finding, list each finding and its outcome under "Review handling", and set the Status line (spec decision D3).
4. [ ] Run `vp run check:markdown-links`. Expected: exits 0.

### Task 7.2: Theme file format and validation

- Satisfies: R36 (one-color theme; unknown token), R48 (injection attempts; limits)
- Depends on: 7.1
- Files: create `packages/contracts/src/theme.ts`; create `packages/contracts/src/theme.test.ts`; modify `packages/contracts/src/index.ts`; create `apps/web/src/themes/themeValidation.ts`; create `apps/web/src/themes/themeValidation.test.ts`
- Interfaces: consumes Effect `Schema` as the other contracts modules do; produces in `theme.ts` (schema only, no runtime logic): `THEME_FILE_VERSION = 1`, `ThemeBase = Schema.Literals(["light", "dark"])`, `UI_COLOR_TOKENS` (the supported color tokens, as a readonly tuple), `UI_LENGTH_TOKENS = ["radius", "focus-ring-width", "focus-ring-offset"]`, `UI_KEYWORD_TOKENS = ["sidebar-card-shadow", "control-shadow"]`, `TERMINAL_TOKENS` (`background`, `foreground`, `cursor`, `selection-background`, `selection-foreground` and the 16 ANSI names), `RESERVED_THEME_IDS = ["system", "light", "dark", "tokyo-night", "matrix-dark", "matrix-light", "verdant-light"]`, `ThemeId` (1 to 48 characters of lowercase letters, digits and hyphens), and `ThemeFile = { version: 1; id: ThemeId; name: string (1 to 48 characters); base: ThemeBase; ui?: Partial<Record<UiToken, string>>; terminal?: Partial<Record<TerminalToken, string>> }` rejecting unknown keys at every level. In `themeValidation.ts`: `MAX_THEME_FILE_BYTES = 16 * 1024`, `MAX_CUSTOM_THEMES = 64`, `type ThemeFieldError = { field: string; message: string }`, `isSafeCssColor(value: string): boolean`, and `validateThemeFile(input: unknown, options: { allowReservedId: boolean; byteLength?: number }): { ok: true; theme: ThemeFile } | { ok: false; errors: ThemeFieldError[] }`.
- Skills: none
- Read first: the design note sections "Theme file format", "Token list" and "Validation and security"; `packages/contracts/src/settings.ts` lines 100-120 (how a literal union with a default is declared); `apps/web/src/components/settings/ProviderAccentColorPicker.tsx` (`normalizeProviderAccentColor`, the existing hex rule)
- Tier: most capable
- TDD: red-green
- Done when: `vp test run packages/contracts/src/theme.test.ts` exits 0 and `WEBTEST src/themes/themeValidation.test.ts` exits 0, with at least 14 tests passing in total, and `vp run check:contracts` exits 0 with no fixture diff

Steps

1. [ ] In `theme.test.ts`, add: `a theme with only a base decodes`; `a one-color theme decodes and keeps only that token`; `an unknown ui token is rejected and the error names it`; `an unknown top-level field is rejected`; `a name of 0 or 49 characters is rejected`; `an id with uppercase or spaces is rejected`.
2. [ ] In `themeValidation.test.ts`, add: `hex, rgb(), hsl() and oklch() colors are accepted and named colors, color-mix() and inherit are rejected`; `url(), var(), expression(), a semicolon and a brace are rejected` (values `url(https://example.test/x)`, `var(--x)`, `expression(1)`, `red; background: blue`, `red}`); `radius accepts 0 to 1rem and rejects 2rem`; `focus-ring-width accepts 1px to 3px and focus-ring-offset 0px to 3px`; `sidebar-card-shadow accepts only none and control-shadow only none or default`; `a 17 KiB file is rejected by size`; `a reserved id is rejected unless allowReservedId is set`; `every error names its field` (two invalid colors give two errors with fields `ui.primary` and `terminal.red`).
3. [ ] Run both commands under Done when. Expected: FAIL, the modules do not exist.
4. [ ] Implement `theme.ts` and add `export * from "./theme.ts"` to `packages/contracts/src/index.ts`. Implement `themeValidation.ts`: `isSafeCssColor` rejects any value containing `url(`, `var(`, `expression(`, `;`, `{`, `}`, `<` or a backslash, then requires the value to match the strict grammar for hex (3, 4, 6 or 8 digits) or the `rgb()`, `hsl()` and `oklch()` functions with numeric arguments. It does not use `CSS.supports`, so the result is the same in the browser, in tests and in the pre-paint script.
5. [ ] Run both commands. Expected: PASS, at least 14 tests.
6. [ ] Prove the test can fail: make `isSafeCssColor` return true for every string, run `WEBTEST src/themes/themeValidation.test.ts`. Expected: FAIL. Restore and run again. Expected: PASS.
7. [ ] Run `vp run check:contracts`, `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: exit 0, no fixture diff, no errors.

### Task 7.3: New color tokens that default to today's look

- Satisfies: R38 (existing user), R50 (defaults; a theme sets them)
- Depends on: 7.2
- Files: modify `apps/web/src/index.css`; create `apps/web/src/themes/tokens.test.ts`; modify `apps/web/src/themeTokens.test.ts`; modify `apps/web/src/components/ui/input.tsx`; modify `apps/web/src/components/ui/select.tsx`; modify `apps/web/src/components/ui/button.tsx`; modify `apps/web/src/components/ui/badge.tsx`; modify the selected-state class in the files step 1 lists
- Interfaces: consumes the token blocks of `index.css` (`:root` from line 243, the dark variant from about line 287, `@theme inline` at line 44); produces six `--color-*` mappings in `@theme inline`, each with its default as a `var()` fallback so the default is resolved where the utility is used and follows a base token that a subtree overrides (`.dark [data-sidebar-card]` overrides `--muted-foreground` at line 354): `--color-foreground-strong: var(--foreground-strong, var(--foreground))`; `--color-placeholder: var(--placeholder, color-mix(in srgb, var(--muted-foreground) 72%, transparent))`; `--color-primary-hover: var(--primary-hover, color-mix(in srgb, var(--primary) 90%, transparent))`; `--color-primary-active: var(--primary-active, color-mix(in srgb, var(--primary) 90%, transparent))`; `--color-selected: var(--selected, var(--accent))`; `--color-selected-foreground: var(--selected-foreground, var(--accent-foreground))`. The variables `--foreground-strong`, `--placeholder`, `--primary-hover`, `--primary-active`, `--selected` and `--selected-foreground` are not declared in the light or dark block; only a theme sets them. The utilities are `text-foreground-strong`, `placeholder:text-placeholder`, `bg-primary-hover`, `bg-primary-active`, `bg-selected` and `text-selected-foreground`.
- Skills: none
- Read first: the design note sections "Token list" and "Where `foreground-strong` is used"; `apps/web/src/components/ui/button.tsx` line 35 and `apps/web/src/components/ui/input.tsx` line 22
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/themes/tokens.test.ts src/themeTokens.test.ts src/components/ui` exits 0 with the 9 new tests passing

Steps

1. [ ] Run `rg -n "data-selected:bg-accent|selected && \"bg-accent\"|isSelected && \"bg-accent\"|aria-selected:bg-accent" apps/web/src --glob '!*.test.*'` and record the file list in the task's log line. Expected: about 4 to 17 files. Exclude every file under `components/files/`, `components/pipelines/detail/`, `GitActionsControl.tsx`, `SourceControlPanel.tsx`, `gitManager/GitManagerPanel.tsx` and `gitManager/toolbar/GitManagerOperationBanner.tsx`; list any excluded file that has a selected-state class in the log line so Task 8.4 can switch it. Hover and highlight states (`hover:bg-accent`, `data-highlighted:bg-accent`) are not selection and stay as they are.
2. [ ] In `tokens.test.ts`, read `index.css` as text and add: `each of the six new tokens has a --color mapping in the theme block with the exact fallback from Interfaces`; `none of the six variables is declared in the light or dark block`; in the existing `apps/web/src/themeTokens.test.ts` (which computes real property values), `a placeholder inside a dark sidebar card resolves from the card's muted-foreground` and `the default primary hover equals primary at 90 percent`; `no existing token value in the light or dark block changed` (compare each existing declaration against a snapshot written into the test from the current file).
3. [ ] Add component tests next to the UI components: `the input placeholder uses the placeholder token` (class `placeholder:text-placeholder`, no `/72`); `the default button hovers with primary-hover and presses with primary-active`; and in `apps/web/src/themeTokens.test.ts`, `button idle, hover and pressed colors are unchanged in Light and Dark` (computed colors compared with the values recorded before the change) and `Verdant Light hover and pressed values apply when the theme sets them` (`#066649` and `#05543d`).
4. [ ] Run `WEBTEST src/themes/tokens.test.ts src/themeTokens.test.ts src/components/ui`. Expected: FAIL, the mappings are not declared.
5. [ ] Add the six mappings to `@theme inline` in `index.css`. Switch `input.tsx` and `select.tsx` to `placeholder:text-placeholder`; in the default variant of `button.tsx` and `badge.tsx` replace `[:hover,[data-pressed]]:bg-primary/90` with `hover:bg-primary-hover data-pressed:bg-primary-active active:bg-primary-active` (the house `Button` has no pressed-state controller, so the native `:active` state needs its own class) (both default to today's 90 percent mix, so idle, hover and pressed colors are unchanged); leave the Send button in `ComposerPrimaryActions.tsx` exactly as it is, because it rests at 90 percent and hovers at full primary, which is a different pattern; switch the files from step 1 from `bg-accent` (and a paired `text-accent-foreground`) to `bg-selected` and `text-selected-foreground`; apply `text-foreground-strong` where the design note says.
6. [ ] Run the same command. Expected: PASS.
7. [ ] Prove the test can fail: change the placeholder fallback to `var(--muted-foreground)`, run `WEBTEST src/themes/tokens.test.ts`. Expected: FAIL. Restore and run again. Expected: PASS.
8. [ ] Run `vp run --filter @bibcode/web test`. Expected: PASS; a test that asserted an old class name is updated to the new class and listed in the log line.
9. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 7.4: Built-in theme files and the contrast check

- Satisfies: R37 (Tokyo Night values; Verdant Light values; built-in protection), R56 (computed check)
- Depends on: 7.13
- Files: create `apps/web/src/themes/builtin/tokyo-night.json`; create `apps/web/src/themes/builtin/matrix-dark.json`; create `apps/web/src/themes/builtin/matrix-light.json`; create `apps/web/src/themes/builtin/verdant-light.json`; create `apps/web/src/themes/builtinThemes.ts`; create `apps/web/src/themes/builtinThemes.test.ts`
- Interfaces: consumes `ThemeFile`, `validateThemeFile` with `allowReservedId: true`, `RESERVED_THEME_IDS` (Task 7.2), and `failingPairs`, `contrastRatio` and `resolveToken` (Task 7.13); produces `BUILTIN_THEMES: readonly BuiltinTheme[]` in list order Light, Dark, Tokyo Night, Matrix Dark, Matrix Light, Verdant Light, where `BuiltinTheme = ThemeFile & { subtitle: string }`, and `isBuiltinThemeId(id: string): boolean`.
- Skills: none
- Read first: `theme-palettes.md` (every value in the four files comes from its mapping and terminal tables; D17 adds `foreground-strong: #c0caf5` to Tokyo Night and the six new tokens to Verdant Light); the design note section "Built-in themes"
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/themes/builtinThemes.test.ts` exits 0 with at least 12 tests passing

Steps

1. [ ] In `builtinThemes.test.ts`, add one case per new built-in: `decodes with validateThemeFile and has no unknown token`; and the value checks `Tokyo Night sets background #1a1b26, primary #7aa2f7, border #414868, foreground-strong #c0caf5 and ANSI green #9ece6a`, `Matrix Dark sets background #080c09, primary #3cbf5c, panel-separator #3cbf5c and ANSI green #2d9a48`, `Matrix Light sets background #ffffff, primary #15803d, input #16a34a and ANSI green #15803d`, `Verdant Light sets background #ffffff, foreground #303840, primary #087f5b, input #87939b, placeholder #667078, primary-hover #066649, primary-active #05543d, selected #eaf5ef, selected-foreground #065f46 and panel-separator #dee3e6`.
2. [ ] Add: `Light and Dark have no overrides`; `the list order is Light, Dark, Tokyo Night, Matrix Dark, Matrix Light, Verdant Light`; `every reserved id is a built-in or system`; `each new built-in keeps every fixed pair at or above 4.5` (`failingPairs(theme, 4.5)` is empty; Tokyo Night muted-foreground on background is 5.75 within 0.01, Matrix Dark muted-foreground on accent 4.81, Verdant Light placeholder on background 5.06); `Matrix Light and Verdant Light keep the input token at or above 3 on the background` (Verdant Light 3.15); `every ANSI color of Matrix Light and Verdant Light is at or above 4.5 on the terminal background`.
3. [ ] Run `WEBTEST src/themes/builtinThemes.test.ts`. Expected: FAIL, the module does not exist.
4. [ ] Create the four JSON files from `theme-palettes.md` and implement `builtinThemes.ts`. Subtitles: Tokyo Night "Based on Omarchy's Tokyo Night", Matrix Dark "Based on omarchy-matrix-theme", Matrix Light "BiBCode original", Verdant Light "BiBCode original". Credit each file's source in a comment in `builtinThemes.ts`, because JSON has no comments.
5. [ ] Apply plan decision P17: the default placeholder (72 percent of muted-foreground) computes to about 3.63 on Tokyo Night's background and about 3.33 on Matrix Light's, below 4.5. In each new built-in whose default placeholder is below 4.5 on its background, set `placeholder` to that theme's `muted-foreground` value (Tokyo Night `#8c94bb`, Matrix Light `#3f6b4a`; compute Matrix Dark and set `#96ba98` only if it fails). Add `each new built-in's placeholder is at or above 4.5 on its background`.
6. [ ] Run the same command. Expected: PASS, at least 12 tests. If any other pair from `theme-palettes.md` computes below its minimum, do not change a value: log a Ruling with the pair and the computed ratio and report it.
7. [ ] Prove the test can fail: set Verdant Light `placeholder` to `#878f94`, run the same command. Expected: FAIL. Restore and run again. Expected: PASS.
8. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 7.5: Theme library and slots store

- Satisfies: R38 (existing user), R39 (System mode with a custom dark theme; wrong base), R49 (one corrupt entry), R61 (second window)
- Depends on: 7.4
- Files: create `apps/web/src/themes/customThemes.ts`; create `apps/web/src/themes/customThemes.test.ts`
- Interfaces: consumes `validateThemeFile`, `MAX_CUSTOM_THEMES` (Task 7.2), `BUILTIN_THEMES` and `isBuiltinThemeId` (Task 7.4), `resolveToken` and `toHex` (Task 7.13), and the `storage` event pattern of `apps/web/src/hooks/useLocalStorage.ts` (line 81, custom event `bibcode:local_storage_change`); produces `type ThemeSlots = { light: string; dark: string }` (stored with a `paintStamp`), `type PaintRecord = { base: "light" | "dark"; background: string; vars: Record<string, string>; stamp: string }`, `getThemeRevision(): number` (raised on every library or slot change, including a saved edit to a theme with the same id), `listThemes(): ThemeFile[]` (built-ins then custom), `getTheme(id: string): ThemeFile | undefined`, `readSlots(): ThemeSlots` (defaults `{ light: "light", dark: "dark" }`), `setSlot(base: "light" | "dark", id: string): { ok: true } | { ok: false; reason: "wrong-base" | "unknown-theme" }`, `saveCustomTheme(theme: ThemeFile): { ok: true } | { ok: false; errors: ThemeFieldError[] }`, `deleteCustomTheme(id: string): { ok: true } | { ok: false; reason: "builtin" | "unknown-theme" }`, `duplicateTheme(id: string): ThemeFile` (name `<name> copy`, a new unique id), `resetSlots(): void`, `paintRecordFor(theme: ThemeFile): PaintRecord`, `subscribeThemes(listener: () => void): () => void`, `getThemesSnapshot(): { themes: ThemeFile[]; slots: ThemeSlots }` and the hook `useThemeLibrary()`. Every write also rewrites `bibcode:theme-paint:v1`.
- Skills: none
- Read first: the design note sections "Selection model" and "Storage"; `apps/web/src/hooks/useTheme.ts` lines 76-114 (the `ThemeStorageError` pattern for unreadable storage) and 241-294 (module listeners and the external-store subscription)
- Tier: most capable
- TDD: red-green
- Done when: `WEBTEST src/themes/customThemes.test.ts` exits 0 with at least 16 tests passing

Steps

1. [ ] Add tests: `with nothing stored the slots are the built-ins and no key is written`; `a light theme cannot be put in the dark slot` (`wrong-base`); `saving validates and rejects a reserved id and a 65th theme`; `one corrupt stored entry is skipped and logged and the others load`; `a slot that points at a missing theme falls back to the built-in of its base`; `deleting a theme in a slot puts the built-in of the same base in that slot`; `deleting a built-in is refused`; `duplicating Tokyo Night gives "Tokyo Night copy" with the same values and a new id that is not reserved`; `duplicating twice gives two different ids`; `resetSlots keeps the library`; `every write rewrites the paint record for both slots` (the dark record for Tokyo Night has `base: "dark"`, `background: "#1a1b26"` and `vars["--primary"] === "#7aa2f7"`); `a storage event from another window updates the snapshot and notifies subscribers`; `a failed write (quota) reports an error and leaves the previous library readable`; `a missing, corrupt or stale paint record is rebuilt at start from the library and the slots`; `a failure between the library write and the paint write is repaired at the next start`; `paint record colors are normalized to hex`.
2. [ ] Run `WEBTEST src/themes/customThemes.test.ts`. Expected: FAIL, the module does not exist.
3. [ ] Implement the store over `localStorage` with the keys named at the top of this phase. Decode each stored theme on its own with `validateThemeFile`; skip and `console.warn` an entry that fails. Keep one cached snapshot object so `getThemesSnapshot` is stable between changes.
4. [ ] Run the same command. Expected: PASS, at least 16 tests.
5. [ ] Prove the test can fail: decode the whole library with one schema call instead of entry by entry, run the same command. Expected: FAIL in the corrupt-entry test. Restore and run again. Expected: PASS.
6. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 7.6: Apply a theme, and paint it before the app appears

- Satisfies: R37 (Tokyo Night values; Verdant Light values), R39 (System mode with a custom dark theme), R41 (switch back to a built-in; light custom theme), R42 (reload with a custom theme; stored theme is corrupt)
- Depends on: 7.5
- Files: modify `apps/web/src/hooks/useTheme.ts`; modify `apps/web/src/hooks/useTheme.test.ts`; modify `apps/web/public/theme-bootstrap.js`; modify `scripts/lib/theme-bootstrap.test.ts`; modify `scripts/lib/theme-bootstrap.ts`
- Interfaces: consumes `readSlots`, `getTheme`, `paintRecordFor`, `subscribeThemes` (Task 7.5), `applyTheme` (useTheme.ts line 176), `syncBrowserChromeTheme`, `syncDesktopTheme` and the `useTheme()` return value `{ theme, setTheme, resolvedTheme }`; produces `useTheme()` returning the same three fields plus `resolvedThemeId: string` and `themeRevision: number` (so a consumer re-renders after a same-id edit; the snapshot identity at line 270 depends only on mode and System state today), `subscribeAppliedTheme(listener: () => void): () => void` which fires after every effective application of a theme (mode change, System change, slot change, saved edit, preview and Cancel), with `resolvedTheme` still `"light" | "dark"` (the active theme's base, so the 23 diff-theme callers and the desktop window theme need no change), and a pre-paint script that reads `bibcode:theme` and `bibcode:theme-paint:v1`.
- Skills: none
- Read first: the design note section "Applying a theme"; `apps/web/src/hooks/useTheme.ts` lines 160-300; `scripts/lib/theme-bootstrap.test.ts` lines 47-210 (how the script is executed in `node:vm`); `scripts/lib/theme-bootstrap.ts` (the versioning and the no-inline-script guard)
- Tier: most capable
- TDD: red-green
- Done when: `WEBTEST src/hooks/useTheme.test.ts` and `vp test run scripts/lib/theme-bootstrap.test.ts` exit 0 with the 14 new tests passing

Steps

1. [ ] In `useTheme.test.ts`, add: `with no stored slots nothing but the dark class changes` (no inline property is set on the root element); `Tokyo Night sets the dark class and --background #1a1b26, --primary #7aa2f7 and --border #414868 and calls setTheme("dark")`; `switching from Matrix Dark to Dark removes every Matrix Dark property`; `Matrix Light leaves the dark class off, sets --input #16a34a and calls setTheme("light")`; `Verdant Light sets --foreground #303840, --placeholder #667078, --selected #eaf5ef, --selected-foreground #065f46 and --panel-separator #dee3e6`; `in System mode an operating-system change to light applies the light slot and clears the dark theme's properties`; `a custom theme on a dark base resolves to "dark" and its id`; `the theme-color meta uses the theme's background`; `subscribeAppliedTheme fires on a mode change, a System change, a slot change and a same-id saved edit, and stops after unsubscribing`.
2. [ ] In `theme-bootstrap.test.ts`, add: `a stored paint record sets the class, the properties and the background before anything else runs` (record with background `#101820`); `a corrupt paint record falls back to the built-in background for the stored mode`; `hostile paint records are not applied` (a table of records: a property name outside the allowlist such as `--x` or `background`; values `inherit`, `url(x)`, `var(--y)`, `red`, `rgb(0 0 0)` (not hex), a radius of `9rem`, a focus width of `30px`, a keyword `default; color: red`; a record over 32 KiB; a record that is not an object; each leaves the built-in paint for the stored mode); `the allowlist in the script equals the supported tokens of the contracts module` (the test imports both); `a paint record whose stamp differs from the slots' paintStamp is not applied` (the state left by a write interrupted between the two keys; the script runs before any application module is imported).
3. [ ] Run both commands under Done when. Expected: FAIL, no inline property is set.
4. [ ] In `useTheme.ts`, resolve the active theme from the mode and the slots, set each override with `documentElement.style.setProperty("--" + token, value)`, remove the properties the previous theme set (keep the list in a module variable), re-apply on `subscribeThemes`, and return `resolvedThemeId`. Non-color tokens that Task 7.12 uses are set the same way.
5. [ ] In `theme-bootstrap.js`, read the paint record for the resolved mode, validate before applying anything: the record is an object of at most 32 KiB with `base`, `background` and `vars`; each property name is in a literal allowlist written into the script (the supported color, length and keyword tokens with a `--` prefix); a color value matches `/^#[0-9a-f]{6}([0-9a-f]{2})?$/i`; a length value matches `/^\d+(\.\d+)?(px|rem)$/` and lies within its token's range; a keyword value is exactly `none` or `default`. A record that fails any check is ignored as a whole. Use the record's background for the page and the theme-color meta. Keep it an external script with no inline code. Update the script version in `scripts/lib/theme-bootstrap.ts` the way that file prescribes.
6. [ ] Run both commands. Expected: PASS.
7. [ ] Prove the test can fail: skip removing the previous theme's properties, run `WEBTEST src/hooks/useTheme.test.ts`. Expected: FAIL in the Matrix Dark to Dark test. Restore and run again. Expected: PASS.
8. [ ] Run `vp test run scripts` and `vp run --filter @bibcode/web test`. Expected: PASS (tests that mock `useTheme` keep working because the three existing fields are unchanged).
9. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 7.7: New terminal sessions follow the theme when asked to

- Satisfies: R51 (Tokyo Night terminal; fixed preference and running sessions)
- Depends on: 7.6
- Files: modify `apps/web/src/components/terminalTheme.ts`; modify `apps/web/src/components/terminalTheme.test.ts`; modify `apps/web/src/components/ThreadTerminalPanel.tsx`; modify `apps/web/src/components/ChatView.tsx`
- Interfaces: consumes `resolveTerminalThemeMode(pref, appTheme)` (terminalTheme.ts line 40), `terminalAnsiColors(mode)` (112), `terminalExtendedAnsiPalette(mode)` (138), `terminalOscColorEnv(mode)` (158), `mergeTerminalSpawnEnv` (167), `TerminalLaunchThemeState` and `retainTerminalLaunchTheme` (which keep only a light or dark mode per session today, line 5), `useTheme().resolvedThemeId` (Task 7.6), `getTheme` (Task 7.5) and `toHex` (Task 7.13); produces `type TerminalPalette = { mode: "light" | "dark"; key: string; background: string; foreground: string; cursor: string; selectionBackground: string; selectionForeground: string; ansi: TerminalAnsiColors }` where `key` is a hash of every color in the palette (so a saved edit to a theme with the same id gives a new key), `resolveTerminalPalette(pref: TerminalThemePreferenceValue, theme: ThemeFile): TerminalPalette` (preference `app` uses the theme's terminal colors over its base's built-in palette; `dark` and `light` return the built-in palette), palette-taking overloads `terminalAnsiColors(palette)` and `terminalOscColorEnv(palette)`, and `TerminalLaunchThemeState` holding the full `TerminalPalette` a session was launched with.
- Skills: none
- Read first: `apps/web/src/components/terminalTheme.ts` lines 1-60 and 150-200 (why the terminal is decoupled from the app theme, and that a running session keeps its launch colors); `apps/web/src/components/ThreadTerminalPanel.tsx` lines 645-700 and 820-830; `apps/web/src/components/ChatView.tsx` lines 4655-4680 and 4855-4865 (the only lines this task changes in that file)
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/components/terminalTheme.test.ts` exits 0 with the 8 new tests passing

Steps

1. [ ] In `terminalTheme.test.ts`, add: `with preference app and Tokyo Night the ANSI green is #9ece6a and the OSC background is 26,27,38`; `Matrix Dark gives ANSI green #2d9a48 and OSC background 8,12,9`; `Matrix Light gives ANSI green #15803d and OSC background 255,255,255`; `Verdant Light gives ANSI green #26734d, ANSI red #b42318 and OSC foreground 48,56,64`; `with preference dark the built-in dark palette is used whatever the theme`; `a theme with no terminal colors uses its base's built-in palette`; `editing a theme's ANSI red changes the palette key although the id is the same`; `a running session keeps the full palette it was launched with after the theme changes`.
2. [ ] Run `WEBTEST src/components/terminalTheme.test.ts`. Expected: FAIL, `resolveTerminalPalette` does not exist.
3. [ ] Implement `resolveTerminalPalette`, the overloads and the palette-holding launch state. In `ThreadTerminalPanel.tsx`, build the terminal theme from the palette (cursor and selection colors come from it instead of the hard-coded values at lines 645-700) and pass the palette to the spawn environment. In `ChatView.tsx`, change only the four terminal call sites. Only new sessions read a new palette.
4. [ ] Run the same command. Expected: PASS.
5. [ ] Prove the test can fail: make preference `dark` use the theme's colors, run the same command. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Run `WEBTEST src/components/ThreadTerminalPanel.test.tsx src/components/ThreadTerminalPanel.test.ts`. Expected: PASS.
7. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 7.8: Appearance section, theme list and its actions

- Satisfies: R40 (dark theme in Light mode), R43 (navigation), R44 (duplicate a built-in; empty custom list), R45 (delete the active theme; cancel), R46 (name rules), R60 (restore)
- Depends on: 7.14
- Files: create `apps/web/src/routes/settings.appearance.tsx`; modify `apps/web/src/routeTree.gen.ts`; modify `apps/web/src/routes/settings.tsx`; create `apps/web/src/components/settings/AppearanceSettingsPanel.tsx`; create `apps/web/src/components/settings/AppearanceSettingsPanel.test.tsx`; modify `apps/web/src/components/settings/SettingsPanels.tsx`; modify `apps/web/src/components/settings/SettingsPanels.test.tsx`; modify `apps/web/src/components/settings/SettingsSidebarNav.tsx`; modify `apps/web/src/components/settings/SettingsSidebarNav.test.tsx`
- Interfaces: consumes `useThemeLibrary`, `setSlot`, `duplicateTheme`, `deleteCustomTheme`, `saveCustomTheme`, `resetSlots` (Task 7.5), `useTheme` (Task 7.6), `SettingsSectionPath` and `BASE_SETTINGS_NAV_ITEMS` (SettingsSidebarNav.tsx lines 36-70), `GeneralSettingsPanel` (SettingsPanels.tsx line 535, Theme row 543-575, `THEME_OPTIONS` 116), `useGeneralSettingsRestore` (426-533) and the `SettingsSection`, `SettingsRow` and `Select` components; produces the route `/settings/appearance`, the nav item "Appearance" placed directly after "General", `AppearanceSettingsPanel` (exported from its own file) with an `onEdit(themeId: string)` state that Task 7.9 fills with the editor, and `useGeneralSettingsRestore` also calling `resetSlots()`.
- Skills: better-accessibility (list rows, the delete confirmation and focus return)
- Read first: the design note section "Selection model"; `apps/web/src/routes/settings.general.tsx` (the route file pattern) and `apps/web/src/routes/settings.tsx` lines 30-110 (where the restore button is shown); `UI.md` (Dropdowns and Lists, Customization, Errors)
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/components/settings` exits 0 with the 12 new tests passing

Steps

1. [ ] In `SettingsSidebarNav.test.tsx`, add `Appearance is listed after General`. In `SettingsPanels.test.tsx`, add `General no longer has a theme control` and `restore defaults sets the mode to System and both slots to the built-ins and keeps custom themes`, and `Restore is offered in System mode when only a non-default built-in is selected`.
2. [ ] In `AppearanceSettingsPanel.test.tsx`, add: `the mode select offers System, Light and Dark`; `the six built-ins are listed in order, then custom themes, each with its base and a preview`; `a built-in row offers Duplicate only, a custom row offers Edit, Duplicate, Export and Delete`; `Use for dark puts the theme in the dark slot and marks the row`; `picking a dark theme in Light mode keeps the mode and offers "Switch to dark now", which sets the mode to Dark`; `Duplicate on Tokyo Night adds "Tokyo Night copy"`; `Delete asks for confirmation, cancel changes nothing, confirm removes the theme and the slot falls back to Dark`; `New theme asks for a base and a name, rejects an empty name and a name over 48 characters with the rule that failed, and opens the editor`; `with no custom themes the six built-ins and the New theme action are shown`.
3. [ ] Run `WEBTEST src/components/settings`. Expected: FAIL, `AppearanceSettingsPanel` does not exist.
4. [ ] Create the route file and regenerate the route tree with the repository's generator (the web build step that writes `routeTree.gen.ts`; never edit it by hand). Expected: `routeTree.gen.ts` contains `/settings/appearance`. Add the nav item and extend `SettingsSectionPath`. Move the mode row from `GeneralSettingsPanel` into `AppearanceSettingsPanel`, show the restore button on `/settings/appearance` as well, and extend `useGeneralSettingsRestore` (the "Theme" label is reported when the mode is not System, or the light slot is not exactly `light`, or the dark slot is not exactly `dark`; so System mode with Tokyo Night selected still enables Restore).
5. [ ] Implement the list: each row shows a five-swatch preview (background, card, primary, foreground and border from `resolveToken` of Task 7.13, which covers every supported token), the name, the subtitle or "Custom", the base, a "Use for light" or "Use for dark" button matching the theme's base, and a row menu with the allowed actions. Export is a stub prop that Task 7.10 fills; Edit calls `onEdit`.
6. [ ] Run `WEBTEST src/components/settings`. Expected: PASS.
7. [ ] Prove the test can fail: make Delete skip the confirmation, run `WEBTEST src/components/settings/AppearanceSettingsPanel.test.tsx`. Expected: FAIL. Restore and run again. Expected: PASS.
8. [ ] Review the panel against `vercel-react-best-practices` and `UI.md`, and record the results for the final report.
9. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 7.9: Theme editor with live preview, terminal colors and contrast warnings

- Satisfies: R47 (edit and cancel; reset one token; invalid text), R52 (custom ANSI red), R54 (unreadable pair)
- Depends on: 7.8
- Files: create `apps/web/src/components/settings/ThemeEditor.tsx`; create `apps/web/src/components/settings/ThemeColorField.tsx`; create `apps/web/src/components/settings/ThemeEditor.test.tsx`; modify `apps/web/src/components/settings/AppearanceSettingsPanel.tsx`; modify `apps/web/src/hooks/useTheme.ts`
- Interfaces: consumes `saveCustomTheme`, `getTheme` (Task 7.5), `isSafeCssColor`, `validateThemeFile` (Task 7.2), `FIXED_PAIRS`, `contrastRatio`, `resolveToken` (Task 7.13), `UI_COLOR_TOKENS`, `UI_LENGTH_TOKENS`, `UI_KEYWORD_TOKENS`, `TERMINAL_TOKENS` and the `onEdit` state of `AppearanceSettingsPanel` (Task 7.8); produces in `useTheme.ts` `setThemePreview(theme: ThemeFile | null): void` (applies an unsaved theme over the active one in this window only, `null` restores the stored theme; both notify `subscribeAppliedTheme`), `ThemeColorField` with props `{ label: string; value: string | undefined; baseValue: string; onChange(value: string | undefined): void; error?: string }` (a native color input, a text field and a Reset button), and `ThemeEditor` with props `{ themeId: string; onClose(): void }`.
- Skills: better-accessibility (labelled fields, error text tied to its field, warnings not by color alone)
- Read first: the design note sections "Token list" (the editor group of each token) and "Contrast"; `apps/web/src/components/settings/ProviderAccentColorPicker.tsx` (layout to match; it is hex-only and is not reused)
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/components/settings/ThemeEditor.test.tsx src/hooks/useTheme.test.ts` exits 0 with the 12 new tests passing

Steps

1. [ ] In `ThemeEditor.test.tsx`, add: `tokens are grouped as Surfaces, Text, Accent and focus, Status, Sidebar and Terminal and every supported token appears once`; `changing primary repaints at once and Cancel restores the saved color` (during the edit `--primary` is `#ff0000`; after Cancel it is `#3b82f6` and the stored theme is unchanged); `Save stores the theme and closes`; `Reset on one token returns it to the base value and keeps the others`; `Reset all clears every override after a confirmation`; `typing url(x) shows an error on that field, does not repaint and disables Save`; `text equal to background shows 1:1 with a warning that names both tokens and Save still works`; `the Terminal group sets ANSI red and the saved theme carries terminal.red`; `the keyword tokens have labelled controls` (a "Sidebar card shadow" switch that stores `none` or leaves the token unset, and a "Control shadows" select with Default and None); `the length tokens state their range and reject a value outside it`; `saving in another window while the editor is open does not overwrite the draft, and Cancel then shows the newly stored theme`.
2. [ ] In `useTheme.test.ts`, add `a preview applies over the active theme and null restores the stored theme`.
3. [ ] Run the command under Done when. Expected: FAIL, `ThemeEditor` does not exist.
4. [ ] Implement `setThemePreview`, `ThemeColorField` and `ThemeEditor`. The editor keeps a draft `ThemeFile`, calls `setThemePreview(draft)` on each valid change, shows the fixed pairs with their ratios to two decimals and a "Low contrast" warning with a warning icon for each pair under 4.5, and calls `setThemePreview(null)` on Cancel, on Save and on unmount. Radius is a length field with the 0 to 1rem range stated under it. Mount the editor from `AppearanceSettingsPanel`.
5. [ ] Run the same command. Expected: PASS.
6. [ ] Prove the test can fail: skip `setThemePreview(null)` on Cancel, run `WEBTEST src/components/settings/ThemeEditor.test.tsx`. Expected: FAIL. Restore and run again. Expected: PASS.
7. [ ] Review the editor against `vercel-react-best-practices` and `UI.md`, and record the results for the final report.
8. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 7.10: Export and import

- Satisfies: R53 (round trip; ID already exists; invalid file), R55 (low-contrast import)
- Depends on: 7.9
- Files: create `apps/web/src/themes/themeTransfer.ts`; create `apps/web/src/themes/themeTransfer.test.ts`; create `apps/web/src/components/settings/ThemeImportDialog.tsx`; create `apps/web/src/components/settings/ThemeImportDialog.test.tsx`; modify `apps/web/src/components/settings/AppearanceSettingsPanel.tsx`
- Interfaces: consumes `validateThemeFile`, `MAX_THEME_FILE_BYTES` (Task 7.2), `failingPairs` and `FIXED_PAIRS` (Task 7.13), `saveCustomTheme`, `getTheme` and `duplicateTheme`'s id rule (Task 7.5), and the Export stub of Task 7.8; produces `exportThemeJson(theme: ThemeFile): string` (stable key order, two-space indent, trailing newline), `type ImportPlan = { ok: true; theme: ThemeFile; resetPairs: FixedPair[]; conflict: boolean } (`FixedPair` is exported by Task 7.13) | { ok: false; errors: ThemeFieldError[] }`, `planThemeImport(text: string): ImportPlan` (parses, validates, then for each fixed pair under 4.5 removes the text token's override and, if the pair still fails, the surface token's override, repeating until no fixed pair with an override fails), `commitThemeImport(plan, choice: "replace" | "keep-both"): ThemeFile`, and `ThemeImportDialog` with props `{ open: boolean; onOpenChange(open: boolean): void }`.
- Skills: none
- Read first: the design note sections "Validation and security" and "Contrast"; `UI.md` (Errors; Forms)
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/themes/themeTransfer.test.ts src/components/settings/ThemeImportDialog.test.tsx` exits 0 with at least 10 tests passing

Steps

1. [ ] In `themeTransfer.test.ts`, add: `export then import gives an equal theme`; `invalid JSON gives one error on the file field`; `two invalid colors give two field errors and no theme`; `a file over 16 KiB is rejected by size`; `a built-in id is rejected as reserved`; `an existing custom id sets conflict and replace overwrites while keep-both stores a second theme with a new id`; `a muted text of 2.1:1 on background is reset, the pair is listed, other overrides are kept, and exporting and importing the result changes nothing more`; `a pair that still fails after the text reset also loses its surface override`.
2. [ ] In `ThemeImportDialog.test.tsx`, add: `pasted JSON with errors lists each field and its message and stores nothing`; `a valid file with a conflict asks Replace or Keep both before storing`; `after import a notice names the pairs that were reset to base values`.
3. [ ] Run the command under Done when. Expected: FAIL, the modules do not exist.
4. [ ] Implement `themeTransfer.ts` and `ThemeImportDialog` (a file input accepting `.json` and a paste area, a Validate step, then Import). Wire Export in `AppearanceSettingsPanel` to download `<id>.theme.json` through a Blob link, and add an "Import theme" action that opens the dialog.
5. [ ] Run the same command. Expected: PASS, at least 10 tests.
6. [ ] Prove the test can fail: store the theme in `planThemeImport` instead of `commitThemeImport`, run `WEBTEST src/themes/themeTransfer.test.ts`. Expected: FAIL in the conflict test. Restore and run again. Expected: PASS.
7. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 7.11: Scrollbars, sidebar text, diagrams and annotation colors follow the theme

- Satisfies: R57 (scrollbar under a custom theme), R58 (primary changes)
- Depends on: 7.10
- Files: modify `apps/web/src/index.css`; modify `apps/web/src/themes/tokens.test.ts`; modify `apps/web/src/themeTokens.test.ts`; modify `apps/web/src/hooks/useTheme.ts`; modify `apps/web/src/hooks/useTheme.test.ts`; modify `apps/web/src/browser/annotationTheme.ts`; modify `apps/web/src/browser/annotationTheme.test.ts`
- Interfaces: consumes `subscribeAppliedTheme` and the property application of Task 7.6, `readPreviewAnnotationTheme()` (annotationTheme.ts, 17 variables read from computed style), the existing scrollbar recipe at `index.css` lines 719 and 737 (`color-mix` of `--border`), and the diagram variables at lines 814-832 (`--pele-*`, which reference `--background`, `--foreground` and `--info`, not `--primary`); produces CSS variables `--scrollbar-thumb` and `--scrollbar-thumb-hover` (defaults equal to today's literal values in each block) and `--sidebar-card-muted-foreground` (light default `var(--muted-foreground)`, dark default `var(--color-neutral-400)`), none of which is a themable token, and `watchAnnotationTheme(push: (theme: DesktopPreviewAnnotationTheme) => void): () => void` (the existing type of annotationTheme.ts line 1), built on `subscribeAppliedTheme` (Task 7.6), which pushes once and again after every effective theme application. Both preview bridges implement `setAnnotationTheme` as a no-op today (`apps/web/src/tauriPreviewBridge.ts` line 261, `apps/web/src/browser/framePreviewBridge.ts` line 307); wiring them is outside this plan (spec amendment A1 in `plan.md`).
- Skills: none
- Read first: `apps/web/src/index.css` lines 350-356, 465-480, 715-740, 814-832 and 1046-1065; `apps/web/src/themeTokens.test.ts` (how computed property values are read in tests)
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/themes/tokens.test.ts src/themeTokens.test.ts src/browser/annotationTheme.test.ts src/hooks/useTheme.test.ts` exits 0 with the 8 new tests passing

Steps

1. [ ] In `tokens.test.ts`, add: `scrollbar thumbs use the scrollbar tokens and no literal rgba remains in the scrollbar and model-picker rules`; `the scrollbar token defaults equal the previous literal values in the light and the dark block`; `the sidebar card rule sets muted-foreground from the sidebar-card token and the dark default is neutral-400`.
2. [ ] In `useTheme.test.ts`, add `a custom dark theme that sets muted and border derives the scrollbar thumb from its border and the sidebar card text from its muted-foreground, and Dark keeps today's values`.
3. [ ] In `themeTokens.test.ts`, add `a rendered diagram container follows a change of info, background and foreground` (set the three variables on the root, read the computed `--pele-*` values under `.chat-markdown-mermaid`, and assert each changed) and `a change of primary alone does not change the diagram colors` (documenting that diagrams do not use primary).
4. [ ] In `annotationTheme.test.ts`, add `the annotation reader returns the new primary after a theme change`, `watchAnnotationTheme pushes once and again after a slot change, a mode change, a preview and a Cancel` and `the returned function stops further pushes`.
5. [ ] Run the command under Done when. Expected: FAIL, the scrollbar rules still contain literal `rgba(`.
6. [ ] Declare the three variables with defaults that reproduce today's values and replace the literals in the scrollbar, model-picker and sidebar-card rules. In `applyTheme`, when the active theme is not built-in Light or Dark, also set `--scrollbar-thumb` to `color-mix(in srgb, var(--border) 80%, transparent)`, `--scrollbar-thumb-hover` to `var(--border)` and `--sidebar-card-muted-foreground` to `var(--muted-foreground)`, and clear them with the other overrides. Implement `watchAnnotationTheme` on `subscribeAppliedTheme`. Do not change either preview bridge.
7. [ ] Run the same command. Expected: PASS.
8. [ ] Prove the test can fail: restore one literal `rgba(` in the model-picker rule, run `WEBTEST src/themes/tokens.test.ts`. Expected: FAIL. Restore the token and run again. Expected: PASS.
9. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 7.12: Focus ring and control shadow tokens

- Satisfies: R59 (Verdant Light; defaults)
- Depends on: 7.11
- Files: modify `apps/web/src/index.css`; modify `apps/web/src/themes/tokens.test.ts`; modify `apps/web/src/themeTokens.test.ts`; modify `apps/web/src/hooks/useTheme.ts`; modify `apps/web/src/hooks/useTheme.test.ts`; modify `apps/web/src/themes/builtin/verdant-light.json`; modify `apps/web/src/themes/builtinThemes.test.ts`; modify `apps/web/src/components/ui/input.tsx`; modify `apps/web/src/components/ui/button.tsx`; modify `apps/web/src/components/chat/ComposerPrimaryActions.tsx`
- Interfaces: consumes `UI_LENGTH_TOKENS` and `UI_KEYWORD_TOKENS` (Task 7.2), the property application of Task 7.6, the input wrapper that draws its ring with `has-focus-visible` (`ui/input.tsx` line 61), the button's shadow utilities and pseudo-element shadow (`ui/button.tsx` lines 35 and 44) and the Send button, a native `button` without `data-slot` (`ComposerPrimaryActions.tsx` line 305); produces the root attributes `data-theme-focus-ring` (present only when the active theme sets `focus-ring-width` or `focus-ring-offset`) and `data-theme-control-shadow="none"` (present only when the theme sets `control-shadow: none`), the variables `--focus-ring-width` and `--focus-ring-offset`, the marker attributes `data-focus-ring-owner` on the input wrapper and `data-control-shadow` on the button root and the Send button, a rule for the composer's own surface `.chat-composer-glass` (index.css lines 175 and 191, which carries the composer's visible shadow and is applied in `ChatComposer.tsx`, a file this task does not change), and CSS rules scoped to the root attributes that restyle exactly those owners and their `::before` and `::after` shadows.
- Skills: better-accessibility (a focus indicator must stay visible on every control after the change)
- Read first: the design note section "Focus ring and control shadow"; `apps/web/src/index.css` lines 340-350 (the one existing 2px outline with a 2px offset)
- Tier: standard
- TDD: red-green
- Done when: `WEBTEST src/themes/tokens.test.ts src/themeTokens.test.ts src/hooks/useTheme.test.ts src/themes/builtinThemes.test.ts src/components/ui` exits 0 with the 8 new tests passing

Steps

1. [ ] Add tests: in `useTheme.test.ts`, `Verdant Light sets the focus ring attribute, --focus-ring-width 2px and --focus-ring-offset 2px, and the control-shadow attribute` and `Light and Dark set neither attribute`; in `builtinThemes.test.ts`, `Verdant Light sets focus-ring-width 2px, focus-ring-offset 2px and control-shadow none`; in the UI component tests, `the input wrapper, the button and the Send button carry their marker attributes`.
2. [ ] In `themeTokens.test.ts` (computed styles), add: `under Verdant Light a focused button has a 2px outline with a 2px offset and no ring shadow`; `under Verdant Light a focused input shows the 2px outline on its wrapper and no 3px ring`; `under Verdant Light the button, its pseudo-elements, the Send button and the composer surface (.chat-composer-glass) have no box shadow`; `under Light and Dark the focus ring and shadows equal the values recorded before the change`.
3. [ ] Run the command under Done when. Expected: FAIL, the attributes are not set.
4. [ ] Add the marker attributes to the three components (no class changes). In `index.css`, add rules under `:root[data-theme-focus-ring]` for `:focus-visible` and for `[data-focus-ring-owner]:has(:focus-visible)` that draw `outline: var(--focus-ring-width, 2px) solid var(--ring)` with `outline-offset: var(--focus-ring-offset, 2px)` and clear the ring shadow variables, and rules under `:root[data-theme-control-shadow="none"]` that set `box-shadow: none` on `[data-control-shadow]` and its `::before` and `::after`, and on `.chat-composer-glass`. Set and clear the two root attributes in `applyTheme`. Add the three values to `verdant-light.json`.
5. [ ] Run the same command. Expected: PASS.
6. [ ] Prove the test can fail: set the focus attribute for every theme, run `WEBTEST src/hooks/useTheme.test.ts`. Expected: FAIL in `Light and Dark set neither attribute`. Restore and run again. Expected: PASS.
7. [ ] Run `vp run --filter @bibcode/web test` and `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: PASS and no errors.
8. [ ] Review every component this phase changed against `vercel-react-best-practices` and `UI.md`, and record the results for the final report.

### Task 7.13: One color parser and one token resolver

- Satisfies: support (unblocks 7.4, 7.5, 7.8, 7.9 and 7.10; the contrast rules of R54 to R56 and the derived-token rule of R36 need one shared resolution)
- Depends on: 7.3
- Files: create `apps/web/src/themes/themeColor.ts`; create `apps/web/src/themes/themeColor.test.ts`; create `apps/web/src/themes/baseTokenValues.ts`; create `apps/web/src/themes/baseTokenValues.test.ts`
- Interfaces: consumes `ThemeFile`, `UI_COLOR_TOKENS` and `TERMINAL_TOKENS` (Task 7.2) and the fallback recipes of Task 7.3; produces in `themeColor.ts`: `type Rgba = { r: number; g: number; b: number; a: number }`, `parseColor(value: string): Rgba | null` (hex, `rgb()`, `hsl()`, `oklch()`), `toHex(value: string): string` (`#rrggbb`, or `#rrggbbaa` when not opaque), `mix(a: Rgba, b: Rgba, percentOfA: number): Rgba`, `contrastRatio(text: string, surface: string, behind?: string): number` (a color with alpha is composited over its surface first), `export type FixedPair = { text: string; surface: string; label: string }`, `FIXED_PAIRS: readonly FixedPair[]` exactly as the spec defines them (terminal tokens are written `terminal.<name>`, UI tokens bare, so the two namespaces cannot collide), `resolveToken(theme: ThemeFile, token: string): string` and `failingPairs(theme: ThemeFile, minimum: number): { pair: FixedPair; ratio: number }[]`; and in `baseTokenValues.ts`: `BASE_TOKEN_VALUES: Record<"light" | "dark", Record<string, string>>` with the resolved hex value of every supported color token and every terminal color of the two base themes, and `DERIVED_DEFAULTS: Record<"light" | "dark", Record<string, (resolve: (token: string) => string) => string>>` giving the formula of every token that either base block of `index.css` defines in terms of another token. The inventory is taken from the file, not from memory: step 1 lists every declaration in lines 243-335 whose value contains `var(--` or a `color-mix`/`--alpha` of a token (it includes at least dark `card`, `popover`, `sidebar-card`, `sidebar-well`, `sidebar-env-band` and the dark find-match tokens, `panel-separator`, `app-chrome-background`, and the six new tokens of Task 7.3). A formula keeps its alpha: a value such as primary at 90 percent stays a color with alpha (`#rrggbbaa`), and only `contrastRatio` composites it over the surface it is measured on. `resolveToken` returns the theme's value, else the derived formula evaluated against the theme's resolved tokens, else the base value, so an unset `primary-hover` follows an overridden `primary`.
- Skills: none
- Read first: the design note sections "Token list" and "Contrast"; `apps/web/src/index.css` lines 243-335 (every base declaration, including the ones written as `color-mix` or `--alpha(...)`); `apps/web/src/themeTokens.test.ts`
- Tier: most capable
- TDD: red-green
- Done when: `WEBTEST src/themes/themeColor.test.ts src/themes/baseTokenValues.test.ts` exits 0 with at least 13 tests passing

Steps

1. [ ] List, in the task's log line, every declaration in `index.css` lines 243-335 whose value depends on another token, for both blocks. In `themeColor.test.ts`, add: `for every derived token, overriding the token it depends on changes resolveToken the same way it changes the painted value` (table-driven over that list, comparing `resolveToken` with the computed CSS value read as in `themeTokens.test.ts`); `parseColor reads hex, rgb(), hsl() and oklch() and returns null for a named color`; `toHex round-trips`; `contrastRatio matches known values` (black on white is 21, `#a9b1d6` on `#1a1b26` is 8.10 within 0.01, `#087f5b` on `#ffffff` is 5.00 within 0.01); `a color with alpha is composited over its surface before the ratio is computed`; `resolveToken returns an override first`; `an unset primary-hover follows an overridden primary`; `an unset placeholder follows an overridden muted-foreground`; `an unset panel-separator follows an overridden ring`; `failingPairs lists a pair below the minimum and resolves unset tokens`; `FIXED_PAIRS has the fourteen pairs of the spec in order`.
2. [ ] In `baseTokenValues.test.ts`, add `every supported color token and terminal color has a light and a dark base value` and `each base value equals the computed value of its CSS variable` (read with the method of `themeTokens.test.ts`, with and without the `dark` class).
3. [ ] Run the command under Done when. Expected: FAIL, the modules do not exist.
4. [ ] Implement both modules. WCAG relative luminance for the ratio; OKLCH converted through OKLab to sRGB.
5. [ ] Run the same command. Expected: PASS, at least 12 tests.
6. [ ] Prove the test can fail: make `resolveToken` skip `DERIVED_DEFAULTS`, run `WEBTEST src/themes/themeColor.test.ts`. Expected: FAIL in the three "follows" tests. Restore and run again. Expected: PASS.
7. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.

### Task 7.14: The pipeline job log follows the terminal palette

- Satisfies: R51 (job log)
- Depends on: 7.7
- Files: modify `apps/web/src/components/pipelines/log/jobLogStyle.ts`; modify `apps/web/src/components/pipelines/log/jobLogStyle.test.ts`; modify `apps/web/src/components/pipelines/log/JobLog.tsx`; create `apps/web/src/components/pipelines/log/JobLog.theme.test.tsx`
- Interfaces: consumes `TerminalPalette` and `resolveTerminalPalette` (Task 7.7), `logPalette(mode)` (jobLogStyle.ts line 29, which caches per mode in a module `Map` and returns at once for a known key) and its caller `JobLog.tsx` line 471; produces `logPalette(palette: TerminalPalette)` cached by `palette.key`.
- Skills: none
- Read first: `apps/web/src/components/pipelines/log/jobLogStyle.ts`
- Tier: cheap
- TDD: red-green
- Done when: `WEBTEST src/components/pipelines/log` exits 0 with the 4 new tests passing

Steps

1. [ ] In `jobLogStyle.test.ts`, add: `with Follow app theme and Matrix Dark the log's ANSI green is #2d9a48`; `the log palette is cached per palette key`; `a second palette with a different key is not served from the cache`. In `JobLog.theme.test.tsx`, add `a mounted job log repaints after a saved edit to a theme with the same id`: mount `JobLog` with a line of ANSI red, save the active custom theme through the real store with a new ANSI red, and assert the rendered style changed without remounting (the component reads `themeRevision` from `useTheme()`, Task 7.6).
2. [ ] Run `WEBTEST src/components/pipelines/log/jobLogStyle.test.ts`. Expected: FAIL, `logPalette` does not accept a palette.
3. [ ] Implement the overload and pass the palette from `JobLog.tsx`.
4. [ ] Run the same command. Expected: PASS.
5. [ ] Prove the test can fail: key the cache by `palette.mode`, run the same command. Expected: FAIL in the same-id test. Restore and run again. Expected: PASS.
6. [ ] Run `vp check` and the web-only typecheck `pnpm --filter @bibcode/web exec tsc --noEmit`. Expected: no errors.
