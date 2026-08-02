# Whole-branch provider-maintenance fix report

Status: DONE

Authoritative parent: `6397eb3a6675e78c8b17b06ddd7780eded2d79c8`

Implementation commit: `4831a760c4b8be1104c04d44bee5980f23559b4e` (`fix: close provider maintenance review gaps`), published to `origin/codex/lets-bibcode` through the GitHub Git Data API. Its parent and all three local/remote blob hashes were verified.

## Fixes

1. Post-update verification now reports `succeeded` only for an exact `current` advisory. `unknown`, `behind_latest`, and an absent target report `unchanged`; Cursor's unverifiable update uses the existing could-not-verify message.
2. Installation-source classification preserves whether the configured command is bare. Specific native, Vite+, Bun, pnpm, npm, and Homebrew matches still win; standard canonical npm/pnpm layouts are recognized before Homebrew; an otherwise unrecognized resolved bare command falls back to npm; unrecognized explicit paths remain manual-only. Claude/OpenCode native paths require exact filenames, including `.exe`, so prefix lookalikes are not executed as native updaters.
3. Update-state publication now shares the settings-update lock while checking whether the same instance ID and driver remain configured and while inserting/removing retained state. Retained entries carry driver identity, full-replacement pruning uses ID+driver, and overlay removes stale state. Removal through terminal completion and same-ID re-add no longer restores an old update state.

## RED evidence

- `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib post_update_verification_distinguishes_success_and_unchanged -- --test-threads=1` exited 1: `unknown` returned `succeeded` instead of `unchanged`.
- `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_control provider_update_executes_a_supported_cursor_command_but_cannot_verify_version -- --test-threads=1` exited 1: Cursor published `succeeded` instead of `unchanged`.
- `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib resolves_cross_platform_installation_sources -- --test-threads=1` exited 1: a canonical npm target reached through `/usr/local/bin` selected Homebrew.
- `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib native_installers_require_exact_paths -- --test-threads=1` exited 1: `claude-wrapper` selected the native Claude updater.
- `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib removed_provider_update_state_is_not_retained_or_reused -- --test-threads=1` exited 1: terminal publication left a retained `updateState` after removal.

## GREEN evidence

- Each of the five RED commands above exited 0 after its minimal production fix.
- `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib absent_target_verification_removes_update_state_while_settings_refresh_is_paused -- --test-threads=1` exited 0.
- `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib provider_maintenance -- --test-threads=1` exited 0.
- `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib provider_update -- --test-threads=1` exited 0, including provider-update scheduler coordination tests.
- `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_control provider_update -- --test-threads=1` exited 0.
- `node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib full_refresh_handoff_covers_settings_changed_after_its_final_snapshot -- --test-threads=1` exited 0.
- `vp check` exited 0: all 1,679 files formatted and no warnings/lint errors in 1,262 files.
- `vp run --filter bibcode typecheck` exited 0.
- `vp run typecheck` exited 0; existing Effect schema suggestions remained non-failing.
- `git diff --check` exited 0.
- A bounded `vp run --filter bibcode test` attempt exited 124 after 79.1 seconds, matching the previously documented Windows broken-stdin/process-runner broad-suite limitation. No focused regression failed, and no test process remained afterward.

## Changed files

- `apps/server/src/production/control.rs`
- `apps/server/src/production/provider_maintenance.rs`
- `apps/server/tests/production_control.rs`
- `.superpowers/sdd/2026-08-01-rust-provider-maintenance/whole-branch-fix-report.md`

## Scope and risks

- No automatic installation, scheduler expansion, UI change, `.repos/` edit, or `process_runner` change was made.
- The broad Windows suite remains bounded rather than complete because of the documented pre-existing hang; focused maintenance, update-control, RPC, scheduler, static, and type checks are green.
- The local worktree index remains on its stale parent and contains unrelated pre-existing formatter/UI changes. They were preserved and excluded from the implementation commit.
