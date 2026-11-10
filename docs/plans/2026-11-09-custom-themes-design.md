# Custom color themes

Status: Approved 2026-11-09 (pre-approved: reviewed by Codex and the advisor)

Issue #290. Spec: [spec.md](./2026-11-09-issue-batch-340-345-290/spec.md) section G (R36 to
R61, decisions D9 and D17 to D20). Built-in values:
[theme-palettes.md](./2026-11-09-issue-batch-340-345-290/theme-palettes.md). Plan:
[Phase 7](./2026-11-09-issue-batch-340-345-290/phases/PHASE-07-custom-themes.md), decisions P6,
P7, P13, P16, P17, P18 and P22. Line references are to `apps/web/src/index.css` at the base of
the batch branch.

## Problem and scope

The app has a mode (System, Light, Dark) stored in `bibcode:theme` and two palettes written into
`index.css`. A person cannot change the accent, raise contrast or match the terminal palette they
use elsewhere.

This change adds:

- a theme format (a base plus optional overrides) shared by built-in and custom themes;
- six built-in themes (Light, Dark, Tokyo Night, Matrix Dark, Matrix Light, Verdant Light);
- a light slot and a dark slot that the mode chooses between;
- an Appearance section in Settings with the mode, the theme list, an editor with live preview,
  import and export;
- theme-aware terminal colors for new sessions when the terminal follows the app theme;
- six new color tokens and five non-color tokens (D17).

Out of scope: custom syntax colors, importing themes from other apps, server-side sync, a theme
CLI, the sidebar-hierarchy extension, and drawing annotations in the browser preview with theme
colors (both preview bridges ignore the annotation theme, spec amendment A1).

## Alternatives

| Option                                                      | Outcome       | Reason                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A base plus overrides on the existing CSS variables         | Chosen        | One schema for built-in and custom themes. An unset token keeps its base definition, including derived ones (R36, D20). It matches the issue's prior art (Orca and Zed). |
| A full palette per theme                                    | Rejected      | Every theme would copy about 40 values and drift from the base when the base changes. Derived tokens such as `panel-separator` would stop following `ring`.              |
| Server-side storage in `settings.json`                      | Rejected (D9) | The pre-paint step cannot wait for a server round trip, so the first frame would flash the base colors. Export and import move themes between devices.                   |
| Exposing every CSS variable                                 | Rejected (D9) | A larger contract to keep stable. The format covers the supported tokens only (D20).                                                                                     |
| Blocking Save on low contrast                               | Rejected (D9) | It stops deliberate choices. The editor warns, and import resets failing pairs (R54, R55).                                                                               |
| Switching the mode when a theme of the other base is picked | Rejected (D9) | Surprising. The slot is filled and a switch is offered (R40).                                                                                                            |

## Theme file format

`packages/contracts/src/theme.ts` holds schemas only (no runtime logic, per the contracts package
rule).

```ts
ThemeFile = {
  version: 1;                 // THEME_FILE_VERSION
  id: ThemeId;                // 1 to 48 characters of [a-z0-9-]
  name: string;               // 1 to 48 characters
  base: "light" | "dark";     // ThemeBase
  ui?: Partial<Record<UiToken, string>>;
  terminal?: Partial<Record<TerminalToken, string>>;
}
```

- `UiToken` is the union of `UI_COLOR_TOKENS`, `UI_LENGTH_TOKENS` and `UI_KEYWORD_TOKENS`.
- Unknown keys are rejected at every level (top level, `ui`, `terminal`), and the error names the
  key (R36).
- `RESERVED_THEME_IDS` is `system`, `light`, `dark`, `tokyo-night`, `matrix-dark`,
  `matrix-light` and `verdant-light`. Only the built-in files decode with
  `allowReservedId: true`.
- The schema checks shape. `apps/web/src/themes/themeValidation.ts` checks values
  (`isSafeCssColor`, ranges, keywords, size, reserved ids) and returns one error per field, named
  `ui.<token>`, `terminal.<token>`, `id`, `name` or `file`.
- A theme name may repeat another theme's name. Ids are unique.

## Token list

### Color tokens (`UI_COLOR_TOKENS`)

Each token's editor group is fixed here. The editor shows every token exactly once (R47, D20).

