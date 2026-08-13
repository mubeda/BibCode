# Supported Provider Visibility Design

## Decision

BiBCode treats Codex, Claude, Cursor, and OpenCode as effective built-in
providers. Their default Settings cards are always rendered, independently of
provider-inventory readiness, installation state, authentication state, or an
explicit disabled setting. Those runtime states change the card status and
controls; they never remove the card.

Cursor is no longer presented as Early Access. New settings enable Cursor by
default and resolve its default executable as `cursor-agent`. Existing
persisted settings remain authoritative, including an explicit user choice to
disable Cursor. OpenCode remains enabled by default and has no preview badge.
Grok remains disabled and hidden because it is outside this supported default
set. This exclusion covers both provider cards and user-facing action surfaces:
the new-panel menu must not expose either a Grok chat action or a Grok Terminal
action, even when a legacy settings payload enables the driver.

## Ownership and data flow

- `packages/contracts` owns browser-safe provider setting defaults.
- `apps/server` owns persisted server-setting defaults and provider-inventory
  fallback definitions.
- `apps/web` owns permanent rendering of the four supported built-in cards,
  their presentation metadata, and the supported provider action model shared
  by panel/worktree entry points.
- Provider installation and authentication probes remain asynchronous server
  concerns. No synthetic “installed” or “authenticated” state is introduced.

## Compatibility

Changing the default applies only when the Cursor `enabled` value is absent.
Saved `false` values are preserved. Custom provider instances, binary paths,
environment variables, and session defaults are unchanged.

## Verification

Behavioral tests must prove:

1. the four supported cards render with an empty or partial live inventory;
2. Cursor and OpenCode expose no Early Access badge;
3. missing Cursor settings decode and persist as enabled with
   `cursor-agent`;
4. explicit Cursor `enabled: false` remains false;
5. provider inventory falls back to an enabled `cursor-agent` definition.
6. legacy-enabled Grok inventory never produces a chat or terminal action.

The final packaged v0.3.14 application must be visually verified with Codex
Computer Use, including the Providers panel, external-worktree adoption, and
thread/performance UI flows.
