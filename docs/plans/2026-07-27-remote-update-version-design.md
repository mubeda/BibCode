# Remote Update Version

## Goal

When the desktop updater reports an available version, the About screen shows both the installed and remote versions:

`Version 0.2.14 → 0.2.15`

Without an available update, it continues to show only the installed version.

## Design

Keep the existing updater contract and state flow. `AboutVersionSection` already receives `availableVersion`; pass that value to `AboutVersionTitle`, which renders it after `APP_VERSION` when present.

This applies while the update is available, downloading, or downloaded because those states retain `availableVersion`. Browser builds and updater states without an available version remain unchanged.

## Error Handling

No new error path is introduced. A missing remote version falls back to the current-version display.

## Verification

Extend the existing About settings test to assert the installed-to-remote version label for an available update. Run the focused web test, `vp check`, and `vp run typecheck`.