| Group            | Tokens                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces         | `background`, `app-chrome-background`, `card`, `popover`, `secondary`, `muted`, `accent`, `selected`, `border`, `input`, `panel-separator`                                                                                       |
| Text             | `foreground`, `foreground-strong`, `card-foreground`, `popover-foreground`, `secondary-foreground`, `muted-foreground`, `accent-foreground`, `selected-foreground`, `placeholder`, `link`                                        |
| Accent and focus | `primary`, `primary-foreground`, `primary-hover`, `primary-active`, `ring`                                                                                                                                                       |
| Status           | `destructive`, `destructive-foreground`, `info`, `info-foreground`, `success`, `success-foreground`, `warning`, `warning-foreground`, `find-match`, `find-match-foreground`, `find-match-active`, `find-match-active-foreground` |
| Sidebar          | `sidebar-well`, `sidebar-card`, `sidebar-card-border`, `sidebar-env-band`                                                                                                                                                        |
| Terminal         | the `TERMINAL_TOKENS` below                                                                                                                                                                                                      |

That is 42 color tokens: the 36 the base stylesheet defines (spec, Supported tokens) and the six
of D17.

### The six new color tokens (D17, R50)

Each is mapped in `@theme inline` with its default as a `var()` fallback (plan decision P13). The
variables themselves are not declared in the light or dark block, so only a theme sets them, and
a default follows a base token that a subtree overrides (`.dark [data-sidebar-card]` overrides
`--muted-foreground`, line 354).

| Token                 | Mapping and default recipe                                                                              | Today's look it reproduces                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `foreground-strong`   | `--color-foreground-strong: var(--foreground-strong, var(--foreground))`                                | headings use `--foreground`                                                                  |
| `placeholder`         | `--color-placeholder: var(--placeholder, color-mix(in srgb, var(--muted-foreground) 72%, transparent))` | `placeholder:text-muted-foreground/72` in `input.tsx` and `select.tsx`                       |
| `primary-hover`       | `--color-primary-hover: var(--primary-hover, color-mix(in srgb, var(--primary) 90%, transparent))`      | `hover:bg-primary/90` on the default button and badge                                        |
| `primary-active`      | `--color-primary-active: var(--primary-active, color-mix(in srgb, var(--primary) 90%, transparent))`    | a pointer press (hover plus active) and `[data-pressed]` are `bg-primary/90` today           |
| `selected`            | `--color-selected: var(--selected, var(--accent))`                                                      | selected rows use `bg-accent`                                                                |
| `selected-foreground` | `--color-selected-foreground: var(--selected-foreground, var(--accent-foreground))`                     | selected rows use `text-accent-foreground` or `text-foreground` (equal values in both bases) |

The default button and badge use `hover:bg-primary-hover data-pressed:bg-primary-active
active:hover:bg-primary-active`. Today `[:hover,[data-pressed]]:bg-primary/90` leaves a keyboard
press without hover at full primary, so a bare `active:` class would change Light and Dark. With
`active:hover:` a pointer press shows the pressed color and a keyboard press keeps today's color
(review finding C7).

Utilities: `text-foreground-strong`, `placeholder:text-placeholder`, `bg-primary-hover`,
`bg-primary-active`, `bg-selected`, `text-selected-foreground`. The Send button in
`ComposerPrimaryActions.tsx` rests at 90 percent primary and hovers at full primary, a different
pattern, and keeps its classes.

Selected rows, tabs and options switch from `bg-accent` to `bg-selected`, keeping any alpha
suffix, and from `text-accent-foreground` to `text-selected-foreground` where the row sets it.
The defaults make both identical to today. The files are `ui/combobox.tsx`, the selected rows
and tabs in the diff file list, the Git Manager history and stash lists, the pull request file
list, the worktree dialog's branch list, the center and right panel tabs, the agents row, the
Git Manager change row, the Source Control change list, the environment rail, the terminal
panel's tab list and the job log (the coordinator widened the owned files for this). The
pipeline stage column (`components/pipelines/detail/PipelineStageColumns.tsx`) belongs to
Phase 1 and is switched by Task 8.4.

### Derived base tokens

`resolveToken` reproduces every base declaration that depends on another token, so contrast,
previews and the paint record agree with the painted page. The inventory comes from
`index.css` lines 243 to 331.

