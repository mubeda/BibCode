# Phase 6: Linux setting to run without GPU compositing

- Goal: On Linux the user can make BiBCode start WebKitGTK without GPU compositing, however the app is started, with tests and documentation.
- Round: 1
- Depends on: none
- Owns: the desktop start-up path that runs before the webview (`apps/desktop/src-tauri/src/main.rs` and a new module for the setting), the Linux desktop setting in the web Settings panel, `docs/user/linux-desktop.md`, `docs/testing/linux-desktop.md`
- Must not touch: `apps/desktop/src-tauri/src/window.rs`, `apps/desktop/src-tauri/src/preview/**`, `apps/server/src/provider/**`, `apps/server/src/production/provider_*`, `apps/web/src/components/files/**`, `apps/web/src/components/gitManager/**`
- Skills: tdd; rust-best-practices
- Read first: issue #411 in full; `docs/user/linux-desktop.md`; `docs/testing/linux-desktop.md`; `docs/superpowers/specs/2026-07-27-linux-appimage-wayland-compatibility-design.md` and `docs/superpowers/specs/2026-09-23-appimage-child-environment-design.md` (history; verify before reuse); `AGENTS.md` sections "Profiler, Crash, and Trace Coverage" (the crash hook attaches first in `main`) and "Architectural Decision Standards"
- Checkpoint: the Done when commands of Tasks 6.1 and 6.2 exit 0; in the Linux lab the packaged app starts and renders with the setting on.

## Tasks

### Task 6.1: Write and review the software-rendering design note

- Satisfies: R17
- Depends on: none
- Files: create `docs/plans/2026-11-21-linux-software-rendering-design.md`
- Interfaces: produces the decisions Task 6.2 implements: where the setting is stored, how it is read before the webview exists, its environment override, which variables it sets, and what child processes inherit
- Skills: none
- Read first: the phase's Read first list; how `main` orders the crash hook, the AppImage environment handling and Tauri start-up today
- Tier: most capable
- TDD: exempt (a design document has no behavior to test)
- Done when: `vp test run scripts/no-sensitive-data.test.ts scripts/bibcode-identity.test.ts` exits 0 and the note has passed a Codex and an advisor review

Rules for this task

- The note states alternatives and trade-offs for: storage (a file read in `main` before Tauri, against an environment variable only, against a launcher change), default (off; Tauri's guidance is not to ship the variables unconditionally), and whether child processes (terminals, providers, the preview webview) inherit the two variables or have them removed.
- The setting must work when the app is started from the `bibcode://` handler, which starts the binary directly, and must survive an AppDir replacement.
- The setting must be changeable when no window can be shown.
- A value the user exported is never overwritten.
- The crash hook still attaches first in `main`.

Steps

1. [ ] Read the start-up path and write the note with the alternatives above and one recommendation each.
2. [ ] Run the guard tests. Hand the note to the executor for the Codex and advisor review, and revise it from the findings.

### Task 6.2: Add the Linux software-rendering setting

- Satisfies: R17
- Depends on: 6.1
- Files: modify `apps/desktop/src-tauri/src/main.rs`; create the module the note names, with tests; modify the Settings panel the note names, with tests; modify `docs/user/linux-desktop.md`, `docs/testing/linux-desktop.md`
- Interfaces: consumes the decisions of Task 6.1; produces the setting and its override as the note names them
- Skills: vercel-react-best-practices and `UI.md` review for the Settings change
- Read first: the reviewed design note
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-desktop software_rendering` exits 0 and the focused web test of the Settings change exits 0

Rules for this task

- Decide the variables in a pure function of (setting, override, existing environment, platform) and test that function; `main` only applies its result before any thread or webview starts.
- No behavior change on macOS and Windows; the Settings control shows only on Linux desktop.
- State in the task report the profiler coverage line and the user-visible text.

Steps

1. [ ] Write failing tests for the pure function: setting on sets both variables; setting off sets none; an exported value is kept; the override wins over the stored setting in both directions; other platforms set none. Write the failing Settings test.
2. [ ] Run the Done when commands. Expected: FAIL, because the module does not exist.
3. [ ] Implement the module, call it from `main` after the crash hook and before Tauri, and add the Settings control with its restart note.
4. [ ] Run the Done when commands. Expected: PASS.
5. [ ] Prove the tests can fail: make the function ignore the setting, run the Done when commands. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Run `cargo fmt --all --check`, Clippy with warnings denied for the desktop target, `vp check` and `vp run typecheck`. Build the Linux package in the Linux lab, start it with the setting on and with it off, with the Profiler on, and record that the app renders and which variables the process holds. Update the two Linux documents. Expected: no errors, and the app renders in both runs.
