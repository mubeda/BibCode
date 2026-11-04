# Codex MCP Registration Collision (#273)

Status: Approved by Mauro 2026-11-02 (option A; Codex review rounds 1-3). Design for issue 273,
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

| Home       | `-c` overrides                                                            | Result                                                                                        |
| ---------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| registered | `bibcode.url`, `bibcode.bearer_token_env_var` (today)                     | `-32600: failed to load configuration: url is not supported for stdio in mcp_servers.bibcode` |
| empty      | same                                                                      | `thread/start` OK                                                                             |
| registered | none                                                                      | `thread/start` OK                                                                             |
| registered | `mcp_servers.bibcode={url=…,bearer_token_env_var=…}` (whole inline table) | the same `-32600`: an inline table is merged too                                              |
| registered | `bibcode_thread.url`, `bibcode_thread.bearer_token_env_var`               | OK                                                                                            |
| registered | `bibcode.enabled=false` plus the `bibcode_thread` pair                    | OK                                                                                            |
| empty      | `bibcode.enabled=false`                                                   | the process exits before `initialize`: `invalid transport in mcp_servers.bibcode`             |

So no `-c` spelling can replace or delete the user's `bibcode` table. Any fix of
the collision changes a key name or which entry wins, which is why this needs
approval.

## Options

The two servers are not duplicates. The per-thread server's credential is a
provider credential, which lists only this thread's `preview_*` and `device_*`
tools; the registered relay is a client credential with the thread, Git, file
and other client tools (`connect_mcp/tests.rs`, the provider/client `tools/list`
assertions; `mcp/control.rs` scope docs). A registered user needs both in a
Codex chat.

**A. Own key for the per-thread server; the registered entry is untouched
(recommended).**

- The chat launch writes its server as `mcp_servers.bibcode_thread.url` and
  `mcp_servers.bibcode_thread.bearer_token_env_var`. No registration or user
  entry BiBCode writes uses that key, so the merge cannot happen, whatever the
  user, a project config or a profile holds under `bibcode`.
- BiBCode reads no Codex config and adds no `enabled=false`. There is no
  decision to race with a registration change, and Codex's own loading of
  `bibcode` is unchanged.
- What changes for people: in a Codex chat the per-thread preview and device
  tools appear under the server name `bibcode_thread`; the registered `bibcode`
  tools keep their name. Nothing in BiBCode's prompts, skills or living docs
  names the per-thread server. The terminal, other providers, the registration
  and what it writes do not change.
- Residual: a user who hand-writes a `[mcp_servers.bibcode_thread]` table hits
  the same merge. That key is documented as BiBCode's own in
  `docs/reference/mcp.md`, and the delivery fails visibly (part 1 below) rather
  than silently.

**B. Skip the per-thread server when a user `bibcode` entry exists.** Chat then
loses this thread's preview and device tools, BiBCode must read Codex's config
before each launch (racing a registration change), and the trap stays for the
next override BiBCode adds under `bibcode`. Not recommended.

Turning the registered entry off for chat launches (`bibcode.enabled=false`)
was considered and dropped: it removes the client tools above, and on an absent
entry Codex refuses to start, so a registration removed between BiBCode's read
and Codex's load would break a valid configuration.

**C. Register under another name (`bibcode-desktop`) and migrate existing
entries.** Changes what registration writes in five clients' config files, needs
a migration of entries already written by 0.14.0, and still collides with an
entry the user added by hand as `bibcode`. Not recommended.

## Parts that do not depend on the option

These keep registration as it is and follow the issue's scope.

