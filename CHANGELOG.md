# Changelog

## [v0.4.0] - 2026-08-17

### Highlights

- Added an authoritative worktree catalog that discovers existing Git worktrees, lets users adopt one or all discovered checkouts without recreating them, and preserves physical identity across path aliases and reconnects.
- Added explicit recovery and removal flows for missing or present worktrees, including fresh server-side plans, dirty/stale-registration confirmations, durable retry receipts, and identity-safe cleanup on Windows, macOS, and Linux.
- Improved local desktop presentation: macOS and Linux now focus on the local environment, Windows keeps truthful WSL location and recovery controls, Cursor is enabled as a supported provider, and legacy Grok actions are hidden.
- Improved Activity timestamps and hierarchy while bounding Claude fallback ambiguity so stale or unrelated processes are not presented as controllable activity.
- Hardened provider, terminal, logging, persistence, update, and shutdown ownership under parallel load, including bounded OpenCode reaping, isolated native fixtures, and per-runtime process cleanup that preserves sibling desktop runtimes.
- Hardened Linux packaging and expanded repeatable native validation across macOS arm64/x64, Linux x64, and Windows x64.

### Data and compatibility

- Database migrations 40–43 add per-project worktree discovery state, repository identity pins, and durable worktree-removal receipts. Existing stores are migrated through the normal verified pre-migration backup path.
- No intentional breaking API change is documented. Older servers that do not advertise worktree-catalog support continue without the new catalog controls.
- macOS artifacts remain ad-hoc signed and unnotarized; Windows installers remain unsigned.

### Known issues

- Native Windows, Linux, and both macOS architectures require their respective release runners for final installer and updater verification.

**Full changelog:** [v0.3.13...v0.4.0](https://github.com/mubeda/BibCode/compare/v0.3.13...v0.4.0)

[v0.4.0]: https://github.com/mubeda/BibCode/releases/tag/v0.4.0