| Token                             | Light                                  | Dark                                                       |
| --------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `app-chrome-background`           | `background`                           | `background`                                               |
| `card`, `popover`                 | literal                                | `background` 98 percent with white                         |
| `panel-separator`                 | `ring` at 25 percent alpha             | inherited from the light block, `ring` at 25 percent alpha |
| `sidebar-well`                    | black 4.5 percent over `background`    | black 55 percent over `background`                         |
| `sidebar-card`                    | `background`                           | white 4 percent over `background`                          |
| `sidebar-env-band`                | black 2.5 percent over `background`    | white 7 percent over `background`                          |
| `find-match`                      | literal                                | amber-400 35 percent over `background`                     |
| `foreground-strong`               | `foreground`                           | `foreground`                                               |
| `placeholder`                     | `muted-foreground` at 72 percent alpha | same                                                       |
| `primary-hover`, `primary-active` | `primary` at 90 percent alpha          | same                                                       |
| `selected`, `selected-foreground` | `accent`, `accent-foreground`          | same                                                       |

A formula keeps its alpha (`#rrggbbaa`). Only `contrastRatio` composites a translucent color over
the surface it is measured on.

### Non-color tokens

| Token                 | Kind    | Allowed values                                          | Applied as                                                           |
| --------------------- | ------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| `radius`              | length  | `0rem` to `1rem` (`px` or `rem` required, 16px per rem) | `--radius`                                                           |
| `focus-ring-width`    | length  | `1px` to `3px`                                          | `--focus-ring-width` and the `data-theme-focus-ring` root attribute  |
| `focus-ring-offset`   | length  | `0px` to `3px`                                          | `--focus-ring-offset` and the `data-theme-focus-ring` root attribute |
| `sidebar-card-shadow` | keyword | `none`                                                  | `--sidebar-card-shadow: none`                                        |
| `control-shadow`      | keyword | `none`, `default`                                       | `data-theme-control-shadow="none"` when `none`                       |

The editor shows `radius`, `focus-ring-width` and `focus-ring-offset` as length fields that state
their range, `sidebar-card-shadow` as a "Sidebar card shadow" switch (off stores `none`, on clears
the token), and `control-shadow` as a "Control shadows" select (Default, None). They sit in the
Surfaces group (radius, control shadows), the Accent and focus group (focus ring) and the Sidebar
group (sidebar card shadow).

### Terminal tokens (`TERMINAL_TOKENS`)

`background`, `foreground`, `cursor`, `selection-background`, `selection-foreground`, and the 16
ANSI names `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`,
`bright-black`, `bright-red`, `bright-green`, `bright-yellow`, `bright-blue`, `bright-magenta`,
`bright-cyan` and `bright-white`. The file uses kebab case like the UI tokens. `terminalTheme.ts`
maps them onto its camel-case ANSI keys. The fixed pair names terminal tokens as
`terminal.<name>` so the two namespaces cannot collide.

## Where `foreground-strong` is used

- Markdown headings `h1` to `h5` (`.chat-markdown h1` and the rule beside it) take
  `var(--foreground-strong, var(--foreground))`, written out because `@theme inline` does not
  emit `--color-*` variables for plain CSS to read. `h6` keeps `--muted-foreground`.
- Settings section titles (`SettingsSection` in `settingsLayout.tsx`) take
  `text-foreground-strong/50`, which equals today's `text-foreground/50` when the token is unset.

Both defaults equal `--foreground`, so Light and Dark do not change (R38, R50).

## Selection model

- The mode stays in `bibcode:theme` with its values `system`, `light` and `dark` (R38).
- Two slots, `{ light: ThemeId, dark: ThemeId }`, default to `light` and `dark`. A slot accepts
  only a theme of its base (R39); `setSlot` refuses another base with `wrong-base`.
- The resolved theme is the slot of the resolved mode. In System mode the operating-system
  preference picks the slot, and a change clears the previous theme's overrides (R39).
- Picking a theme whose base differs from the resolved mode fills that base's slot, leaves the
  mode alone, and shows "Switch to dark now" or "Switch to light now" next to the list (R40).
- A slot pointing at a theme that no longer exists, or that failed to decode, reads as the
  built-in of its base. Deleting a theme in a slot writes the built-in of its base into the slot
  (R45, R49).
- Restore defaults sets the mode to System and both slots to the built-ins and keeps the library
  (R60). The General restore button also shows on `/settings/appearance`. "Theme" counts as
  changed when the mode is not System or either slot is not its built-in.

### Settings flows

