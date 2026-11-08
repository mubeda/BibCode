# Git Manager Sign-In on a Local Desktop

Status: Proposed — awaiting Codex + advisor review.

Issue #325, a follow-up of #283
([`2026-11-07-checkpoint-git-isolation-design.md`](./2026-11-07-checkpoint-git-isolation-design.md),
"Authentication and prompts" and its question 1). Verified at `c079af0048` (`main` at
`e222d340ff` plus the accepted #283 branch), on macOS with Git 2.56.0. Line references are
to that commit. No product code is written until this design is approved.

## Goal

On a local desktop server, a fetch, pull or push that the person starts from the Git
Manager may open the system credential manager's sign-in. Background Git (bootstrap fetch,
watchers, automatic fetch, checkpoints) and agent-driven Git (the `/mcp` Git tools) never
prompt. A remote server, including a desktop-owned WSL server, never prompts.

Acceptance, from the issue: this note is approved first; then tests for each mode.

## Decisions

1. **Who may prompt.** The call must come from the desktop app's own session, whose
   principal subject is `DESKTOP_BOOTSTRAP_SUBJECT`. That is the predicate
   `Claimant::of` already uses to let only the desktop serve a diagnostics relay
   (`production/diagnostic_logs_relay.rs:326`), whatever the session's scopes. No request
   field and no header mark a call as person-initiated, because any caller can set those.
2. **Where it may prompt.** The server must be the desktop's in-process backend. A new
   `ServerConfig::interactive_git_sign_in: bool` defaults to `false`; only the desktop's
   `server_config_for_launch` (`apps/desktop/src-tauri/src/backend.rs:2290`), which builds
   the in-process configuration, sets it. No CLI flag or bootstrap JSON key sets it.
3. **Which operations.** `fetch`, `pull`, `push`, `publish-branch` and `force-push` of
   `gitManager.runOperation`. Nothing else changes.
4. **When it prompts.** Never on the first attempt. The first attempt runs with today's
   guards. Only when it fails because Git Credential Manager (GCM) needed to ask, and the
   call passes decisions 1 to 3, does the server run the same Git command once more without
   `GCM_INTERACTIVE=never`.
5. **What the person sees.** Before the retry the stream sends a new
   `awaiting-sign-in` event, and the operation banner asks the person to finish signing in,
   with Cancel.
