# Windows Console Theme Removal Design

**Date:** 2026-08-18

## Outcome

Remove the Windows console-theme bake for Codex terminals, together with the
renderer theme pin, the "cached the previous theme" notice, and the
theme-restart flow it exists to justify. Codex terminals then follow the live
app theme the same way every other terminal already does on every platform.

## Problem

On Windows, a Codex terminal spawns a `cmd /d /c color XY` initializer into its
pseudoconsole before the provider starts, and the resolved theme is recorded on
the session as `console_theme`. Because that palette is fixed for the life of
the PTY, the renderer pins its xterm theme to the launch theme and offers a
restart when the app theme later differs.

Two defects followed from that design.

1. **Black terminal in light mode.** `retainTerminalLaunchTheme` retained the
   first theme it observed even when no console theme had been baked, and
   `terminalThemeFromApp` then rendered the whole surface with the hardcoded
   fallback of the *opposite* theme (`rgb(14, 18, 24)` with
   `rgb(237, 241, 247)` text). A Codex terminal spawned in dark mode stayed
   black inside a light app, and survived app restarts because the session
   outlives the app.
2. **Gray artifacts in light mode.** With the bake applied, conhost paints each
   cell it touches as `\e[48;5;15m` — ANSI index 15. The light terminal theme
   maps index 15 to `brightWhite: rgb(236, 240, 246)` while the terminal
   background is `rgb(255, 255, 255)`, so every painted cell is a visibly gray
   rectangle on a white background.

Defect 1 was repaired separately. Defect 2 is intrinsic to baking a 16-colour
console palette into a terminal whose theme is defined in truecolor: the console
palette and the xterm theme cannot be made to agree, because `color` only
selects palette indices.

## Measurements

Captured on Windows 11 against the real `codex` and `claude` executables, using
a throwaway ConPTY harness and the dev stack driven through Chrome DevTools.

Conhost output, by console theme, for the same Codex screen:

| initializer | SGR emitted | count |
| --- | --- | --- |
| none | `\e[1m`, `\e[2m`, `\e[22m`, `\e[m` only — no colour at all | 0 colour |
| `color F0` (light) | `\e[38;5;0m` + `\e[48;5;15m` | 40 |
| `color 0F` (dark) | `\e[38;5;15m`, no background | 9 |

Codex emits no colour of its own: zero OSC colour queries, zero DEC 2031, zero
`48;2`/`48;5`/`40m`. All colour in a Codex terminal originates from the bake.

Behaviour with the bake disabled, same terminal, live theme switch, no restart:

| | light (spawned) | dark (live switch) | back to light |
| --- | --- | --- | --- |
| `consoleTheme` | `null` | `null` | `null` |
| terminal background | `rgb(255,255,255)` | dark, applied immediately | `rgb(255,255,255)` |
| palette bg/fg cells | 0 / 0 | 0 / 0 | 0 / 0 |
| theme notice | none | none | none |
| rendered text rows | 7 | 7 | 7 |

Removing the bake produced a clean white surface in light mode, a legible dark
surface in dark mode, and live theme switching without a restart.

## Design

The bake is removed rather than corrected, because without it conhost emits no
colour and the provider's output is already theme-neutral. The terminal then
renders through the xterm theme, which is the same path macOS, Linux, and every
non-Codex terminal already use.

Removed from `apps/web`:

- `usesPersistentWindowsConsoleTheme` and the `windowsConsoleTheme` input to
  `mergeTerminalSpawnEnv`, along with the `BIBCODE_WINDOWS_CONSOLE_THEME`
  reserved key.
- `retainTerminalLaunchTheme` and `TerminalLaunchThemeState`.
- The renderer's launch-theme pin, so the terminal theme is the live resolved
  theme. `terminalThemeFromApp` keeps its `requestedThemeMatchesDocument`
  fallback, which now only guards a transient render before the document class
  settles.
- The Codex theme notice, its dismissal state, and the theme-restart request
  path. `terminal.restart` itself is unchanged and still serves its other
  callers.

Removed from `apps/server`:

- `initialize_windows_console_theme`,
  `build_windows_console_theme_initializer_command`,
  `wait_for_windows_console_theme_initializer`, and the spawn-time call.
- `WINDOWS_CONSOLE_THEME_ENV`, `TerminalConsoleTheme`,
  `terminal_console_theme_from_env`, and the `console_theme` session field.

Removed from `packages/contracts` and `packages/client-runtime`:

- `TerminalConsoleTheme` and the `consoleTheme` fields on the terminal metadata
  and summary schemas, plus the client state that mirrored them.

The OSC theme responder is retained and unaffected. It answers OSC 10/11/12 and
DEC 2031 from `BIBCODE_OSC_*`, which continue to be sent. It is how providers
learn the app's theme, and measurements confirmed it does not alter Claude's
colour output.

## Alternatives considered

**Align the light theme's `brightWhite` to the terminal background.** Smaller,
and it removes the gray artifacts. Rejected: index 15 is also a foreground
colour, so pinning it to the background makes bright-white text invisible in
light mode. It also leaves the pin, the notice, the restart flow, and the
black-terminal failure mode in place.

**Keep the bake and re-bake on theme change.** Requires restarting the provider
process on every theme toggle, discarding session state. Rejected as hostile.

**Keep the bake and pin only when a theme was genuinely baked.** This is the
already-shipped repair for defect 1. It is correct but leaves defect 2 and the
whole pin/notice/restart surface intact. Superseded by this design.

## Risk and scope

Scoped to Windows plus Codex by construction. macOS and Linux never satisfied
the platform condition, and Claude never matched the command predicate, so
neither changes behaviour.

The residual risk is a Codex screen that relies on the console default
attributes for legibility. The measurements above cover the trust/hooks prompt;
a running Codex session should be validated in both themes before release.

## Validation

- Focused tests for the changed theme helpers and terminal panel behaviour.
- `vp check`, `vp run typecheck`, and the web test suite.
- `cargo fmt --all --check`, Clippy with warnings denied, and the server
  terminal tests.
- Manual Windows validation of a Codex terminal and a Claude terminal in both
  themes, including a live theme switch without restarting the terminal.