- The General section loses its Theme row. Appearance holds the mode select (System, Light,
  Dark), the theme list, "New theme" and "Import theme".
- Each row shows a five-swatch preview (background, card, primary, foreground, border), the name,
  the subtitle or "Custom", the base, and "Use for light" or "Use for dark". The row menu offers
  Duplicate on every theme and Edit, Export and Delete only on custom themes (R44).
- Delete opens a confirmation that names the theme. Cancel changes nothing. Confirm deletes it
  and puts the built-in of its base into its slot (R45).
- New theme asks for a base and a name and refuses an empty name or one over 48 characters,
  saying which rule failed, then opens the editor on a theme with no overrides (R46).
- The editor groups every token as in the Token list. Each color has a native color input, a
  text field and Reset. "Reset all" asks first. A field with an invalid value shows its error
  under the field, the draft keeps the last valid value for the preview, and Save is disabled
  until every field is valid (R47).
- Import takes a `.json` file or pasted JSON, validates on "Validate", lists every field error,
  stores nothing on error, asks Replace or Keep both on an id conflict, and names reset pairs
  after import (R53, R55).

`useTheme()` keeps `resolvedTheme: "light" | "dark"` as the active theme's base, so the 23
diff-theme callers and the desktop window theme need no change (R41), and adds
`resolvedThemeId` and `themeRevision`.

## Storage

| Key                      | Content                                            | Writer      |
| ------------------------ | -------------------------------------------------- | ----------- |
| `bibcode:theme`          | the mode, unchanged                                | `useTheme`  |
| `bibcode:themes:v1`      | array of custom `ThemeFile`                        | theme store |
| `bibcode:theme-slots:v1` | `{ light, dark, paintStamp }`                      | theme store |
| `bibcode:theme-paint:v1` | `{ light: PaintRecord, dark: PaintRecord, stamp }` | theme store |

`PaintRecord = { base, background, vars, stamp }` (the Task 7.5 interface; both records carry
the same `stamp`). `vars` maps `--<token>` to the theme's own override, with every color
normalized to hex by `toHex`, lengths and keywords as written. `background` is the resolved
background (override or base value) composited over the base's built-in background, so it is
always six-digit hex even when the theme's background has alpha. `stamp` is an FNV-1a hash of
the slots and of the two slot themes' JSON.

- With nothing stored, nothing is written (R38). The first write happens when a person changes a
  slot or the library. The start-up repair below runs only when the slots key or the library key
  exists.
- A mutation re-reads the library and the slots from storage, then writes in the order paint
  record, library, slots, with the slots record carrying the new stamp as `paintStamp`. Until the
  slots write lands, the stamps differ and the pre-paint script paints the built-in base, so an
  interruption at any point never paints a stale theme (P22).
- At start, and after any `storage` event for the three keys, the store computes the stamp from
  the library and the slots it reads. If the paint record is missing, unreadable or carries
  another stamp, or the slots' `paintStamp` differs, it rewrites the paint record and then the
  slots (P18). The rewrite is deterministic, so two windows repairing at once write equal values
  and the browser fires no further `storage` event for an unchanged value.
- Each stored theme is decoded on its own with `validateThemeFile`. A failing entry is skipped
  and logged with `console.warn`, and the others load (R49). A failed write (quota or a disabled
  store) returns an error to the caller and leaves the previous stored value as it was.
- Cross-window sync: the store listens to the `storage` event for its three keys, drops its
  cached snapshot, and notifies subscribers. `useTheme` re-applies on that notification (R61).
  Writes in the same window notify directly.
- The library holds at most 64 custom themes (D19).

## Applying a theme

- The effective theme is the preview when one is set, otherwise the slot theme of the resolved
  mode. `applyTheme` toggles `.dark` from the effective theme's base and sets each entry of
  `paintRecordFor(theme).vars` with
  `document.documentElement.style.setProperty(name, value)`, so the app and the pre-paint
  script paint the same hex value. On every application, the first included, it removes every
  supported token property that the new theme does not set (this also clears what the pre-paint
  script set), and sets or removes `data-theme-focus-ring` and `data-theme-control-shadow` (R41).
- Values are only ever set as single custom properties with `setProperty`, never as style text
  or a stylesheet.
