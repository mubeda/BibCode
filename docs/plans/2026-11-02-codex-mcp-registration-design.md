# Codex MCP Registration Collision (#273)

Status: Proposed 2026-11-02, awaiting the maintainer's approval. Design for issue 273,
verified against `main` at `fd98b4330` with codex-cli 0.166.0.

## Problem

A Codex chat launch adds BiBCode's per-thread MCP server as two `-c` overrides
(`apps/server/src/production/provider_runtime.rs`, Codex `launch`):

    -c mcp_servers.bibcode.url=<endpoint>
    -c mcp_servers.bibcode.bearer_token_env_var="BIBCODE_MCP_BEARER_TOKEN"

One-click registration (`mcp_client_registration`, `SERVER_NAME = "bibcode"`)
runs `codex mcp add bibcode -- <bibcode> mcp --base-dir <home>`, which writes a
user-level stdio server under the same key. Codex merges the overrides into that
table, so it holds `command`, `args` and `url` at once, and Codex refuses its
whole configuration on `thread/start`. Turn delivery treats that as transient,
retries forever, and the thread reads `idle`.

## Reproduction (evidence)

An isolated `CODEX_HOME` per case, never the user's own `~/.codex`. A Node
script starts `codex app-server` with the given `-c` arguments and sends
`initialize`, `initialized` and `thread/start`. The registered home holds only
the table that `codex mcp add` writes:

    [mcp_servers.bibcode]
    command = "bibcode-desktop"
    args = ["mcp", "--base-dir", "/nonexistent"]

| Home | `-c` overrides | Result |
|---|---|---|
| registered | `bibcode.url`, `bibcode.bearer_token_env_var` (today) | `-32600: failed to load configuration: url is not supported for stdio in mcp_servers.bibcode` |
| empty | same | `thread/start` OK |
| registered | none | `thread/start` OK |
| registered | `mcp_servers.bibcode={url=…,bearer_token_env_var=…}` (whole inline table) | the same `-32600`: an inline table is merged too |
| registered | `bibcode_thread.url`, `bibcode_thread.bearer_token_env_var` | OK |
| registered | `bibcode.enabled=false` plus the `bibcode_thread` pair | OK |
| empty | `bibcode.enabled=false` | the process exits before `initialize`: `invalid transport in mcp_servers.bibcode` |

So no `-c` spelling can replace or delete the user's `bibcode` table. Any fix of
the collision changes a key name or which entry wins, which is why this needs
approval.

## Options

**A. Own key for the per-thread server, and turn off a registered `bibcode` for
chat launches (recommended).**

- The chat launch writes its server as `mcp_servers.bibcode_thread.*`. No user
  entry or registration uses that key, so the collision cannot recur, whatever
  the user, a project config or a profile holds under `bibcode`.
- When the effective `CODEX_HOME/config.toml` defines `[mcp_servers.bibcode]`,
  the launch also passes `-c mcp_servers.bibcode.enabled=false`. Without it, chat
  would load both servers: duplicate tool sets, an extra `bibcode mcp` relay per
  session, and tools that are not attributed to the thread, so a child thread
  started through them is not linked to its parent. The flag is added only when
  the table was found, because on an absent entry Codex refuses to start (last
  row above). A `bibcode` entry that only a project config or profile defines is
  not detected; chat then gets the duplicate, which still works.
- What changes for people: in a Codex chat the BiBCode tools appear under the
  server name `bibcode_thread`. The terminal, other providers, the registration
  and what it writes do not change. The user's own `bibcode` entry keeps working
  everywhere except inside BiBCode's own Codex chats, where the per-thread
  server replaces it.
- Cost: one read and TOML parse of a small file per Codex chat launch, with the
  `toml` workspace dependency added to `bibcode-server`. A missing, unreadable
  or unparsable file counts as "not found" and is logged at debug level.

**B. Skip the per-thread server when a user `bibcode` entry exists.** Smallest
code change, but chat then uses the user's stdio relay: no per-thread
attribution or parent link, and the access level is the relay's rather than the
thread's. It also keeps the trap for the next override BiBCode adds under
`bibcode`. Not recommended.

**C. Register under another name (`bibcode-desktop`) and migrate existing
entries.** Changes what registration writes in five clients' config files, needs
a migration of entries already written by 0.14.0, and still collides with an
entry the user added by hand as `bibcode`. Not recommended.

## Parts that do not depend on the option

These keep registration as it is and follow the issue's scope.

1. **Config-load errors are permanent.** A Codex launch that fails with
   JSON-RPC `-32600` whose message starts with `failed to load configuration`,
   or an `app-server` that exits before answering `initialize` with a config
   error on stderr, becomes a new `ProviderRuntimeError::ProviderConfiguration
   { provider, detail }`. `launch_failure_outcome` maps it to `Rejected`, like
   `MissingExecutable`, so the delivery fails once with Codex's own message as
   `failure_reason` and the thread shows `delivery_failed`. The panel shows the
   message and what to do (fix `~/.codex/config.toml`, or turn off BiBCode's
   MCP server). `read_thread` and `wait_for_thread` report the same failed state
   and reason that the panel shows, with a contract test each.
2. **Retries are bounded.** A delivery that keeps ending `DefinitelyNotSent`
   fails after 20 attempts (about 8 minutes with the 30 s backoff cap) with the
   last error as its reason, so an unrecognised deterministic failure can no
   longer launch processes without limit. A manual Retry starts the count again.
   Transient failures that clear sooner are unaffected.
3. **Profiler.** A new `delivery.failing` finding, recorded once per delivery
   when it is rejected for a provider configuration error or reaches the attempt
   bound. Fields: provider, attempts, a redacted error class
   (`provider-configuration`, `attempts-exhausted`). It never carries the error
   text, a path or a thread title. Documented in
   `docs/skills/bibcode-profiler/references/findings.md` and the overview's
   Profiler section. Each rejection also logs `tracing::warn!`.
4. **Tests.**
   - A contract test starts the real Codex launch path against a fake
     `codex` that, like Codex 0.166.0, rejects a `bibcode` table holding both
     `command` and `url`, with a `CODEX_HOME` holding a registered stdio
     `bibcode` and BiBCode's MCP enabled, and asserts `thread/start` succeeds
     and the launch arguments use `bibcode_thread` and `bibcode.enabled=false`.
   - Without the registered entry, no `enabled=false` is passed.
   - A config-load `-32600` ends the delivery `failed` with the reason visible
     through the thread read, `read_thread` and `wait_for_thread`.
   - The attempt bound fails a delivery after the twentieth `DefinitelyNotSent`.

## Not in scope

- **OpenCode sibling.** The OpenCode runtime also registers a server named
  `bibcode` at runtime. Whether OpenCode merges or replaces the user's entry is
  checked during implementation. If it collides, the same treatment is applied
  in this PR; if it does not, the check is reported in the PR.
- Codex's own validation message and behaviour.

## Validation

- The reproduction script above, rerun against the fixed launch arguments with
  real codex-cli 0.166.0 and a registered home: `thread/start` succeeds.
- Focused Rust tests for the launch arguments, classification, attempt bound and
  thread reads; `cargo fmt --all --check`, Clippy with warnings denied,
  `vp check` and `vp run typecheck`. A web test for the panel's failure copy, with
  the UI.md and `vercel-react-best-practices` reviews.