1. **Config-load errors are permanent.** A Codex launch whose `thread/start`
   (or `thread/resume`) fails with JSON-RPC `-32600` and a message starting
   `failed to load configuration` becomes a new
   `ProviderRuntimeError::ProviderConfiguration { provider, detail }`.
   `launch_failure_outcome` maps it to `Rejected { detail }`, like
   `MissingExecutable`, so the delivery fails once through the existing path:
   `failure_reason` keeps its typed category, and Codex's message, followed by
   what to do (fix `~/.codex/config.toml`, or turn off BiBCode's MCP server), is
   the delivery detail (`last_error`, `delivery.detail`) the panel already
   shows. No persisted shape changes.
   - An `app-server` that exits before answering `initialize` is not classified
     from its stderr: stdout's end can be read before the stderr diagnostic, so
     the verdict would depend on ordering. That case stays transient and is
     ended by the attempt bound (part 2), whose detail is the last error.
   - **MCP output (additive).** `read_thread` gains `failedDelivery`: `null`, or
     `{ "messageId", "detail" }` for the thread's oldest failed delivery, read
     from `provider_turn_outbox` whether or not a session row exists.
     `wait_for_thread` fills its existing `error` field from that detail when it
     reports `delivery_failed` (today it does so only for `error`). Both are
     documented in `docs/reference/mcp.md`; old clients ignore the new field.
2. **Retries are bounded.** A delivery that keeps ending `DefinitelyNotSent`
   fails after 20 attempts (about 8 minutes with the 30 s backoff cap) with the
   last error as its reason, so an unrecognised deterministic failure can no
   longer launch processes without limit. A manual Retry starts the count again.
   Transient failures that clear sooner are unaffected.
   - **Restart recovery.** A delivery left `sending` by a crash is reconciled
     on restart, and today a Codex launch error there becomes `Unavailable`,
     which keeps the row `sending` and retries without limit or attempt count
     (`turn_delivery.rs`, `recover_sending`). A reconciliation launch that fails
     with `ProviderConfiguration` instead gets its own outcome and moves the row
     to `Uncertain` with the detail: whether the original send reached Codex is
     unknown, so nothing is sent again automatically, and the existing Retry and
     Dismiss actions decide. Other `Unavailable` cases keep today's behaviour.
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
     and the launch arguments name only `bibcode_thread`, never `bibcode`.
   - The provider credential's `tools/list` through `bibcode_thread` still
     lists the preview and device tools (the existing scope test, kept).
   - A config-load `-32600` ends the delivery `failed` with the reason visible
     through the thread read, `read_thread` (`failedDelivery`) and
     `wait_for_thread` (`error`), on a fresh thread with no session row.
   - An `app-server` that exits before `initialize`, with or without a config
     message on stderr, stays transient and is failed by the attempt bound.
   - The attempt bound fails a delivery after the twentieth `DefinitelyNotSent`.
   - Restart with a persisted `sending` row and a config-load failure: the row
     becomes `Uncertain` with the detail after one launch, and no send repeats.

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

## Review findings and resolutions

Codex, round 1 (REVISE):

- P1, disabling the registered entry removes the client tools: accepted.
  Verified in `connect_mcp/tests.rs` (a provider lists only `preview_*` and
  `device_*`). Option A no longer touches the registered entry.
- P2, Codex's text belongs in the delivery detail, not `failure_reason`:
  accepted; part 1 uses the existing `Rejected { detail }` path.
- P2, the config read races a registration removal: resolved by dropping the
  config read and `enabled=false` altogether.

Codex, round 2 (REVISE):

- P2, `read_thread` and `wait_for_thread` cannot report a failed delivery's
  reason: accepted. Verified at `mcp/wait.rs` (`error` only for `error`) and
  `mcp/tools/threads.rs` (session row only). Part 1 adds `failedDelivery` and
  fills `error` for `delivery_failed`, with a fresh-thread test.
- P2, classifying an early exit from stderr races stdout's end: accepted. Early
  exits are no longer classified; the attempt bound ends them, with a test.

Codex, round 3 (REVISE, final round):

- P2, restart recovery of a `sending` row bypasses classification and the
  bound: accepted and verified in `recover_sending`. Added the recovery bullet
  and its restart test.