- A theme that overrides `border` also gets `--scrollbar-thumb` and `--scrollbar-thumb-hover`
  derived from it, and a theme that overrides `muted-foreground` gets
  `--sidebar-card-muted-foreground` (R57). Their defaults reproduce today's literal values, so
  Light, Dark and a custom theme that leaves those tokens unset keep today's colors (R36). This
  narrows Task 7.11 step 6, which keys on "not built-in Light or Dark" (review finding A9).
- `syncBrowserChromeTheme` reads the painted background, so the theme-color meta follows the new
  background. `desktopBridge.setTheme` receives the mode as today; the window theme follows the
  base because a slot's theme always has the base of its mode.
- `subscribeAppliedTheme` fires after every effective application (mode, System change, slot,
  saved edit, preview, Cancel). `watchAnnotationTheme` and the job log build on it (R58).
- `setThemePreview(theme)` paints an unsaved theme in this window only, and `null` paints the
  stored theme again. The editor calls `null` on Cancel, on Save and on unmount. A preview stays
  the effective theme through a System change or a `storage` event until it is cleared, and
  Cancel then shows the latest stored state. While a preview of the other base is active,
  `.dark` and `resolvedTheme` follow the preview's base so code highlighting matches. The
  desktop window keeps the stored mode, because a preview is transient and the window theme
  would flash on Cancel.
- Mermaid diagrams take `--pele-*` from `--background`, `--foreground` and `--info` (lines
  814 to 832), so they follow a theme with no diagram code (spec amendment A1).

### Pre-paint script

`apps/web/public/theme-bootstrap.js` stays an external script, because the desktop content
policy has `script-src 'self'`. Its URL is versioned by a content hash in
`scripts/lib/theme-bootstrap.ts`, which needs no manual change.

1. Read the mode from `bibcode:theme` and resolve it with `matchMedia`, as today.
2. Read `bibcode:theme-slots:v1` and `bibcode:theme-paint:v1`. Apply the record of the resolved
   mode only when the raw record is at most 32 KiB, parses to an object, its `stamp` equals the
   slots' `paintStamp` (both must be non-empty strings), the record's `base` equals the resolved
   mode, and every entry passes the checks below. One failing entry rejects the whole record.
3. Checks: the property name is in a literal allowlist written into the script (the supported
   color, length and keyword tokens with a `--` prefix); a color matches
   `/^#[0-9a-f]{6}([0-9a-f]{2})?$/i`; a length matches `/^\d+(\.\d+)?(px|rem)$/` and lies in its
   token's range; a keyword is in its own token's list (`--sidebar-card-shadow` only `none`,
   `--control-shadow` `none` or `default`); `background` is a six-digit hex color.
4. Otherwise paint the built-in base: the `.dark` class and the background `#ffffff` or
   `#161616` (R42).
5. When a record sets `--focus-ring-width` or `--focus-ring-offset`, also set
   `data-theme-focus-ring`. When it sets `--control-shadow: none`, set
   `data-theme-control-shadow="none"`.

The scrollbar variables are not in the record and arrive when the app module runs. A scrollbar
in the first frame keeps the base color, which no person can see before content renders.

A test asserts that the script's allowlist equals the tokens of the contracts module.

## Terminal

- `resolveTerminalPalette(pref, theme)` returns a `TerminalPalette` (mode, key, background,
  foreground, cursor, selection colors and the 16 ANSI colors). With preference `app` it takes
  the theme's terminal colors over its base's built-in palette (R51, D19). With `dark` or `light`
  it returns that built-in palette whatever the theme.
- `key` is a hash of every color, so a saved edit to a theme with the same id gives a new key.
- `TerminalLaunchThemeState` holds the full palette a session was launched with. A running
  session keeps it, and only new sessions read a new palette (R51). The Appearance section says
  that running terminals keep their colors.
- The OSC environment (`BIBCODE_OSC_BACKGROUND` and its two partners) is built from the palette,
  in the `r,g,b` format of `terminalTheme.ts`.
- The pipeline job log calls `logPalette(palette)` cached by `palette.key` and re-renders on
  `themeRevision`.

## Validation and security

The anti-goal is a theme file that can inject anything other than a color, a bounded length or a
fixed keyword (spec, Anti-goals; R48).

- A color is a hex color (3, 4, 6 or 8 digits), `rgb()`, `hsl()` or `oklch()` with numeric
  arguments (P16). Arguments are numbers or percentages, `hsl()` hue may carry `deg`, the
  separators are commas or spaces, and alpha follows a `/` or a fourth comma. A value is at
  most 64 characters. Named colors, `color-mix()`, `inherit` and every other function are rejected.
