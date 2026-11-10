# Built-in theme palettes

Data appendix to [spec.md](spec.md). Copied from issue #290 on 2026-11-09. Every value here is binding for the built-in themes unless spec.md says otherwise. Where this file mentions an open question, the answer is in spec.md under Decisions. File and line citations are from the commit the issue was verified at and are not binding.

Four new built-ins ship as data files. Each section below gives the target look, the source, the mapping onto the real tokens in `apps/web/src/index.css:243-333`, the measured contrast and the terminal palette. "Derived" means BibCode computes the value because the source does not contain it. Every ratio is a computed WCAG ratio. [measured]

The maintainer holds the reference mockups and the Verdant Light screenshot. They use fictional demo data and are not attached here.

## Built-in theme: Tokyo Night (`tokyo-night`, dark base)

### Target look

The mockups show: [screenshot]

- a deep navy background, about `#1a1b26`, with panels such as the composer and the cards one step lighter
- muted grey-blue text, about `#a9b1d6`, with brighter text about `#c0caf5`
- thin blue-grey 1px pane borders instead of shadows
- the blue accent, about `#7aa2f7`, on the send button and the active rail icon
- the terminal on the same navy background, with green check marks for passing tests

### Source palette

Omarchy's `themes/tokyo-night/colors.toml` at `5eb922f1` ([source](https://github.com/basecamp/omarchy/blob/5eb922f137422ff32a90869a9ba47525a428792d/themes/tokyo-night/colors.toml)). [verified]

| Key                          | Value                 | Key                      | Value                 |
| ---------------------------- | --------------------- | ------------------------ | --------------------- |
| `background`                 | `#1a1b26`             | `foreground`             | `#a9b1d6`             |
| `dark_background`            | `#13141c`             | `dark_foreground`        | `#565f89`             |
| `darker_background`          | `#0e0e14`             | `light_foreground`       | `#b4bee6`             |
| `lighter_background`         | `#24283b`             | `bright_foreground`      | `#c0caf5`             |
| `accent`                     | `#7aa2f7`             | `selection`              | `#292e42`             |
| `muted`                      | `#414868`             | `orange`                 | `#eb927b`             |
| `red` / `bright_red`         | `#f7768e` / `#ff7a93` | `green` / `bright_green` | `#9ece6a` / `#b9f27c` |
| `yellow` / `bright_yellow`   | `#e0af68` / `#ff9e64` | `blue` / `bright_blue`   | `#7aa2f7` / `#7da6ff` |
| `magenta` / `bright_magenta` | `#ad8ee6` / `#bb9af7` | `cyan` / `bright_cyan`   | `#449dab` / `#0db9d7` |

Omarchy's Tokyo Night is the "night" style. Its Neovim config loads `tokyonight-night` ([`neovim.lua:9`](https://github.com/basecamp/omarchy/blob/5eb922f137422ff32a90869a9ba47525a428792d/themes/tokyo-night/neovim.lua)), and its VS Code config uses `enkia.tokyo-night` ([`vscode.json`](https://github.com/basecamp/omarchy/blob/5eb922f137422ff32a90869a9ba47525a428792d/themes/tokyo-night/vscode.json)). [verified]

Compared with the upstream palettes: [verified]

