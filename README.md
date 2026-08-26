# BiBCode

BiBCode is a web and Tauri 2 desktop GUI for coding agents. The current provider
drivers are Codex, Claude, OpenCode, and Cursor (Early Access).

This project is maintained in the public [mubeda/BibCode repository](https://github.com/mubeda/BibCode).

## Technology

- Desktop: Tauri 2 with a Rust host and the operating system WebView.
- Frontend: React 19, Vite, TypeScript, TanStack Router, Zustand, and Effect.
- Application server: Rust with Axum and Tokio, embedded in the desktop process
  and available as the native `bibcode` headless server.
- Transport: typed WebSocket/RPC contracts shared by browser and desktop clients.

The React frontend is shared unchanged between browser and desktop modes. Tauri-specific behavior is
kept behind `window.desktopBridge`. Production builds contain no Electron,
Node.js runtime, or TypeScript server.

## Origins and acknowledgements

BiBCode began as a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). It has since
been substantially rewritten: the original Electron and Node.js runtime was replaced by a Rust
application server and a Tauri 2 desktop host. BiBCode is now a Rust/Tauri application and does not
ship Electron or a production Node.js runtime.

BiBCode also uses code and ideas from [stablyai/orca](https://github.com/stablyai/orca), alongside
workflow inspiration from [Conductor](https://conductor.build/). We are deeply grateful to the
maintainers and contributors of T3 Code and Orca. Their important open-source work made BiBCode
possible and continues to help shape it.

## Installation

> [!WARNING]
> Install and authenticate at least one configured provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Desktop app

Download the latest desktop build for your platform from
[GitHub Releases](https://github.com/mubeda/BibCode/releases):

- macOS: `.dmg` (Apple Silicon `arm64` or Intel `x64`)
- Windows: `.exe` installer (x64)
- Linux: `.AppImage` (x64)

Desktop releases are built by the Tauri 2 pipeline in `apps/desktop`.

> [!NOTE]
> macOS releases are ad-hoc signed without an Apple Developer identity or
> notarization. On first launch, macOS will block the app; open System Settings
> → Privacy & Security and choose **Open Anyway** for BiBCode. For local testing,
> the quarantine flag can instead be removed with
> `xattr -dr com.apple.quarantine "/Applications/BiBCode.app"`.
> Windows releases remain unsigned; choose "More info" → "Run anyway" if
> SmartScreen warns.

### Server-only packages

Use a server-only package when an environment should own its projects,
worktrees, provider processes, and data on a Windows, macOS, or Linux host.
Releases provide Windows MSI/ZIP, macOS PKG/tar.gz, and Linux DEB/RPM/tar.gz
artifacts for the supported architectures. The package contains the native
Rust server and browser assets; it does not require Node.js, Tauri, or the
desktop app at runtime.

Read [Server-only installation](./docs/getting-started/server-installation.md)
before installing. It covers signed-manifest verification, platform paths,
workstation/headless service modes, upgrades, uninstall-with-data-preservation,
and the separate irreversible purge flow.

### Run from source

See [Getting started](./docs/getting-started/quick-start.md), or jump to the
[contributor setup](#if-you-really-want-to-contribute-still-read-this-first)
below to install the toolchain and run the app locally.

Source development uses Node.js only for frontend and repository tooling. It is
not shipped as part of the application runtime.

## Current UI

BiBCode is organized around three work areas:

- The left panel is a navigation-only **Environment → Project → Main/threads**
  tree. An environment owns its projects; the same repository family cannot be
  added twice in one environment, while copies on different environments are
  separate projects. Use the tree to select work, add projects, and create or
  adopt worktree threads. It does not host settings tabs or information panels.
- The center panel hosts chats, terminals, and environment-management
  workspaces. Environment Overview, Connection, Service, Security, Projects &
  Storage, Updates, Diagnostics, and Removal appear as center tabs. Up to four
  split panes can share a worktree while keeping their agent sessions isolated.
- The right panel hosts Browser, Terminal, Diff, Activity, Plan, Files, and
  Source Control tools. Source Control supports staging, commit history, AI
  commit messages, per-file actions, and pull/push/PR flows. Files supports
  context menus, create/rename/delete/duplicate, external open/preview, and
  explicit Ctrl/Cmd+S saves.

See [Environments](./docs/user/environments.md),
[Environment navigation](./docs/user/environment-navigation.md), and
[Workspace UI](./docs/user/workspace-ui.md) for the detailed model.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

There's no public docs site yet, so start with the [documentation index](./docs/README.md).

## Documentation

- [Documentation index](./docs/README.md)
- [Getting started](./docs/getting-started/quick-start.md)
- [Server-only installation](./docs/getting-started/server-installation.md)
- [Environments](./docs/user/environments.md)
- [Workspace UI](./docs/user/workspace-ui.md)
- [Source Control](./docs/integrations/source-control-providers.md#source-control-panel)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/README.md)
- [Operations](./docs/operations/ci.md)
- [Server administration](./docs/operations/server-administration.md)
- [Reference](./docs/reference/encyclopedia.md)

## If you REALLY want to contribute still.... read this first

### Install `vp`

BiBCode uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp install
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

BiBCode has no telemetry or crash-upload path. Normal application traffic goes
only to an explicitly selected local, WSL, SSH-tunneled, or HTTPS environment;
plain non-loopback HTTP is forbidden.
