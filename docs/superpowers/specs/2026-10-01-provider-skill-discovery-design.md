# Provider skill discovery by workspace and user configuration

Status: approved by the user on 2026-10-01.

## Requested outcome

Every supported AI provider's chat composer must show the skills available to
that provider from both the active repository/worktree and its user-level
configuration. User skills outside the repository are a primary requirement,
including a setup where the repository contains no skills at all.

The selected provider's native invocation and visibility rules apply. Codex uses
`$`; Claude, Cursor, and OpenCode use their native slash commands. Skills that
the provider deliberately disables or makes non-invocable must not become
selectable commands. When a provider resolves two definitions to one invocation
name, preserve its precedence rather than inventing a second invocation.

This covers Codex, Claude, Cursor, and OpenCode. Grok is currently disabled by
the server and remains disabled; this change does not advertise an unsupported
provider as usable.

## Evidence

- `production/control.rs` probes capabilities with the server process's current
  directory. `ChatComposer.tsx` reads skills from that environment-wide provider
  snapshot, without the active workspace in its identity.
- Codex receives that directory in `skills/list`. Its discovery subprocess also
  does not set its working directory explicitly. Native chat launch already
  resolves the thread's worktree or project root correctly.
- Codex inventory does not apply the same configured home/shadow-home setup as
  session launch. Correcting only the workspace would leave a user-level gap.
- Cursor's filesystem discovery skips symlinked skill directories, only scans
  one directory level, and omits the Claude/Codex compatibility skill roots.
- OpenCode inventory requests do not carry the session's `directory` query
  parameter. Its native `/command` catalog includes skill commands with
  `source: "skill"`; BiBCode currently drops that classification.

## Alternatives and decision

1. Change the global inventory's directory when a chat becomes active. Small
   patch, but concurrent projects overwrite one another's capabilities and a
   server may serve several clients. Rejected.
2. Scan every provider's user and project directories with one generic scanner.
   Avoids provider startup, but duplicates plugin, config, naming, visibility,
   and precedence rules and cannot discover a remote OpenCode server's files.
   Rejected.
3. Add a workspace-scoped capability query, reusing native discovery and the
   existing client-runtime query cache. Recommended. It preserves provider
   ownership and adds one shared route rather than a different UI path for each
   provider.

## Ownership and data flow

Add typed `server.getProviderCapabilities({ instanceId, cwd })` through the
existing HTTP/WebSocket RPC infrastructure. Its result contains the existing
`slashCommands`, `skills`, and `agents` contract shapes, plus discovery issues
when a native provider returns a usable partial catalog. Discovery failures
use a typed error rather than an authoritative empty list.

`apps/server` validates the enabled instance and existing absolute directory,
resolves the server-owned provider configuration, and performs discovery. The
request cannot override the executable, user home, endpoint, credentials, or
environment. Use the same effective executable/environment/home policy as
session launch, reusing the existing Codex home resolver and preparation.
Secrets remain server-side. For remote environments, both repository and user
skills come from that environment; local machine skills are not substituted.

`packages/client-runtime` owns the query through its existing environment query
family. Identity includes environment, provider instance, and workspace.
`apps/web` supplies the active chat/draft workspace and consumes that catalog
for menu entries and inline skill metadata. Ordinary provider status and model
inventory remain environment-wide; a workspace query must never overwrite them.

## Provider discovery

- **Codex:** initialize a supervised App Server in the target workspace and
  request `skills/list` for that workspace, retaining all returned enabled
  user, repository, system, and plugin skills. Use the instance's effective
  Codex home, including shared/shadow-home preparation. Skill discovery must
  not depend on a successful model or account inventory request.
- **Claude:** reuse the native initialization and `reload_skills` protocol with
  user/project/local settings enabled, the target working directory, and the
  effective provider environment, including `CLAUDE_CONFIG_DIR`. Preserve plugin
  names and native visibility. Keep the existing hook-disabled metadata probe;
  discovery sends no model prompt.
- **Cursor:** reuse its server-side scanner and effective home resolution. Cover
  `.cursor/skills`, `.agents/skills`, `.claude/skills`, and `.codex/skills` in both
  project and user scopes. Traverse nested skill folders and follow skill-folder
  symlinks, with canonical visited-directory tracking to stop cycles. Stay
  within skill roots and the applicable workspace ancestry rather than scanning
  the user's entire home or unrelated repositories. Preserve deterministic
  project/user precedence and one effective entry per invocation name. Missing
  optional roots are normal; unreadable roots and incomplete scans are reported.
- **OpenCode:** request native command/agent catalogs with the same encoded
  `directory` parameter used by session traffic, for both locally launched and
  configured endpoint servers. Classify `source: "skill"` as a slash skill and
  keep ordinary commands distinct. Preserve the native catalog's user/project
  union and collision decisions; use provider-qualified skill identities when
  the response does not expose a filesystem location.

No dependency, production Node runtime, separate filesystem index, or duplicate
provider parser is introduced where a native catalog already exists.

## Freshness, failures, and resource ownership

Reuse the existing query family's finite stale time, idle eviction, shared
in-flight request, and environment connection lifecycle. Load for the active
composer context; refresh stale data when the menu is opened. Provider refresh,
settings changes, and reconnection invalidate the relevant catalog. Searching
within an already loaded menu is local and does not spawn providers per keypress.

A response for a previous workspace, provider, settings generation, or connection
must not populate the current context. Keep successful data only for the same
context while it refreshes. Show loading and actionable failure/retry feedback;
do not label an unavailable or partially loaded catalog as having no skills.
Preserve the draft and selected inline skills through refresh/failure.

Discovery uses the existing supervised subprocess and HTTP owners, bounded
timeouts, and cancellation cleanup. Success, error, timeout, client cancellation,
and server shutdown must reap discovery children. File traversal must yield and
honor cancellation. No workspace/user skill content is copied into the repository
or persisted as a second catalog.

## Completion evidence

Hermetic tests use temporary user homes and workspaces, fake provider protocols,
and local HTTP fixtures. They do not run the developer's real provider CLIs.

1. Each supported provider returns a user-only skill, a repo-only skill, and
   both together; an empty repo must retain the full user catalog.
2. Two workspaces retain common user skills and their own distinct repo skills,
   including simultaneous composers and out-of-order discovery responses.
3. Configured provider homes/environments, Codex shadow homes, and remote
   OpenCode directory selection use the selected instance's context.
4. Cursor finds symlinked and nested user skills plus compatibility roots;
   cycles, broken links, and unreadable roots do not hang or silently claim a
   complete catalog. Native name precedence remains deterministic.
5. Provider-specific triggers, hidden/disabled skills, plugin names, command
   collisions, refresh, reconnect, failures, and process cleanup are covered at
   their closest behavioral seams.
6. Run contract fixture/parity checks, focused Rust/client/web tests, appropriate
   package checks, `vp check`, `vp run typecheck`, Rust formatting, and affected
   Clippy targets with warnings denied. Review changed React against
   `vercel-react-best-practices` if available and report if unavailable; review
   the interaction against `UI.md`.
7. Update living provider/RPC documentation and shared native testing procedures
   with user-only and combined-scope validation. Record execution-specific
   results separately. Finish with a diff/status review.

## Upstream references

- [Cursor skill directories and nested skills](https://prod.cursor.com/docs/skills)
- [Claude skill locations and visibility](https://code.claude.com/docs/en/skills)
- [OpenCode skill locations](https://opencode.ai/docs/skills)
- [OpenCode native command catalog, v1.18.34](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/command/index.ts)

These references guide provider compatibility. Current source, installed native
protocols, and hermetic regression fixtures must verify implementation details.