6. **How it ends.** Cancel, losing the connection, losing the workspace and server shutdown
   kill the Git process group or Windows Job, and GCM's window with it. There is no separate
   sign-in deadline (see [Timeouts](#timeouts)).

## Current behaviour

- Every Git Manager command builds `git_environment()` (`git/repository.rs:7903`), which
  starts from `prompt_guard_environment()` (`:7922`): `GCM_INTERACTIVE=never`,
  `GIT_ASKPASS=`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS=`, `SSH_ASKPASS_REQUIRE=never`,
  `LC_ALL=C`, `LANG=C`, plus the curated `GIT_CONFIG_SYSTEM` file from #283.
- `git_manager_fetch` (`:4410`), the network step of `git_manager_pull` (`:4451`, after two
  `git config --get` reads) and `git_manager_push` (`:4488`) run on
  `for_network_transfer()` (`:370`): a 24-hour runaway bound
  (`NETWORK_TRANSFER_TIMEOUT`, `git/mod.rs:98`), Git's HTTP stall guard
  (`http.lowSpeedLimit=1000`, `http.lowSpeedTime=60`, `:54`) and Cancel.
- `gitManager.runOperation` is registered with `register_stream`
  (`production/git_manager_rpc.rs:1023`), which drops the `RpcSessionContext`. Its handler
  sends `started` before taking the project mutation lock, then runs
  `run_branch_or_sync_operation` (`git/manager/operations.rs:965`) under that lock.
- The `/mcp` Git tools (`mcp/tools/git.rs`) call the same stream through
  `invoke_local_stream` (`rpc/session.rs:826`) with a context built from the MCP client's
  own principal (`mcp/control.rs:1162`).
- A failed transfer whose stderr contains "authentication failed", "could not read
  username", "could not read password" or "permission denied (publickey)" is classified as
  `authentication` (`operations.rs:200-223`) and shown as "Authentication failed. Check the
  configured credentials and try again." (`:2082`).

## How credential helpers prompt

Sources: GCM at tag v3.0.2 (2026-10-26) and Git at v2.51.0. Base URLs:
`GCM` = `https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/`,
`G` = `https://github.com/git/git/blob/v2.51.0/`.

### Git

- Git asks each configured helper (`get`) in order and prompts only if username or
  password is still missing ([`credential.c` L504-544](https://github.com/git/git/blob/v2.51.0/credential.c#L504-L544)).
  After success it sends `store` to every helper; after an authentication failure, `erase`
  ([L547-580](https://github.com/git/git/blob/v2.51.0/credential.c#L547-L580)).
- Its own prompt tries `GIT_ASKPASS`, then `core.askPass`, then `SSH_ASKPASS`, then the
  terminal ([`prompt.c` L45-76](https://github.com/git/git/blob/v2.51.0/prompt.c#L45-L76)).
  An empty `GIT_ASKPASS` is set but not run, so it also blocks the later askpass sources.
  The terminal prompt opens `/dev/tty`, not standard input
  ([`compat/terminal.c` L21-22](https://github.com/git/git/blob/v2.51.0/compat/terminal.c#L21-L22)),
  so a server started from a terminal would block on it without `GIT_TERMINAL_PROMPT=0`,
  which instead fails with "terminal prompts disabled".
- Git 2.47 and later skip the prompt stage under `credential.interactive=false` or `never`
  ([git-config](https://git-scm.com/docs/git-config#Documentation/git-config.txt-credentialinteractive)).
  GCM reads the same key.
- Git has no setting that bounds how long a helper or prompt may take.

### Git Credential Manager

- `GCM_INTERACTIVE` (or `credential.interactive`) disables interaction only for `never`, or
  a false boolean such as `false` or `0`. Any other value, or no value, allows it
  ([`Settings.cs` L527](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/Core/Settings.cs#L527),
  [`docs/environment.md`](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/docs/environment.md)).
  Disabled, GCM fails with "Cannot prompt because user interactivity has been disabled."
  ([`AuthenticationBase.cs` L85](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/Core/Authentication/AuthenticationBase.cs#L85)).
- GCM honours `GIT_TERMINAL_PROMPT=0` for its terminal prompts only ("Cannot prompt because
  terminal prompts have been disabled.",
  [`AuthenticationBase.cs` L108](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/Core/Authentication/AuthenticationBase.cs#L108)).
  Its window branch checks `IsGuiPromptsEnabled && IsDesktopSession` and not the terminal
  setting ([`GitHubAuthentication.cs` L166](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/GitHub/GitHubAuthentication.cs#L166)).
  So interaction allowed plus `GIT_TERMINAL_PROMPT=0` gives windows and browser sign-in, and
  never a terminal prompt.
- `GCM_GUI_PROMPT` (`credential.guiPrompt`) defaults to on.
- A desktop session is a visible window station on Windows, a Security session with graphic
  access on macOS, and a set `DISPLAY` or `WAYLAND_DISPLAY` on Linux
  ([`Interop/`](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/Core/Interop/)).
  Without one, GitHub's browser mode is dropped and GCM falls back to the terminal, which
  `GIT_TERMINAL_PROMPT=0` blocks.
- github.com defaults to OAuth (browser or device code) and personal access tokens
  ([`GitHubConstants.cs` L47](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/GitHub/GitHubConstants.cs#L47)).
  The browser flow opens the system browser and waits on a loopback `HttpListener` with no
  timeout of its own
  ([`OAuth2SystemWebBrowser.cs` L100](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/Core/Authentication/OAuth/OAuth2SystemWebBrowser.cs#L100)).
- The GitHub chooser runs a separate `GitHub.UI` helper when present, otherwise an
  in-process Avalonia window
  ([`AuthenticationBase.cs` L143](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/Core/Authentication/AuthenticationBase.cs#L143),
  [`AvaloniaUi.cs`](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/Core/UI/AvaloniaUi.cs)).
  Azure Repos uses MSAL with the OS broker (WAM on Windows) by default since 3.0
  ([`docs/msauth-broker.md`](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/docs/msauth-broker.md)).
- A stored credential is returned without any prompt
  ([`HostProvider.cs` L122-145](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/Core/HostProvider.cs#L122)).
  GCM keeps no lock files. Git stores a new credential only after the transfer succeeds,
  so a run killed during sign-in stores nothing. The exception is GitHub's basic-auth token
  generation, which stores at once
  ([`GitHubHostProvider.cs` L307](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/GitHub/GitHubHostProvider.cs#L307)).
  No source describes GCM's behaviour when it is killed. A killed process group or Job
  ends GCM and its `GitHub.UI` helper; a browser tab GCM opened stays open, and its redirect
  then reaches a closed port.
- Defaults: Windows Credential Manager on Windows, Keychain on macOS. Linux has no default
  store and fails with "No credential store has been selected." until
  `credential.credentialStore` is set
  ([`docs/credstores.md`](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/docs/credstores.md),
  [`CredentialStore.cs` L133](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/Core/CredentialStore.cs#L133)).

### Other helpers

| Helper (kept by #283)                          | Can it sign the person in?                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manager`, `manager-core` (GCM)                | Yes, as above.                                                                                                                                                                                                                                                                                                                                                        |
| `osxkeychain` (Apple Git's default)            | No. It implements `get`, `store` and `erase` only ([source L419-442](https://github.com/git/git/blob/v2.51.0/contrib/credential/osxkeychain/git-credential-osxkeychain.c#L419-L442)); a missing credential falls to Git's prompt, which the guards block. Its `SecItemCopyMatching` can raise a macOS Keychain access or unlock dialog that no Git variable controls. |
| `wincred`                                      | No prompt code ([source L159](https://github.com/git/git/blob/v2.51.0/contrib/credential/wincred/git-credential-wincred.c#L159)).                                                                                                                                                                                                                                     |
| `cache`, `store`                               | No prompt (documented).                                                                                                                                                                                                                                                                                                                                               |
| `libsecret` (only when global config names it) | No sign-in. It searches with `SECRET_SEARCH_UNLOCK` ([L118-130](https://github.com/git/git/blob/v2.51.0/contrib/credential/libsecret/git-credential-libsecret.c#L118-L130)), so a locked Secret Service collection can show its own unlock prompt, independent of Git variables.                                                                                      |

Only GCM reads `GCM_INTERACTIVE`. For every other helper this design changes nothing, and
the retry in decision 4 never runs, because its trigger is GCM's own message.

SSH remotes stay out of scope. `SSH_ASKPASS_REQUIRE=never` blocks the askpass dialog, but
`ssh` still reads a key passphrase from `/dev/tty` when the server has one
([`readpass.c` L126-143](https://github.com/openssh/openssh-portable/blob/V_9_9_P1/readpass.c#L126-L143)).

## Alternatives

| Option                                                                                                                                          | For                                                                                                                                                                            | Against                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (A) Status quo: never prompt (#283 decision B)                                                                                                  | No change.                                                                                                                                                                     | The person must sign in with their own Git first; the issue rejects this.                                                                                                                                                                                                  |
| (B) Relax `GCM_INTERACTIVE` on the first attempt of an eligible call                                                                            | One process per operation.                                                                                                                                                     | The UI cannot tell a sign-in wait from a slow transfer; the banner can only say "Running fetch…". A helper that is not GCM gains nothing.                                                                                                                                  |
| **(C) recommended:** first attempt with today's guards; retry once without `GCM_INTERACTIVE=never` only when GCM reported that it needed to ask | A stored credential never reaches the prompt path. The UI knows exactly when a sign-in is pending. Callers that are not eligible, and helpers that are not GCM, see no change. | One extra round trip to the remote, only when a sign-in is needed. A command that partly succeeded before its credential failure (a submodule fetch, a `push.recurseSubmodules` push) runs again; fetch, pull and push are safe to repeat after an authentication failure. |
| (D) Sign in through `git credential fill`, then `approve`, then retry with today's guards                                                       | A sign-in phase with its own deadline.                                                                                                                                         | BiBCode would hold the secret in memory and pipe it between processes, and would have to reproduce Git's URL resolution (`pushurl`, `insteadOf`, `credential.useHttpPath`).                                                                                                |
| (E) A BiBCode askpass dialog for every helper                                                                                                   | `osxkeychain` users could sign in too.                                                                                                                                         | BiBCode would collect passwords and tokens itself, and it needs a re-exec mode or a native helper, which `AGENTS.md` forbids except for the crash monitor. Out of scope (question 3).                                                                                      |

Eligibility alternatives:

| Option                                                                                                                                              | Against                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A request field set by the toolbar                                                                                                                  | Any caller can set a field, including the `/mcp` tools. It would still need decision 1.                                                                                                    |
| `required_scope` or administrative scopes                                                                                                           | MCP clients and paired devices can hold the same scopes.                                                                                                                                   |
| Derive "local desktop" from `mode == Desktop && desktop_bootstrap_token.is_some() && !desktop_wsl_transport` (the `maintenance.rs:633-649` pattern) | Correct today, but a future launch path that reuses the bootstrap file descriptor (for example over SSH) would become eligible without anyone deciding it. The explicit flag fails closed. |
| Treat a loopback `bibcode serve` used in the person's own browser as local                                                                          | The server cannot tell whether its process has the person's desktop session (it may run over SSH or as a service). Question 4.                                                             |

## Design

### Eligibility

`git_manager_rpc.rs` registers `gitManager.runOperation` with
`register_stream_with_context` and computes, once per request:

```text
sign_in_allowed =
    services.interactive_git_sign_in              // decision 2, from ServerConfig
    && context.principal().is_some_and(|p| p.subject == DESKTOP_BOOTSTRAP_SUBJECT)
    && request is Fetch | Pull | Push | PublishBranch | ForcePush
```

`ConfiguredGitManagerRpcServices` gains the boolean from `ServerConfig`. It is passed to
`run_branch_or_sync_operation` and on to `execute_branch_or_sync_operation` as a
`CredentialPrompt` value (`Never` or `AfterGcmRefusal`), not as a context object, so the
domain layer does not depend on authentication types. Every other caller passes `Never`.

What each caller gets:

| Caller                                                                   | Subject                | Server flag | Result                                                        |
| ------------------------------------------------------------------------ | ---------------------- | ----------- | ------------------------------------------------------------- |
| Desktop app, in-process server                                           | `desktop-bootstrap`    | true        | Eligible.                                                     |
| Desktop app, WSL server                                                  | `desktop-bootstrap`    | false       | Never.                                                        |
| Desktop app or browser, remote `bibcode serve`                           | paired subject         | false       | Never.                                                        |
| Paired phone or browser on an exposed desktop server                     | paired subject         | true        | Never; a window would open on a desktop the person is not at. |
| `/mcp` Git tools, any scopes                                             | MCP client's subject   | any         | Never.                                                        |
| `unsafe_no_auth` server                                                  | no principal           | any         | Never.                                                        |
| Bootstrap fetch, watchers, automatic fetch, checkpoints, stacked actions | not RPC `runOperation` | any         | Never; they keep `git_environment()`.                         |

UI intents cannot start an operation: `ui.publishIntent` carries a commit message or a
focus request only (`packages/contracts/src/uiIntents.ts:94`).

### The retry

For an eligible operation, the network command runs as today. If it exits non-zero and its
stderr contains "user interactivity has been disabled" (GCM's message, compared without
case), and the call's cancellation has not fired:

1. The handler sends `{ "_tag": "awaiting-sign-in", "operation": … }` on the stream.
2. It runs the same arguments again on `for_network_transfer()` with
   `git_environment()` minus its `GCM_INTERACTIVE` entry.
3. The second result is the operation's result, classified as today.

Only that one network command is retried: for pull, the `git config --get` reads are not
repeated. The retry runs inside the same project mutation lock and the same
`begin_mutation` guard as the first attempt, so no other Git Manager operation can run in
between.

Environment of the retried command:

| Variable                              | First attempt | Retry              | Reason                                                                                                                                                 |
| ------------------------------------- | ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GCM_INTERACTIVE`                     | `never`       | not set by BiBCode | GCM then allows interaction. Leaving it unset, instead of `auto`, lets the person's own `GCM_INTERACTIVE` or `credential.interactive=never` still win. |
| `GIT_TERMINAL_PROMPT`                 | `0`           | `0`                | Blocks Git's `/dev/tty` prompt and GCM's terminal fallback.                                                                                            |
| `GIT_ASKPASS`, `SSH_ASKPASS`          | empty         | empty              | No askpass program.                                                                                                                                    |
| `SSH_ASKPASS_REQUIRE`                 | `never`       | `never`            | SSH unchanged.                                                                                                                                         |
| `GIT_CONFIG_SYSTEM`, `LC_ALL`, `LANG` | as #283       | as #283            | Same curated system file and stable messages.                                                                                                          |

`git_environment()` and `prompt_guard_environment()` stay unchanged for every other caller.
The new variant is one function beside them in `git/repository.rs`, used only by the retry.

### Cancellation

- **Cancel** in the banner interrupts the RPC. The handler's token fires, the supervised
  runner kills the Git process group (Unix) or Job (Windows), and GCM, its `GitHub.UI`
  helper and its window end with it. The result is today's `cancelled` outcome.
- **Losing the connection** (the window closes, the app quits, the backend restarts)
  cancels the stream the same way.
- **Losing the workspace** cancels through `admission.loss_cancellation()`
  (`git_manager_rpc.rs:257`), as today.
- **Server shutdown** drops the run, and the drop guard kills the group or Job without
  waiting (`docs/architecture/overview.md:392`).
- A browser tab GCM opened stays open. Finishing the sign-in there after a cancel reaches a
  closed loopback port and stores nothing.

### Timeouts

The retry keeps `for_network_transfer()`: Cancel, the 24-hour runaway bound, and the stall
guard once data flows. There is no separate sign-in deadline, because BiBCode cannot see
when sign-in ends and the transfer starts, and a deadline on the whole retry would cut
long pushes. While the person has not finished signing in, the project mutation lock is
held: other Git Manager operations and the `/mcp` Git tools on that project answer
`operation-in-flight`, and the banner with Cancel stays visible. Background work that does
not take that lock is unaffected. Question 2 asks whether to add a cap.

### Process supervision and profiler coverage

- **Child processes.** The retry is one more Git command through the same
  `GitRepository` runner and `process::supervised`, so its exit and crash reporting match
  the first attempt. GCM is Git's child in the same group or Job. No new process kind.
- **RPC methods.** No new method. `gitManager.runOperation` is timed to its first item
  (`FIRST_ITEM`, `diagnostics/profiler/latency.rs:36`), and `started` goes out before any
  Git runs, so a sign-in wait raises no `rpc.slow` or `rpc.hang`. A test pins this.
- **Events.** One new profiler event, `git.signIn`, emitted when a retry ends, with
  `operation`, `outcome` (`succeeded`, `failed`, `cancelled`, `timedOut`) and `waitMs`. It
  carries no remote name, URL, user name or Git output, and it is documented in
  `docs/skills/bibcode-profiler/references/events.md` and the Profiler section of the
  overview. The retry start is logged with `tracing::info!` and a failed retry with
  `tracing::warn!`, both with the operation name only.
- Worktree removal, binaries and shutdown order: not touched.

### UI while waiting

`packages/contracts/src/gitManager.ts` adds
`Schema.TaggedStruct("awaiting-sign-in", { operation })` to `GitManagerOperationEvent`.
Only the in-process server sends it, to the desktop app's own WebView, which ships in the
same build, so no older client receives it.

`GitManagerOperationBanner` (`apps/web/src/components/gitManager/toolbar/`) gains one
state:

- Text: "Finish signing in with Git Credential Manager in the window or browser page it
  opened. The {operation} continues after you sign in."
- The spinner and Cancel stay. The state lasts until `finished` or `failed`.
- A failed retry shows today's failure text. A cancelled one shows today's cancel text.
- Nothing changes when the event never arrives, which covers every ineligible caller and
  every helper that is not GCM.

The text names GCM because only GCM causes this state. The implementation is reviewed
against `UI.md` and `vercel-react-best-practices`.

### Security

- No prompt is reachable from MCP: the `/mcp` context carries the MCP client's principal,
  never `desktop-bootstrap`, and no request field can change that. A test drives the
  `git_fetch` tool through `invoke_local_stream` with administrative scopes and asserts
  `GCM_INTERACTIVE=never` on every spawned Git.
- No prompt is reachable from a remote client: paired sessions have their own subjects, and
  remote and WSL servers never set the flag.
- The desktop bootstrap credential stays in the desktop process. The implementer confirms
  that no spawned process (terminals, providers, Git) receives it in its environment; this
  design does not change that.
- The retry trigger is GCM's message in Git's stderr. A remote cannot plant it in a way
  that matters: a forged message only causes one retry that a person started anyway, with
  the same guards except `GCM_INTERACTIVE`.

### Pre-existing behaviour outside this change

`docs/architecture/rpc-and-orchestration.md:349-351` says no BiBCode Git call opens a
credential window or prompt. `osxkeychain` and `libsecret` can still raise an OS
Keychain or keyring dialog on any Git call, and `ssh` can read a passphrase from
`/dev/tty`. These are not credential-manager sign-ins and are not changed here.

## Tests

Rust, `apps/server`:

1. `git/manager/mod.rs`, `assert_non_interactive_git` (`:92`) also asserts
   `GCM_INTERACTIVE=never`, so every read and operation stays guarded.
2. A recording runner returns GCM's message on the first fetch, pull and push. With
   `CredentialPrompt::AfterGcmRefusal` the second spawn has no `GCM_INTERACTIVE` and keeps
   `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=`, `SSH_ASKPASS=` and `SSH_ASKPASS_REQUIRE=never`;
   pull does not repeat its config reads.
3. Same runner with `Never`: one spawn, the failure is `authentication`.
4. `AfterGcmRefusal` with an "Authentication failed" stderr that lacks GCM's message
   (osxkeychain), and with "permission denied (publickey)": no retry.
5. Every other operation with `AfterGcmRefusal`: one spawn, guarded.
6. `git_manager_rpc.rs` stream tests: a `desktop-bootstrap` principal with the flag on gets
   `started`, `awaiting-sign-in` and then the terminal event; with the flag off, with a
   paired principal, with no principal, and through `invoke_local_stream` with an MCP
   principal holding administrative scopes, no `awaiting-sign-in` and no unguarded spawn.
7. Cancel during the retry: the runner observes cancellation, the stream ends `cancelled`,
   and the project mutation lock is released.
8. `ServerConfig`: `interactive_git_sign_in` is false by default, from `bibcode serve`, and
   from a WSL bootstrap; `server_config_for_launch` sets it.
9. Profiler: a retry emits one `git.signIn` with no remote, URL or output, and a stream that
   waits after `started` raises no `rpc.hang`.

Contracts and web:

10. `gitManager.test.ts` decodes `awaiting-sign-in`.
11. `GitManagerOperationBanner` test: the event shows the sign-in text with Cancel, and
    `finished`, `failed` and Cancel leave it.

Native checks, added to `docs/testing/windows-desktop.md`, `macos-desktop.md` and
`linux-desktop.md` by the implementer, not run in this round:

12. Windows 11, Git for Windows with GCM, no stored credential for a private HTTPS
    repository: Git Manager Fetch shows the sign-in banner and GCM's window; signing in
    completes the fetch, and a second fetch needs no sign-in. Cancel during the window
    closes it. The same fetch from the `/mcp` `git_fetch` tool fails with the
    authentication error and no window.
13. macOS with GCM installed: the same checks, plus that GCM detects a desktop session
    when Git runs under the desktop app (unverified today). With only `osxkeychain`, the
    banner never appears and the error is unchanged.
14. Linux desktop with GCM and `credential.credentialStore=secretservice`: the same checks.
15. A WSL server and a paired browser on an exposed desktop server: no window; the
    authentication error as today.
16. Confirm GCM's message reaches Git's stderr as "fatal: Cannot prompt because user
    interactivity has been disabled." on each OS. If the wording differs, the trigger
    string in test 2 changes with it.

## Documents changed at implementation

- `docs/architecture/rpc-and-orchestration.md`, "Git process environment" and "Git Manager
  flow" (coordinator-reserved for this round; text in the lane report).
- `docs/architecture/overview.md`, Profiler section (coordinator-reserved).
- `docs/skills/bibcode-profiler/references/events.md`.
- The three desktop runbooks under `docs/testing/`.
- `2026-11-07-checkpoint-git-isolation-design.md` question 1 is answered by this note; that
  file is left unchanged.

## Risks

- GCM's message is matched as text. A GCM release that rewords it turns the feature off
  (no retry), never on. Test 16 guards it.
- GCM may not detect a desktop session for a Git spawned by the desktop app on macOS. Then
  it falls back to the terminal, `GIT_TERMINAL_PROMPT=0` blocks it, and the retry fails
  with today's error after the banner showed. Test 13.
- An abandoned sign-in holds the project mutation lock until Cancel or the window closes.

## Questions only the maintainer can answer

1. Should `tag-push` and `remote-branch-delete`, also network transfers the person starts
   from the Git Manager, get the same sign-in? Recommended: not now; the issue names fetch,
   pull and push, and adding them later is one match arm each.
2. Should a pending sign-in have a cap, for example 10 minutes
   (`BOUNDED_TRANSFER_TIMEOUT`) on the whole retry? Recommended: no cap. Cancel and closing
   the window already end it, and a cap would also cut long pushes after sign-in.
3. On macOS with Apple's default `osxkeychain`, no sign-in can happen. Should BiBCode offer
   its own user name and token dialog later? Recommended: no; BiBCode would then handle
   secrets itself.
4. Should a loopback `bibcode serve` used in the person's own browser count as local?
   Recommended: no; the server cannot tell whether it runs in the person's desktop
   session.