- `isSafeCssColor` rejects any value containing `url(`, `var(`, `expression(`, `;`, `{`, `}`,
  `<` or a backslash before it applies the grammar. It does not use `CSS.supports`, so the
  browser, the tests and the pre-paint script agree.
- Lengths are checked against their ranges, keywords against their lists.
- A file is at most 16 KiB (`MAX_THEME_FILE_BYTES`), measured on the UTF-8 text before parsing.
- Ids are `[a-z0-9-]`, 1 to 48 characters, and not reserved unless the caller decodes a built-in.
- The pre-paint script re-checks the record, because stored data can be edited by hand.
- The theme name is rendered as React text only. The export file name is `<id>.theme.json`,
  safe because the id grammar has no path characters.
- Import reads the file as text, applies the size check, parses JSON and validates. Nothing is
  stored before the person confirms, and a conflict with an existing custom id asks Replace or
  Keep both (R53).

## Contrast

- `contrastRatio` uses WCAG relative luminance. A translucent color is composited over its
  surface, and a translucent surface over the theme's background, before the ratio is computed.
- Fixed pairs (spec, Fixed pairs), in this order: `foreground` on `background`;
  `card-foreground` on `card`; `popover-foreground` on `popover`; `primary-foreground` on
  `primary`; `secondary-foreground` on `secondary`; `accent-foreground` on `accent`;
  `muted-foreground` on `background`, on `card` and on `accent`; `selected-foreground` on
  `selected`; `placeholder` on `background`; `find-match-foreground` on `find-match`;
  `find-match-active-foreground` on `find-match-active`; `terminal.foreground` on
  `terminal.background`.
- The editor lists each pair with its ratio to two decimals and marks a pair below 4.5:1 with a
  warning icon and the text "Low contrast", naming both tokens. Save stays enabled (R54).
- Import: a fixed pair below 4.5:1 is reset only when the same pair at the theme's base values
  meets 4.5:1 or the import overrides that pair's text token (amendment A3, revised). A pair the
  base already fails, such as placeholder on background in built-in Light (about 3.1:1) and Dark
  (about 3.0:1), is left alone unless the import sets its text token, so an off-white background
  keeps its override. To reset a pair, the text token's override is removed; if the pair still
  fails and the rule still applies, the surface token's override is removed; this repeats until
  no such pair fails. The notice names only the pairs actually reset. The stored theme is the reset one, so exporting it
  and importing it again changes nothing further (R55, D20).
- The four new built-ins meet every fixed pair at 4.5:1, and Matrix Light and Verdant Light keep
  `input` at 3:1 on the background and every ANSI color at 4.5:1 on the terminal background
  (R56). Light and Dark are not changed to meet these minimums (D20). Plan decision P17 sets
  `placeholder` in Tokyo Night (`#8c94bb`) and Matrix Light (`#3f6b4a`), whose default
  placeholder falls below 4.5:1.

## Focus ring and control shadow

Plan decision P7: CSS rules scoped to root attributes restyle the real owners, so no ring class
changes in the roughly 60 files that carry one.

- Marker attributes: `data-focus-ring-owner` on the input wrapper (`ui/input.tsx`, which draws
  its ring with `has-focus-visible`), `data-control-shadow` on the button root and on the Send
  button in `ComposerPrimaryActions.tsx`.
- Under `:root[data-theme-focus-ring]`, `:focus-visible` and
  `[data-focus-ring-owner]:has(:focus-visible)` draw
  `outline: var(--focus-ring-width, 2px) solid var(--ring)` with
  `outline-offset: var(--focus-ring-offset, 2px)` and clear the ring shadow. The rule excludes
  the inner control of a ring owner (the owner draws the outline), the popups that `index.css`
  lines 103 to 110 silence on purpose, and the terminal's hidden text area. The rules sit
  outside the utilities layer, so they win over `outline-none`.
- Under `:root[data-theme-control-shadow="none"]`, `[data-control-shadow]`, its `::before` and
  `::after`, and `.chat-composer-glass` get `box-shadow: none`.
- Without the attributes nothing changes, so Light and Dark keep today's ring and shadows (R59).

## Built-in themes

