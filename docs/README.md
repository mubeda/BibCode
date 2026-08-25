# Documentation

This index points to the living documentation for the current Rust/Tauri 2
application. Dated plans, specifications, dependency reports, and performance
measurements preserve implementation history; they are not authoritative for
current behavior.

## Start here

- [Quick start](./getting-started/quick-start.md)
- [Workspace UI](./user/workspace-ui.md)
- [Provider setup](./providers/README.md)
- [Remote access](./user/remote-access.md)
- [Server administration](./user/server-administration.md)
- [Architecture overview](./architecture/overview.md)

## User guides

- [Workspace UI](./user/workspace-ui.md)
- [Keybindings](./user/keybindings.md)
- [Remote access](./user/remote-access.md)
- [Server administration](./user/server-administration.md)
- [Project data safety and recovery](./guides/project-data-recovery.md)
- [Source control providers](./integrations/source-control-providers.md)

## Provider guides

- [Provider setup and capabilities](./providers/README.md)
- [Codex](./providers/codex.md)
- [Claude](./providers/claude.md)
- [OpenCode](./providers/opencode.md)
- [Cursor](./providers/cursor.md)

## Architecture

- [Overview](./architecture/overview.md)
- [Provider architecture](./architecture/providers.md)
- [Activity observation](./architecture/activity-observation.md)
- [Worktree catalog](./architecture/worktree-catalog.md)
- [RPC and orchestration](./architecture/rpc-and-orchestration.md)
- [Connection runtime](./architecture/connection-runtime.md)
- [Runtime modes](./architecture/runtime-modes.md)
- [Remote environments](./architecture/remote.md)
- [Authentication](./architecture/authentication.md)
- [Runtime and process model](./architecture/runtime-process-model.md)

## Cloud and environment authentication

- [BiBCode Connect](./cloud/bibcode-connect-clerk.md)
- [Environment authentication](./cloud/environment-auth.md)
- [Connect authentication flow](./cloud/bibcode-connect-auth-flow.md)

## Operations and reference

- [Testing runbooks](./testing/README.md)
- [Continuous integration](./operations/ci.md)
- [Release process](./operations/release.md)
- [Observability](./operations/observability.md)
- [Effect.fn checklist](./operations/effect-fn-checklist.md)
- [Encyclopedia](./reference/encyclopedia.md)
- [Workspace layout](./reference/workspace-layout.md)
- [Repository scripts](./reference/scripts.md)

## Historical material

- [`plans/`](./plans/README.md) contains dated design documents and plans.
- [`superpowers/`](./superpowers/README.md) contains completed planning and
  specification artifacts.
- [`dependency-upgrades/`](./dependency-upgrades/README.md) contains dated
  dependency reports and the ledger used by repository tooling.
- [`architecture/measurements/`](./architecture/measurements/README.md)
  contains dated performance measurements. The current baseline remains in
  [Desktop performance baseline](./architecture/desktop-performance-baseline.md).