- The background, foreground ramp, accent and selection match folke's night palette. `night.lua` sets `bg` `#1a1b26` ([`night.lua`](https://github.com/folke/tokyonight.nvim/blob/cdc07ac78467a233fd62c493de29a17e0cf2b2b6/lua/tokyonight/colors/night.lua)). It extends `storm.lua`, which sets `fg` `#c0caf5`, `fg_dark` `#a9b1d6`, `comment` `#565f89`, `blue` `#7aa2f7`, `bg_highlight` `#292e42` and `terminal_black` `#414868` ([`storm.lua`](https://github.com/folke/tokyonight.nvim/blob/cdc07ac78467a233fd62c493de29a17e0cf2b2b6/lua/tokyonight/colors/storm.lua)). enkia's VS Code theme also uses `editor.background` `#1a1b26` and `editor.foreground` `#a9b1d6` ([`tokyo-night-color-theme.json`](https://github.com/tokyo-night/tokyo-night-vscode-theme/blob/7c0f11eaef322f293621ca7befe462214b7ea468/themes/tokyo-night-color-theme.json)).
- The terminal palette is Omarchy's own. ANSI 0 is the background, `#1a1b26`, where folke's Ghostty extra uses `#15161e`. Cyan is `#449dab` (folke's `git.add`), not folke's `#7dcfff`. Magenta is `#ad8ee6`, not `#bb9af7`. The bright colors differ from both upstreams. This issue uses Omarchy's values, because that is the requested look.

### UI token mapping

Every mapping is proposed for the design note to confirm.

| BibCode token                                                | Value     | Source                                                                                                           |
| ------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `background` (and `app-chrome-background`, which follows it) | `#1a1b26` | `background`                                                                                                     |
| `foreground`, `card-foreground`, `popover-foreground`        | `#a9b1d6` | `foreground`                                                                                                     |
| `card`, `popover`, `muted`, `sidebar-card`                   | `#24283b` | `lighter_background`                                                                                             |
| `primary`, `ring`, `link`, `info`                            | `#7aa2f7` | `accent` and `blue`                                                                                              |
| `primary-foreground`                                         | `#1a1b26` | `background`. White on `#7aa2f7` is 2.52:1 and fails.                                                            |
| `secondary`, `accent`, `sidebar-env-band`                    | `#292e42` | `selection`                                                                                                      |
| `secondary-foreground`, `accent-foreground`                  | `#c0caf5` | `bright_foreground`                                                                                              |
| `muted-foreground`                                           | `#8c94bb` | Derived: 65% of the way from `dark_foreground` to `foreground`. `#565f89` is 2.76:1 on the background and fails. |
| `border`, `input`, `sidebar-card-border`                     | `#414868` | `muted`, which Omarchy's template for another coding app uses for borders                                        |
| `panel-separator`                                            | unset     | Its default is `ring` at 25% (`index.css:268`), so it turns blue with `ring`.                                    |
| `sidebar-well`                                               | `#13141c` | `dark_background`                                                                                                |
| `sidebar-card-shadow`                                        | `none`    | The mockups use borders instead of shadows.                                                                      |
| `destructive`, `destructive-foreground`                      | `#f7768e` | `red`                                                                                                            |
| `info-foreground`                                            | `#7da6ff` | `bright_blue`                                                                                                    |
| `success`, `success-foreground`                              | `#9ece6a` | `green`                                                                                                          |
| `warning`, `warning-foreground`                              | `#e0af68` | `yellow`                                                                                                         |
| `find-match`                                                 | `#5f4f3d` | Derived: 35% `yellow` over `background`, the recipe `index.css` uses                                             |
| `find-match-foreground`                                      | `#c0caf5` | `bright_foreground`                                                                                              |
| `find-match-active`                                          | `#e0af68` | `yellow`                                                                                                         |
| `find-match-active-foreground`                               | `#1a1b26` | `background`                                                                                                     |

Every fixed text pair is at or above 4.5:1:

| Pair                                                 | Ratio            |
| ---------------------------------------------------- | ---------------- |
| `foreground` on `background`                         | 8.10             |
| `foreground` on `card`                               | 6.90             |
| `muted-foreground` on `background`, `card`, `accent` | 5.75, 4.90, 4.52 |
| `primary-foreground` on `primary`                    | 6.79             |
| `accent-foreground` on `accent`                      | 8.32             |
| `destructive-foreground` on `card`                   | 5.51             |
| `find-match-foreground` on `find-match`              | 4.87             |

Colors outside the token blocks (`index.css:354`, `:474`, `:478`, `:815-825`, `:977`, `:1059`, `:1063`) keep the dark base's values until P1 moves them onto tokens. This applies to every built-in. [inferred]

### Terminal palette

These values follow Omarchy's [`alacritty.toml.tpl`](https://github.com/basecamp/omarchy/blob/5eb922f137422ff32a90869a9ba47525a428792d/default/themed/alacritty.toml.tpl) and [`ghostty.conf.tpl`](https://github.com/basecamp/omarchy/blob/5eb922f137422ff32a90869a9ba47525a428792d/default/themed/ghostty.conf.tpl). [verified]

| Terminal key | Value     | Terminal key                      | Value                 |
| ------------ | --------- | --------------------------------- | --------------------- |
| background   | `#1a1b26` | foreground                        | `#a9b1d6`             |
| cursor       | `#c0caf5` | selection background / foreground | `#292e42` / `#c0caf5` |
| black (0)    | `#1a1b26` | bright black (8)                  | `#414868`             |
| red (1)      | `#f7768e` | bright red (9)                    | `#ff7a93`             |
| green (2)    | `#9ece6a` | bright green (10)                 | `#b9f27c`             |
| yellow (3)   | `#e0af68` | bright yellow (11)                | `#ff9e64`             |
| blue (4)     | `#7aa2f7` | bright blue (12)                  | `#7da6ff`             |
| magenta (5)  | `#ad8ee6` | bright magenta (13)               | `#bb9af7`             |
| cyan (6)     | `#449dab` | bright cyan (14)                  | `#0db9d7`             |
| white (7)    | `#a9b1d6` | bright white (15)                 | `#c0caf5`             |

- The OSC background, foreground and cursor, in the `r,g,b` format of `terminalTheme.ts:10-13`, are `26,27,38`, `169,177,214` and `192,202,245`. [inferred]
- ANSI 0 equals the background, as in Omarchy, so ANSI-black text is invisible. Open question 7 covers this.
- The palette applies only when the terminal preference is "Follow app theme" (`app`). With "Always dark", the terminal keeps BibCode's built-in dark palette. The same rule holds for every built-in.

### License and attribution

- Omarchy is MIT-licensed, "Copyright (c) David Heinemeier Hansson" ([LICENSE](https://github.com/basecamp/omarchy/blob/5eb922f137422ff32a90869a9ba47525a428792d/LICENSE)). [verified]
- folke/tokyonight.nvim is Apache-2.0 ([LICENSE](https://github.com/folke/tokyonight.nvim/blob/main/LICENSE)). [verified]
- enkia's Tokyo Night for VS Code is MIT ([LICENSE.txt](https://github.com/tokyo-night/tokyo-night-vscode-theme/blob/master/LICENSE.txt)). [verified]
- BibCode copies only color values and maps them onto its own tokens. It copies no code.
- `tokyo-night.json` gets a header comment and a `THIRD_PARTY_NOTICES` entry. They credit Omarchy's MIT license with its copyright line, and enkia (MIT) and folke (Apache-2.0) as the palette's origin. [guess: whether bare color values need a notice is a legal question. The notice costs little.]

## Built-in themes: Matrix Dark (`matrix-dark`, dark base) and Matrix Light (`matrix-light`, light base)

### Target look

Matrix Dark mockups show: [screenshot]

- a near-black background, about `#000000` to `#0a0f0a`, with black panels
- bright green 1px pane borders and focus outline, about `#00ff41` to `#22c55e`
- green headings, green-tinted body text and muted green secondary text
- a bright green send button and active rail icon
- added diff lines on a dark green fill and removed lines on a dark red fill, so red still marks deletions
- a black terminal with green text and yellow numbers, and code syntax in mostly green and yellow

Matrix Light mockups show: [screenshot]

- a white background, with a very light green tint on selected sidebar items and chips
- green 1px pane borders, a green outline on the active rail icon and a green composer border
- near-black headings and green-tinted secondary text
- a solid green send button and green "primary" chips
- a white terminal with dark green text and green check marks

### Sources

- Omarchy has no Matrix theme. Its `themes/` directory at `5eb922f1` has 22 themes, and none is named Matrix. The closest is `hackerman`. It is navy (`#0B0C16`) and maps `red` to a green (`#50f872`), so deletions would not read as red. [verified]
- Matrix Dark uses a community Omarchy theme, [BVisagie/omarchy-matrix-theme](https://github.com/BVisagie/omarchy-matrix-theme), `colors.toml` at `59e757b1` ([source](https://github.com/BVisagie/omarchy-matrix-theme/blob/59e757b168b49e2a0000065da654895050d0f8fc/colors.toml)), MIT ([LICENSE](https://github.com/BVisagie/omarchy-matrix-theme/blob/59e757b168b49e2a0000065da654895050d0f8fc/LICENSE)). It is near-black, keeps a real red and yellow, and sets all 16 ANSI colors explicitly. [verified]
- I rejected [tmp75/omarchy-matrix-theme](https://github.com/tmp75/omarchy-matrix-theme) at `8bdb1583`. It is closer to the mockups' `#00ff41` on pure black, but it maps `red` to `#39ff6a` and `yellow` to `#9bff6a`, so deletions and warnings would turn green. [verified]
- Matrix Light has no source. Searches for "omarchy matrix theme" and "omarchy matrix light" found no light Matrix theme for Omarchy on GitHub. Its palette is derived from the mockups. [verified for the search; the palette is a guess]

### Matrix Dark source palette

From BVisagie's `colors.toml` at `59e757b1`. [verified]

| Key                          | Value                 | Key                      | Value                 |
| ---------------------------- | --------------------- | ------------------------ | --------------------- |
| `background`                 | `#080C09`             | `foreground`             | `#8BC98C`             |
| `dark_background`            | `#050705`             | `dark_foreground`        | `#678D6A`             |
| `darker_background`          | `#020302`             | `light_foreground`       | `#A8D4A9`             |
| `lighter_background`         | `#121A13`             | `bright_foreground`      | `#C5E6C6`             |
| `accent`                     | `#3CBF5C`             | `selection`              | `#23482A`             |
| `muted`                      | `#678D6A`             | `cursor`                 | `#C5E6C6`             |
| `red` / `bright_red`         | `#D15D57` / `#E97870` | `green` / `bright_green` | `#2D9A48` / `#5ED87A` |
| `yellow` / `bright_yellow`   | `#B8BA48` / `#D4D66A` | `blue` / `bright_blue`   | `#3D8F68` / `#5AA080` |
| `magenta` / `bright_magenta` | `#708B6D` / `#7A927A` | `cyan` / `bright_cyan`   | `#4BB56A` / `#6ECB88` |

The accent `#3CBF5C` is softer than the mockups' brightest green. The file's own comment says "CRT phosphor, not laser lime". Open question 9 asks whether to brighten it.

### Matrix Dark UI token mapping

Every mapping is proposed.

| BibCode token                                         | Value                | Source                                                                                                                                                          |
| ----------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `background` (and `app-chrome-background`)            | `#080c09`            | `background`                                                                                                                                                    |
| `foreground`, `card-foreground`, `popover-foreground` | `#8bc98c`            | `foreground`                                                                                                                                                    |
| `card`, `popover`, `muted`, `sidebar-card`            | `#121a13`            | `lighter_background`                                                                                                                                            |
| `primary`, `ring`, `link`, `info`, `success`          | `#3cbf5c`            | `accent`                                                                                                                                                        |
| `primary-foreground`                                  | `#080c09`            | `background`. White on `#3cbf5c` is 2.39:1 and fails.                                                                                                           |
| `secondary`, `accent`, `sidebar-env-band`             | `#23482a`            | `selection`                                                                                                                                                     |
| `secondary-foreground`, `accent-foreground`           | `#c5e6c6`            | `bright_foreground`                                                                                                                                             |
| `muted-foreground`                                    | `#96ba98`            | Derived: 50% of the way from `muted` `#678d6a` to `bright_foreground`. `#678d6a` passes on the background (5.24) and the card (4.73) but is 2.75:1 on `accent`. |
| `border`, `sidebar-card-border`                       | `#1a5a28`            | The second stop of the file's `hyprland_active_border`, made opaque                                                                                             |
| `input`                                               | `#2d9a48`            | `green`, so inputs and the composer get a visible green edge                                                                                                    |
| `panel-separator`                                     | `#3cbf5c`            | `accent`. The default, `ring` at 25% (`index.css:268`), is too dim for the bright pane borders in the mockups.                                                  |
| `sidebar-well`                                        | `#050705`            | `dark_background`                                                                                                                                               |
| `sidebar-card-shadow`                                 | `none`               | Borders instead of shadows                                                                                                                                      |
| `destructive`, `destructive-foreground`               | `#d15d57`            | `red`                                                                                                                                                           |
| `info-foreground`, `success-foreground`               | `#5ed87a`            | `bright_green`                                                                                                                                                  |
| `warning`, `warning-foreground`                       | `#b8ba48`, `#d4d66a` | `yellow`, `bright_yellow`                                                                                                                                       |
| `find-match`                                          | `#46491f`            | Derived: 35% `yellow` over `background`                                                                                                                         |
| `find-match-foreground`                               | `#c5e6c6`            | `bright_foreground`                                                                                                                                             |
| `find-match-active`, `find-match-active-foreground`   | `#b8ba48`, `#080c09` | `yellow`, `background`                                                                                                                                          |

Every fixed text pair is at or above 4.5:1:

| Pair                                                 | Ratio            |
| ---------------------------------------------------- | ---------------- |
| `foreground` on `background`, `card`                 | 10.15, 9.16      |
| `muted-foreground` on `background`, `card`, `accent` | 9.16, 8.26, 4.81 |
| `primary-foreground` on `primary`                    | 8.25             |
| `accent-foreground` on `accent`                      | 7.63             |
| `destructive-foreground` on `card`                   | 4.58             |
| `find-match-foreground` on `find-match`              | 6.94             |

The derived `muted-foreground` is nearly as bright as `foreground` (9.16 against 10.15), so secondary text barely recedes. Open question 9 covers this.

### Matrix Dark terminal palette

These are the file's explicit `color0` to `color15`, `cursor` and `selection_*` keys. [verified]

| Terminal key | Value     | Terminal key                      | Value                 |
| ------------ | --------- | --------------------------------- | --------------------- |
| background   | `#080c09` | foreground                        | `#8bc98c`             |
| cursor       | `#c5e6c6` | selection background / foreground | `#23482a` / `#c5e6c6` |
| black (0)    | `#080c09` | bright black (8)                  | `#678d6a`             |
| red (1)      | `#d15d57` | bright red (9)                    | `#e97870`             |
| green (2)    | `#2d9a48` | bright green (10)                 | `#5ed87a`             |
| yellow (3)   | `#b8ba48` | bright yellow (11)                | `#d4d66a`             |
| blue (4)     | `#3d8f68` | bright blue (12)                  | `#5aa080`             |
| magenta (5)  | `#708b6d` | bright magenta (13)               | `#7a927a`             |
| cyan (6)     | `#4bb56a` | bright cyan (14)                  | `#6ecb88`             |
| white (7)    | `#8bc98c` | bright white (15)                 | `#c5e6c6`             |

The OSC colors are `8,12,9`, `139,201,140` and `197,230,198`. [inferred] ANSI 0 equals the background, as in Tokyo Night (open question 7).

### Matrix Light palette and UI token mapping

No source exists, so every value is proposed and derived from the mockups. The greens are dark enough for text on white. [guess for the values]

| BibCode token                                         | Value                | Note                                             |
| ----------------------------------------------------- | -------------------- | ------------------------------------------------ |
| `background`, `card`, `popover`, `sidebar-card`       | `#ffffff`            | White, as in the mockup                          |
| `foreground`, `card-foreground`, `popover-foreground` | `#0f1f14`            | Near-black with a green tint                     |
| `primary`, `ring`, `link`, `info`, `success`          | `#15803d`            | The solid green of the send button and chips     |
| `primary-foreground`                                  | `#ffffff`            |                                                  |
| `secondary`, `accent`, `sidebar-env-band`             | `#e8f5ec`            | The light green tint on selected items and chips |
| `secondary-foreground`, `accent-foreground`           | `#14532d`            |                                                  |
| `muted`                                               | `#f3f8f4`            |                                                  |
| `muted-foreground`                                    | `#3f6b4a`            | Green-tinted secondary text                      |
| `border`, `sidebar-card-border`                       | `#b7dcc2`            | Light green dividers inside panels               |
| `input`, `panel-separator`                            | `#16a34a`            | The green pane borders and composer border       |
| `sidebar-well`                                        | `#f6faf7`            |                                                  |
| `sidebar-card-shadow`                                 | `none`               |                                                  |
| `destructive`, `destructive-foreground`               | `#b91c1c`            | Red stays red.                                   |
| `info-foreground`, `success-foreground`               | `#166534`            |                                                  |
| `warning`, `warning-foreground`                       | `#a16207`, `#854d0e` |                                                  |
| `find-match`                                          | `#ecd6a7`            | Derived: 35% `#ca8a04` over white                |
| `find-match-foreground`                               | `#0f1f14`            |                                                  |
| `find-match-active`, `find-match-active-foreground`   | `#ca8a04`, `#0f1f14` |                                                  |

Every fixed text pair is at or above 4.5:1, including green text on white:

| Pair                                                                              | Ratio                 |
| --------------------------------------------------------------------------------- | --------------------- |
| `foreground` on `background`                                                      | 17.12                 |
| `primary` `#15803d` as text on white, and white `primary-foreground` on `primary` | 5.02                  |
| `success-foreground` `#166534` on white                                           | 7.13                  |
| `muted-foreground` on `background`, `accent`, `sidebar-well`                      | 6.15, 5.48, 5.84      |
| `accent-foreground` on `accent`                                                   | 8.11                  |
| `destructive-foreground`, `warning-foreground` on white                           | 6.47, 6.85            |
| `find-match-foreground` on `find-match`, `find-match-active`                      | 12.02, 5.83           |
| Non-text: `panel-separator` and `input` `#16a34a` on white                        | 3.30, above 3:1       |
| Non-text: `border` `#b7dcc2` on white                                             | 1.50, decorative only |

### Matrix Light terminal palette

On the white terminal, the "bright" colors are darker shades, so every ANSI color stays readable. [guess for the values]

| Terminal key | Value     | Terminal key                      | Value                 |
| ------------ | --------- | --------------------------------- | --------------------- |
| background   | `#ffffff` | foreground                        | `#14532d`             |
| cursor       | `#15803d` | selection background / foreground | `#c9ebd3` / `#0f1f14` |
| black (0)    | `#0f1f14` | bright black (8)                  | `#5b6b60`             |
| red (1)      | `#b91c1c` | bright red (9)                    | `#dc2626`             |
| green (2)    | `#15803d` | bright green (10)                 | `#166534`             |
| yellow (3)   | `#a16207` | bright yellow (11)                | `#854d0e`             |
| blue (4)     | `#1f6f8b` | bright blue (12)                  | `#2a7fa0`             |
| magenta (5)  | `#7e3f8f` | bright magenta (13)               | `#9a4fb0`             |
| cyan (6)     | `#0f766e` | bright cyan (14)                  | `#115e59`             |
| white (7)    | `#4b5f52` | bright white (15)                 | `#3f4f44`             |

All 16 colors are at or above 4.5:1 on white. The lowest is bright blue at 4.52, the foreground is 9.11 and the selection pair is 13.30. The OSC colors are `255,255,255`, `20,83,45` and `21,128,61`. [inferred]

### Diffs and syntax in both Matrix themes

- Diff fills already follow the theme. `DiffPanel.tsx:108-119` mixes `--success` and `--destructive` into `--background`, so added and removed lines take the theme's green and red. At 8%, Matrix Dark gets `#0c1a10` and `#18120f`, and Matrix Light gets `#ecf5ef` and `#f9eded`. [code; the hex values are measured]
- Syntax colors stay on `pierre-dark` and `pierre-light` in P0. The mockups' green-and-yellow code needs custom syntax colors, which are P2. [inferred]

### License and attribution

- BVisagie/omarchy-matrix-theme is MIT, "Copyright (c) 2026 Bernard Visagie". `matrix-dark.json` gets a header comment and a `THIRD_PARTY_NOTICES` entry, like Tokyo Night. [verified]
- Matrix Light is original to BibCode and needs no notice.

## Built-in theme: Verdant Light (`verdant-light`, light base)

The maintainer specified this theme exactly: a white workspace with graphite text and restrained emerald accents. The palette and rules below are the spec. Only the token mapping, the terminal palette and the list of missing tokens are proposed. [maintainer spec]

### Target look and rules

The reference screenshot shows white panels, sidebar and terminals with thin neutral dividers. Text is graphite. Emerald appears only on the send button, the active rail icon and selected chips. The composer is white with a thin neutral border and no prominent shadow. The terminal shows green check marks and blue info lines. [screenshot]

The spec's rules:

- Keep large surfaces pure white and ordinary text neutral. Use emerald only for actions and selection.
- Use no green panel outlines, tinted page backgrounds, gradients or glow.
- Keep the current fonts, layout, spacing and panel proportions. Use sans-serif for interface text and monospace only for code and terminal output.
- Use regular or medium weight for body text and controls, and semibold for headings.
- Primary buttons have an emerald fill with a white label or icon. Secondary buttons have a white fill, graphite text and a neutral border.
- Selected tabs have a pale emerald background with dark emerald text.
- Focus is a 2px emerald outline with a 2px offset.
- Icons are neutral by default and emerald when active.
- Corner radius is 6-8px for controls and 12-16px for cards and the composer.

### Palette and token mapping

The Role and Value columns are the spec. The token column and the notes are proposed, and token names are the real names in `index.css`. "New token" marks a role that no token covers today.

| Role (spec)                                                      | Value                                      | BibCode token                                                                                      | Note                                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background: workspace, sidebar, headers, terminals               | `#FFFFFF`                                  | `background` (and `app-chrome-background`), `sidebar-well`                                         | The sidebar is white, so the recessed well goes away.                                                                                                                                                 |
| Surface: cards, composer, menus                                  | `#FFFFFF`                                  | `card`, `popover`, `sidebar-card`                                                                  |                                                                                                                                                                                                       |
| Subtle surface: tab tracks, secondary badges, hover backgrounds  | `#F5F7F7`                                  | `muted`, `secondary`, `accent`, `sidebar-env-band`                                                 | `accent` is the hover background (`button.tsx:41`). [code]                                                                                                                                            |
| Primary text: headings, active labels                            | `#181C20`                                  | none                                                                                               | **New token.** BibCode has no heading or emphasis color, so headings use `foreground` (open question 8).                                                                                              |
| Body text: prose, terminal output                                | `#303840`                                  | `foreground`, `card-foreground`, `popover-foreground`, `secondary-foreground`, `accent-foreground` |                                                                                                                                                                                                       |
| Secondary text: supporting labels, icons                         | `#59636B`                                  | `muted-foreground`                                                                                 | Buttons color their icons with `muted-foreground` (`button.tsx:41`, `:44`). [code]                                                                                                                    |
| Placeholder: input hints                                         | `#667078`                                  | none                                                                                               | **New token.** Inputs use `placeholder:text-muted-foreground/72` (`input.tsx:22`). With `#59636b` that renders about `#878f94`, which is 3.29:1 and fails. [code]                                     |
| Divider: panel boundaries and decorative separators              | `#DEE3E6`                                  | `border`, `sidebar-card-border`, `panel-separator`                                                 | `panel-separator` must be set. Its default, `ring` at 25% (`index.css:268`), would draw the green panel outlines the spec forbids.                                                                    |
| Control border: inputs and controls that need a visible boundary | `#87939B`                                  | `input`                                                                                            | The `outline` button variant and inputs use `border-input` (`button.tsx:44`). Other controls use `border`, and the design note lists which. [code]                                                    |
| Accent: primary actions, active indicators, focus                | `#087F5B`                                  | `primary`, `ring`, `link`                                                                          | The spec names no link color. Links are actions, so `link` uses the accent. [guess]                                                                                                                   |
| Label on accent                                                  | white                                      | `primary-foreground`                                                                               |                                                                                                                                                                                                       |
| Accent hover, accent pressed                                     | `#066649`, `#05543D`                       | none                                                                                               | **New tokens.** The default button hovers with `bg-primary/90` and shows a press with an inset shadow (`button.tsx:35`). [code]                                                                       |
| Selected surface: selected tabs, rows, badges                    | `#EAF5EF`                                  | none                                                                                               | **New token.** Selection uses `bg-accent`, for example `data-selected:bg-accent/50`, so it cannot differ from hover. [code]                                                                           |
| Selected text: labels on selected surfaces                       | `#065F46`                                  | none                                                                                               | **New token**, paired with the selected surface.                                                                                                                                                      |
| Success and added code                                           | `#26734D`                                  | `success`, `success-foreground`                                                                    |                                                                                                                                                                                                       |
| Error and removed code                                           | `#B42318`                                  | `destructive`, `destructive-foreground`                                                            |                                                                                                                                                                                                       |
| Warning                                                          | `#946200`                                  | `warning`, `warning-foreground`                                                                    |                                                                                                                                                                                                       |
| Information and functions                                        | `#365C7A`                                  | `info`, `info-foreground`                                                                          |                                                                                                                                                                                                       |
| Find matches                                                     | `#dac8a6` and `#181c20`                    | `find-match`, `find-match-foreground`                                                              | Derived: 35% warning over white                                                                                                                                                                       |
| Active find match                                                | `#946200` and white                        | `find-match-active`, `find-match-active-foreground`                                                |                                                                                                                                                                                                       |
| No prominent shadow                                              | `none`                                     | `sidebar-card-shadow`                                                                              |                                                                                                                                                                                                       |
| Added-line and removed-line background                           | `#EDF7EF`, `#FDEEEE`                       | none                                                                                               | **New tokens, or accept the derived values.** Today the fills are 8% `success` and `destructive` over the background (`DiffPanel.tsx:108-119`), which gives `#eef4f1` and `#f9eded`. [code, measured] |
| Keywords, strings, comments, functions                           | `#7047A3`, `#26734D`, `#667078`, `#365C7A` | none                                                                                               | **P2.** Syntax colors come from `pierre-light`.                                                                                                                                                       |
| Radius                                                           | unchanged                                  | `--radius` (`index.css:245`, `0.625rem`)                                                           | The current scale already fits the spec: `radius-sm` 6px, `radius-md` 8px, `radius-xl` 14px (`index.css:85-91`). [code]                                                                               |
| Focus ring width and offset                                      | 2px, 2px                                   | none                                                                                               | **New non-color tokens.** Components hard-code `ring-2`, `ring-[3px]` and `ring-offset-1`. Only the active find row uses `2px` with a `2px` offset (`index.css:347-349`). [code]                      |
| Composer and button shadows                                      | none                                       | none                                                                                               | **New non-color token.** Shadows are utility classes such as `shadow-xs` in `button.tsx:35` and `ComposerPrimaryActions.tsx:307`. [code]                                                              |

The spec's secondary button already matches the `outline` variant: `popover` fill, `foreground` text and an `input` border (`button.tsx:43-44`). [code] Open question 10 decides which non-color tokens the schema accepts.

### Contrast

| Pair                                                                         | Ratio                  | Result                                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary text `#181c20` on white                                              | 17.13                  | Pass                                                                                                                                             |
| Body text `#303840` on white                                                 | 11.90                  | Pass                                                                                                                                             |
| Secondary text `#59636b` on white                                            | 6.14                   | Pass                                                                                                                                             |
| Placeholder `#667078` on white                                               | 5.06                   | Pass                                                                                                                                             |
| White label on accent `#087f5b`, and accent as text on white                 | 5.00                   | Pass                                                                                                                                             |
| White label on hover `#066649` and on pressed `#05543d`                      | 6.99, 8.97             | Pass                                                                                                                                             |
| Selected text `#065f46` on selected surface `#eaf5ef`                        | 6.88                   | Pass                                                                                                                                             |
| Secondary text on subtle surface `#f5f7f7`                                   | 5.71                   | Pass                                                                                                                                             |
| Placeholder on subtle surface                                                | 4.70                   | Pass, with little margin                                                                                                                         |
| Success, error, warning and information on white                             | 5.77, 6.57, 5.24, 7.07 | Pass                                                                                                                                             |
| Keywords on white                                                            | 6.73                   | Pass                                                                                                                                             |
| Success on the added-line background, error on the removed-line background   | 5.26, 5.84             | Pass                                                                                                                                             |
| Find-match foreground on find-match, white on the active find match          | 10.44, 5.24            | Pass                                                                                                                                             |
| Non-text: control border `#87939b` on white                                  | 3.15                   | Pass (3:1)                                                                                                                                       |
| Non-text: accent focus outline on white                                      | 5.00                   | Pass (3:1)                                                                                                                                       |
| Non-text: divider `#dee3e6` on white                                         | 1.29                   | Below 3:1. Fine for decorative separators, not for control boundaries, which is why the spec has a separate control border.                      |
| Non-text: selected surface `#eaf5ef` and subtle surface `#f5f7f7` on white   | 1.12, 1.08             | Below 3:1. The selected state must also show through the selected text color or an indicator, not the fill alone. [guess about the WCAG reading] |
| Today's placeholder recipe (`muted-foreground/72`, about `#878f94`) on white | 3.29                   | Fails, so Verdant Light needs the placeholder token.                                                                                             |

### Terminal palette

Derived from the semantic colors for a white terminal. The bright colors are darker shades, so they stay readable on white. [guess for the derived values]

| Terminal key | Value     | Source                                | Terminal key        | Value                 | Source                    |
| ------------ | --------- | ------------------------------------- | ------------------- | --------------------- | ------------------------- |
| background   | `#ffffff` | Background                            | foreground          | `#303840`             | Body text                 |
| cursor       | `#181c20` | Primary text                          | selection bg / fg   | `#eaf5ef` / `#065f46` | Selected surface and text |
| black (0)    | `#181c20` | Primary text                          | bright black (8)    | `#667078`             | Placeholder               |
| red (1)      | `#b42318` | Error                                 | bright red (9)      | `#912018`             | Darker red                |
| green (2)    | `#26734d` | Success                               | bright green (10)   | `#1d5c3d`             | Darker green              |
| yellow (3)   | `#946200` | Warning                               | bright yellow (11)  | `#7a5100`             | Darker yellow             |
| blue (4)     | `#365c7a` | Information                           | bright blue (12)    | `#2b4a63`             | Darker blue               |
| magenta (5)  | `#7047a3` | Keywords                              | bright magenta (13) | `#5a3985`             | Darker magenta            |
| cyan (6)     | `#1f6b72` | Derived teal, since the spec has none | bright cyan (14)    | `#185a60`             | Darker teal               |
| white (7)    | `#59636b` | Secondary text                        | bright white (15)   | `#303840`             | Body text                 |

Every color is at or above 5.06:1 on white, and the selection pair is 6.88. The OSC colors are `255,255,255`, `48,56,64` and `24,28,32`. [inferred] The cursor is graphite, not emerald, because the spec keeps emerald for actions and selection.

### License

The maintainer wrote the palette, so it needs no notice.