- Values come from [theme-palettes.md](./2026-11-09-issue-batch-340-345-290/theme-palettes.md),
  plus `foreground-strong: #c0caf5` for Tokyo Night and the six new tokens for Verdant Light
  (D17), and the P17 placeholders. Verdant Light also sets `focus-ring-width: 2px`,
  `focus-ring-offset: 2px` and `control-shadow: none`.
- Files: `apps/web/src/themes/builtin/<id>.json`. `builtinThemes.ts` lists them in the order
  Light, Dark, Tokyo Night, Matrix Dark, Matrix Light, Verdant Light, with Light and Dark as
  complete objects (`version`, `id`, `name`, `base`, `subtitle`) and no overrides.
- Subtitles: Light and Dark "Built-in", Tokyo Night "Based on Omarchy's Tokyo Night", Matrix Dark
  "Based on omarchy-matrix-theme", Matrix Light "BiBCode original", Verdant Light "BiBCode
  original".
- Licenses: JSON has no comments, so `builtinThemes.ts` credits each source in a comment. Tokyo
  Night credits Omarchy (MIT), enkia's Tokyo Night (MIT) and folke's tokyonight.nvim
  (Apache-2.0). Matrix Dark credits omarchy-matrix-theme (MIT). Phase 8 adds the entries to
  `apps/web/THIRD_PARTY_NOTICES.md` (plan decision P2). Matrix Light and Verdant Light need no
  notice.

## Risks

- A theme value reaching the page as something other than a color. Validation at every entry
  point, `setProperty` only, and the pre-paint re-check cover it (plan Review focus 5).
- The selected-state switch touches shared list components. The default maps `selected` to
  `accent`, and the web suite runs after the switch.
- An interrupted two-key write would paint a stale theme. The stamp check paints the built-in
  base instead, and the store repairs the record at the next start.
- A preview leaking past the editor. The editor clears it on Cancel, Save and unmount, and a
  test proves Cancel restores the stored color.
- `resolveToken` drifting from the stylesheet. A table-driven test compares it with the computed
  value of every derived token.
- Local storage full or unavailable. Built-in themes keep working, and a failed save shows an
  error.

## Test plan

| Area                      | Tests                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Format and validation     | `packages/contracts/src/theme.test.ts`, `apps/web/src/themes/themeValidation.test.ts`                                                 |
| New tokens and defaults   | `apps/web/src/themes/tokens.test.ts`, `apps/web/src/themeTokens.test.ts` (computed values), UI component tests                        |
| Color parser and resolver | `apps/web/src/themes/themeColor.test.ts`, `apps/web/src/themes/baseTokenValues.test.ts`                                               |
| Built-ins and contrast    | `apps/web/src/themes/builtinThemes.test.ts`                                                                                           |
| Store                     | `apps/web/src/themes/customThemes.test.ts`                                                                                            |
| Application and pre-paint | `apps/web/src/hooks/useTheme.test.ts`, `scripts/lib/theme-bootstrap.test.ts` (hostile records, stamp mismatch, allowlist parity)      |
| Terminal and job log      | `apps/web/src/components/terminalTheme.test.ts`, `apps/web/src/components/pipelines/log/jobLogStyle.test.ts`, `JobLog.theme.test.tsx` |
| Settings UI               | `AppearanceSettingsPanel.test.tsx`, `ThemeEditor.test.tsx`, `ThemeImportDialog.test.tsx`, nav and panel tests                         |
| Transfer                  | `apps/web/src/themes/themeTransfer.test.ts`                                                                                           |
| Annotation colors         | `apps/web/src/browser/annotationTheme.test.ts`                                                                                        |
| End to end                | Phase 8, `apps/desktop/e2e/specs/appearance-themes.e2e.ts`                                                                            |

## Review handling

Codex (`gpt-6.1-sol`, read-only, 2026-11-09) and the advisor reviewed the draft. Each finding
was checked against the code and the spec before any change. C is Codex, A is the advisor.

