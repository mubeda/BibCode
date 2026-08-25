# Quick Start

Install Vite+ and workspace dependencies first (see the root README), then use:

```bash
# Browser development with hot reload
vp run dev

# Tauri 2 desktop development with hot reload
vp run dev:desktop

# Desktop development on an isolated port set
BIBCODE_DEV_INSTANCE=feature-xyz vp run dev:desktop

# Build production web assets and the native Rust server
vp run build

# Serve the built web app from the native server
cargo run -p bibcode-server -- serve --static-dir apps/web/dist

# Host-native desktop installer
vp run dist:desktop:win     # Windows
vp run dist:desktop:dmg     # macOS
vp run dist:desktop:linux   # Linux

# Native CLI help from this checkout
cargo run -p bibcode-server -- --help

# In another terminal, create a five-minute pairing for a running server
cargo run -p bibcode-server -- auth pairing create --format human
```

`vp run build` writes the web client to `apps/web/dist`. The server does not
guess that directory: pass it with `--static-dir` when the native server should
serve the production web UI. Without `--static-dir` or a development URL, API
routes still run but browser UI requests return `503 Service Unavailable`.

Desktop development requires Rust and the platform prerequisites documented by
Tauri 2. On Windows, the package script enters the installed Visual Studio x64
build environment automatically.

Node.js is required when developing the React frontend and running repository
scripts. Packaged desktop applications and the native `bibcode` server do not
ship or require Node.js.

The pairing command uses the server's protected host-local socket or named pipe
and never falls back to HTTP. If the server uses a non-default data root, pass
the same absolute `--base-dir` used by `serve`. Treat its stdout as a secret.

## First run

1. [Install and authenticate a supported provider](./provider-setup.md) on the
   machine or environment running the BiBCode server.
2. Add a project from the left panel or Command Palette. The Add Project dialog
   can open one local folder, clone a Git URL, or create a new local project.
3. Pick the project's primary row to work in the live checkout, or use the
   project `+` action to create a worktree thread.
4. Use the chat header `+` menu to open another AI chat panel, a shell terminal
   in the same worktree, a provider CLI terminal, or a custom action.
5. Use the right panel's Browser, Terminal, Files, Diff, and Source Control
   surfaces. Activity and Plan surfaces appear when the active provider/session
   exposes them.

See [Workspace UI](../user/workspace-ui.md) for the full UI map.
