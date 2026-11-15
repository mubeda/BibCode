# #358 Web and terminal: native-preview cover for popups, a size-claim capability, and lab observations

Small web and terminal follow-ups from #349.

- On macOS desktop, Popover, Menu, Select and tooltips can draw under a native browser preview. Sheet, Dialog and AlertDialog take an occlusion lease, but `useNativePreviewOcclusion` hides the whole preview and has no rectangle. Add a lease that carries a rectangle so the preview hides only when the popup overlaps it (`browserSurfaceStore`, possibly the desktop bridge).
- The client treats the `terminalUserInputClaim` server capability as proof that the server has the typed-last size hand-over rule. A server that advertises one without the other would break this silently. Add a dedicated capability (`packages/contracts/src/environment.ts`, `apps/server/src/lifecycle.rs`).
- Observed in lab runs without a known cause, to investigate: the WebGL terminal renderer sometimes falls back to the DOM renderer within a run (probably after reloads); an empty over-tall grid shows between a terminal's mount and its first snapshot after a reload; `terminal_command_activity_hint_decodes_strictly_without_entering_launch_env` was flaky before its close path was fixed and needs repeated runs to confirm; LAN pairing in the dev build answered "Invalid pairing token" once.
- Not measured: whether the composer's model picker can show old values for one render on a rapid reopen (#346).

## Comment 2026-11-12T23:21:22Z

One more item, found while fixing a review comment on #349: the read-only rendered Markdown view (`ChatMarkdown`, used in Files while the rich editor loads, for files over 128 KiB, and for files the editor cannot change safely) still requests a relative image against the app's own address, so the image does not load. The rich editor now loads such images from the workspace; the read-only view should use the same loader. Same behaviour on `main`.