| Finding                                                                                                                           | Outcome                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1, A4. The library's place in the write order was undefined, so an interruption could paint a stale theme.                       | Fixed. Storage writes paint record, library, slots, and re-reads before each mutation.                                                                                                                                                                   |
| C2. Two windows writing at once can leave mismatched stamps or lose an update.                                                    | Fixed in part. A mismatch is repaired at start and after every `storage` event, deterministically. Cross-window locking is rejected: the spec names no case of two windows saving in the same instant, and the result is a lost edit, not a broken page. |
| C3. The cleanup list did not cover properties the pre-paint script set, nor the two root attributes.                              | Fixed. Every application removes every supported token property the new theme does not set and sets or removes both attributes.                                                                                                                          |
| C4, A6. A background with alpha made the six-digit `background` check reject the whole record.                                    | Fixed. The record's background is composited over the base background.                                                                                                                                                                                   |
| C5, A5. A storage event could replace an active preview.                                                                          | Fixed. The preview stays effective until cleared, and Cancel shows the latest stored state.                                                                                                                                                              |
| C6, A5. A preview of the other base had no defined effect on `.dark`, `resolvedTheme` and the desktop.                            | Fixed. `.dark` and `resolvedTheme` follow the preview, and the desktop window keeps the stored mode.                                                                                                                                                     |
| C7. `active:bg-primary-active` would change a keyboard press in Light and Dark.                                                   | Fixed. The button uses `active:hover:bg-primary-active`. Verified in `ui/button.tsx` line 35. This is a Ruling against Task 7.3 step 5.                                                                                                                  |
| C8. Settings flows were not described.                                                                                            | Fixed. Added "Settings flows".                                                                                                                                                                                                                           |
| C9. The stamp sat on the wrapper, not on `PaintRecord`, and missing stamps compared equal.                                        | Fixed. Each record carries the stamp, and the script requires non-empty strings.                                                                                                                                                                         |
| C10. Light and Dark were shown as `{ id, base }`.                                                                                 | Fixed. They are complete objects with no overrides.                                                                                                                                                                                                      |
| A1. The default placeholder fails 4.5:1 in plain Light, so a literal R55 strips the background of most light imports.             | Kept as an open question. The coordinator asked the user; Task 7.10 waits for the answer.                                                                                                                                                                |
| A2. The selected-state search found 2 files where the plan expected 4 to 17.                                                      | Checked with a wider search, which found 16 more selected rows and tabs. The coordinator widened the owned files to switch them, except the Phase 1 stage column.                                                                                        |
| A3. "Nothing written" conflicted with "rebuild when missing".                                                                     | Fixed. The repair runs only when the slots or library key exists.                                                                                                                                                                                        |
| A7. A bare `0` radius did not match the script's length pattern, and keywords were not checked per token.                         | Fixed. Lengths need a unit, and the script checks each keyword against its token.                                                                                                                                                                        |
| A8. The app and the pre-paint script painted different representations of one color.                                              | Fixed. Both apply `paintRecordFor(theme).vars`. The color grammar and a 64-character limit are stated.                                                                                                                                                   |
| A9. Deriving scrollbar and sidebar-card colors for every custom theme changes a duplicate of Dark that leaves those tokens unset. | Fixed. Each is derived only when the theme overrides its source token. Ruling against Task 7.11 step 6.                                                                                                                                                  |
| A10. A blanket `:focus-visible` rule rings inner inputs and silenced popups.                                                      | Fixed. Exclusions stated, and the rules sit outside the utilities layer.                                                                                                                                                                                 |
| A11. `--color-foreground-strong` may not exist for plain CSS under `@theme inline`.                                               | Fixed. The heading rule reads `var(--foreground-strong, var(--foreground))`.                                                                                                                                                                             |
| A12. happy-dom may not resolve `color-mix` in computed custom properties.                                                         | Accepted as a test-plan risk. Task 7.13 checks it first and compares resolved values where happy-dom cannot compute a color.                                                                                                                             |

Codex found no injection path under the stated validation rules.

### Implementation review (lane D4)

Codex reviewed the built phase (read-only), the coordinator triaged it, and lane D4 reproduced
each finding with a failing test before the fix.

| Finding                                                                                                                                                | Outcome                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C11. Import theme read the first 16 KiB plus one byte of a chosen file, so a file with a byte order mark and over 1 MB after it passed the size check. | Fixed. `ThemeImportDialog` refuses a file by `file.size` before reading it and shows the size error under `file`. The pasted text stays as it was.                                                                                                                |
| C12. `commitThemeImport` trusted the conflict found at validation, so Import overwrote a theme another window stored with that id in between.          | Fixed. Import calls `commitThemeImport` with the choice `import`, which checks the id again and stores nothing when a custom theme now has it. The dialog then asks Replace or Keep both (R53). This is a recheck only. Cross-window locking stays rejected (C2). |
