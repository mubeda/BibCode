# Approved Left-Panel Mockups

These wireframes preserve the approved interactive mockup rather than defining
pixel-perfect styling. Existing BiBCode typography, spacing, theme tokens, and
center-workspace components remain the visual source of truth.

## Normal Online State

```text
┌─ BiBCode ─────────────────────┐┌─ ENVIRONMENTS / THIS MAC · LUMEN ───────────┐
│ Search environments…         ││ This Mac · Lumen                    PRIMARY │
│                              ││ Canonical host: lumen.local                 │
│ ENVIRONMENTS                 ││ ● Online · BiBCode 0.8.0 · macOS arm64     │
│ ▼ ● This Mac · Lumen      •••││                                             │
│   ▼ ▣ BiBCode              3 ││ Overview  Connection  Service  Security     │
│       ◉ Main             main││ Projects & storage  Updates  Diagnostics    │
│       ○ Sidebar polish       ││                                             │
│       ⑂ environment-mgmt  wt ││ ┌ Identity ┐ ┌ Active route ┐               │
│   › ▣ Logbert              2 ││ │ env UUID │ │ Loopback     │               │
│ › ● WSL · Ubuntu      running││ └──────────┘ └──────────────┘               │
│ › ● Build PC             •••││ ┌ Projects ┐ ┌ Security ────┐               │
│ › ◌ Studio Mac       offline││ │ 2 / 5    │ │ 1 admin      │               │
│ › ◐ WSL · Debian      stopped││ └──────────┘ └──────────────┘               │
└──────────────────────────────┘└─────────────────────────────────────────────┘
```

Key behavior:

- All non-hidden environments stay visible.
- Only the selected path initially expands; later launches restore exact state.
- Caret expands; selecting the environment name opens the center overview.
- Main, ordinary threads, and worktree threads remain one flat project list.
- Center tabs/panels do not leak into the left tree.

## Offline Cached State

```text
┌─ BiBCode ─────────────────────┐┌─ STUDIO MAC / DESIGN SYSTEM / TOKEN MIGRATION
│ Search environments…         ││ ⚠ Offline · read-only cache                │
│                              ││ Last synchronized 18 minutes ago.           │
│ › ● This Mac · Lumen         ││                                             │
│ ▼ ◌ Studio Mac        offline││ Token migration                             │
│   ▼ ▣ Design System    cached││ Cached conversation · content may be stale │
│       ◉ Main                 ││                                             │
│       ○ Token migration      ││ [cached messages remain readable]           │
│       ⑂ new-icons   metadata ││                                             │
│   › ▣ Marketing       cached ││ Read-only until identity-verified reconnect │
│ › ● Build PC                 ││ Create turn/thread/terminal/worktree: off   │
└──────────────────────────────┘└─────────────────────────────────────────────┘
```

The tree does not disappear. Cached content is explicitly stale/read-only and
no mutation is queued invisibly.

## Global Search State

```text
┌─ Search: auth ────────────────┐┌─ SEARCH / AUTH ─────────────────────────────┐
│ 5 RESULTS                    ││ Matches retain ownership ancestry.          │
│ ▼ ● This Mac · Lumen         ││                                             │
│   ▼ ▣ BiBCode                ││ WORKTREE   auth-refactor                    │
│       ⑂ [auth]-refactor      ││            This Mac / BiBCode               │
│ ▼ ● WSL · Ubuntu             ││ THREAD     Pairing authentication           │
│   ▼ ▣ API Server             ││            WSL Ubuntu / API Server          │
│       ○ Pairing [auth]       ││ PATH       /src/auth/session.rs             │
│ ▼ ◌ Studio Mac       offline││            WSL Ubuntu / API Server          │
│   ▼ ▣ Design System         ││ CACHED     OAuth review                     │
│       ○ OAuth review  cached││            Studio Mac / Design System      │
└──────────────────────────────┘└─────────────────────────────────────────────┘
```

Search never creates a global repository group and never strips the matching
thread from its environment/project context.

## Offline Force-Removal State

```text
┌──────────────── Remove Studio Mac? ──────────────────────┐
│ Choose exactly what BiBCode should remove.               │
│                                                          │
│ ○ Hide from sidebar                                      │
│   Reversible; keeps credentials, cache, routes, settings.│
│                                                          │
│ ● Fully remove from this client                          │
│   Deletes this client's routes, secrets, cache, metadata.│
│                                                          │
│ ⚠ Studio Mac is offline. BiBCode cannot uninstall its    │
│   server or delete remote data. The server may continue  │
│   running; projects/worktrees and other clients remain.  │
│                                                          │
│ □ Force remove while offline                             │
│   Type “Studio Mac” on the next step.                    │
│                                                          │
│ □ Uninstall remote server              [unavailable]     │
│                                      Cancel  Force remove│
└──────────────────────────────────────────────────────────┘
```

When online, the same wizard independently offers unchecked Uninstall server
and Delete remote data choices. Deleting data requires a second typed-name
confirmation and fresh versioned removal plan.

## Status Legend

```text
● Online                  ◌ Offline
◐ Connecting/Reconnecting ◐ Updating
! Authentication required ! Version incompatible
■ Stopped (WSL)           ↓ Setup required
```

Actual implementation uses icon, text, and accessible name as well as color.
