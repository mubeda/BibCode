# Git Manager Sign-In on a Local Desktop

Status: Approved 2026-11-07 (Mauro pre-approval; Codex reviewed revisions 0–2, advisor
reviewed).

Issue #325, a follow-up of #283
([`2026-11-07-checkpoint-git-isolation-design.md`](./2026-11-07-checkpoint-git-isolation-design.md),
"Authentication and prompts" and its question 1). Verified at `c079af0048` (`main` at
`e222d340ff` plus the accepted #283 branch), on macOS with Git 2.56.0. Line references are
to that commit. No product code is written until this design is approved.

**Revision 1 (2026-11-07)** records Mauro's answers to revision 0's five questions and
answers the first Codex review. The retry inside the operation is gone: a person now
approves a sign-in that names the remote and its host, and the sign-in runs as its own
short Git command outside every lock, capped at 10 minutes. See
[Review findings and resolutions](#review-findings-and-resolutions).

**Revision 2 (2026-11-07)** answers the Codex review of revision 1. The GCM line is an
untrusted hint; the destination is frozen at failure time, the sign-in probe runs where no
URL rewrite can apply, and every resumed request is bound to the approved destination. A
branch delete resumes its remote step only.

## Goal

On a local desktop server, a fetch, pull or push that the person starts may open the
system credential manager's sign-in. Background Git (bootstrap fetch, watchers, automatic
fetch, checkpoints) and agent-driven Git (the `/mcp` tools) never prompt. A remote server,
including a desktop-owned WSL server, never prompts.

Acceptance, from the issue: this note is approved first; then tests for each mode.

## Decisions

Mauro's answers (2026-11-07):

- **M1.** Tag push and remote-branch delete get the sign-in too.
- **M2.** A pending sign-in is capped at 10 minutes. Then BiBCode kills the Git process
  group or Job, holds no lock, and reports a timeout.
- **M3.** No BiBCode user name or token dialog for `osxkeychain` users.
- **M4.** Only the desktop's in-process server; a loopback `bibcode serve` does not count.
- **M5.** The Source Control panel's push and pull get the sign-in too, which needs a
  Cancel control there first. This note designs it.

Design decisions:

1. **Who may sign in.** The call must come from the desktop app's own session, whose
   principal subject is `DESKTOP_BOOTSTRAP_SUBJECT`. That is the predicate
   `Claimant::of` already uses to let only the desktop serve a diagnostics relay
   (`production/diagnostic_logs_relay.rs:326`), whatever the session's scopes. A header or
   a payload flag never grants this.
2. **Where.** The server must be the desktop's in-process backend. A new
   `ServerConfig::interactive_git_sign_in: bool` defaults to `false`; only the desktop's
   `server_config_for_launch` (`apps/desktop/src-tauri/src/backend.rs:2290`), which builds
   the in-process configuration, sets it. No CLI flag or bootstrap JSON key sets it.
3. **Which operations.** Git Manager `fetch`, `pull`, `push`, `publish-branch`,
   `force-push`, `tag-push`, `remote-branch-delete` and `branch-delete` with
   `deleteRemote`; Source Control `vcs.pull` and the push step of `git.runStackedAction`.
4. **Operations never prompt.** Every operation keeps today's non-interactive environment.
   When it fails, and Git's stderr has a line that starts with GCM's refusal (an untrusted
   hint), an eligible operation fails with a new `sign-in-required` outcome that names the
   remote, its frozen effective URL and the direction (fetch or push). Nothing is retried
   automatically.
5. **The person approves a named destination.** The panel asks "Sign in to
   `github.com/owner/repo` for remote `origin`?". Only a click on Sign in starts the
   sign-in.
6. **The sign-in is its own command.** A new unary RPC, `git.signIn`, runs one short Git
   command against the approved URL with `GCM_INTERACTIVE` left unset: `git ls-remote` for
   fetch, `git push --dry-run` for push. It runs in an empty BiBCode-owned repository and
   refuses when a URL rewrite could change the destination. Git stores the credential when that request
   authenticates. It holds no project lock and no status mutation guard. It is capped at
   10 minutes (M2). One sign-in runs at a time per server.
7. **Then the operation resumes, non-interactively.** After a successful sign-in the
   panel sends the resume request the failure named, bound to the approved destination.
   It now finds the stored credential.

## Current behaviour

- Every Git Manager command builds `git_environment()` (`git/repository.rs:7903`), which
  starts from `prompt_guard_environment()` (`:7922`): `GCM_INTERACTIVE=never`,
  `GIT_ASKPASS=`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS=`, `SSH_ASKPASS_REQUIRE=never`,
  `LC_ALL=C`, `LANG=C`, plus the curated `GIT_CONFIG_SYSTEM` file from #283.
- `git_manager_fetch` (`:4410`), the network step of `git_manager_pull` (`:4451`),
  `git_manager_push` (`:4488`), `git_manager_delete_remote_branch` (`:4392`) and the tag
  push run on `for_network_transfer()` (`:370`): a 24-hour runaway bound
  (`NETWORK_TRANSFER_TIMEOUT`, `git/mod.rs:98`), Git's HTTP stall guard
  (`http.lowSpeedLimit=1000`, `http.lowSpeedTime=60`, `:54`) and Cancel.
- `gitManager.runOperation` is registered with `register_stream`
  (`production/git_manager_rpc.rs:1023`), which drops the `RpcSessionContext`. Its handler
  sends `started`, then runs `run_branch_or_sync_operation`
  (`git/manager/operations.rs:965`) under the project mutation lock and a
  `begin_mutation` guard.
- `begin_mutation` (`git/status_owner.rs:507-540`) closes the worktree's status read gate,
  retires in-flight reads and holds the worktree's mutation mutex until the guard is
  dropped. Source Control mutations take the same guard through `run_owned_git_mutation`
  (`production/git_vcs.rs:801-843`).
- Source Control's `vcs.pull` is a unary method whose work runs in a spawned task
  (`await_server_owned_rpc`, `git_vcs.rs:597`), so a client interrupt does not stop it.
  `git.runStackedAction` is a stream registered without context (`git_vcs.rs:592`). Their
  transfers run on `for_bounded_transfer()` (10 minutes, `git/mod.rs:105`) because they have
  no Cancel.
- The `/mcp` Git tools (`mcp/tools/git.rs`) call `gitManager.runOperation` through
  `invoke_local_stream` (`rpc/session.rs:826`), and `mcp/tools/pull_requests.rs:42` calls
  `git.runStackedAction`, each with a context built from the MCP client's own principal
  (`mcp/control.rs:1162`).
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
  GCM keeps no lock files. Git sends `store` only after the request succeeds. GCM itself
  can persist state before it returns a credential: GitHub's basic-auth token generation
  stores at once
  ([`GitHubHostProvider.cs` L307](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/src/GitHub/GitHubHostProvider.cs#L307)),
  the generic OAuth provider stores its refresh token before returning
  (`GenericHostProvider.cs` L345-369, reported by the Codex review), and Entra sign-in
  registers an MSAL token cache. So a sign-in the person completes is kept even when the Git
  command is then killed.
  No source describes GCM's behaviour when it is killed. A killed process group or Job
  ends GCM and its `GitHub.UI` helper. It does not end windows owned by other processes: a
  browser tab GCM opened stays open (its redirect then reaches a closed port), and the OS
  broker's window (WAM on Windows,
  [`docs/msauth-broker.md`](https://github.com/git-ecosystem/git-credential-manager/blob/v3.0.2/docs/msauth-broker.md))
  belongs to the OS and stays until the person closes it.
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

Only GCM reads `GCM_INTERACTIVE`. For every other helper this design changes nothing: the
sign-in offer appears only after GCM's own refusal line.

Git copies the remote's band-2 sideband messages to stderr with a `remote: ` prefix on
every line ([`sideband.c` L180-220](https://github.com/git/git/blob/v2.51.0/sideband.c#L180-L220)),
but its band-3 error path prefixes the payload once
([L170-178](https://github.com/git/git/blob/v2.51.0/sideband.c#L170-L178)). A remote can
therefore put any text, including GCM's message, at the start of a stderr line.

SSH remotes stay out of scope. `SSH_ASKPASS_REQUIRE=never` blocks the askpass dialog, but
`ssh` still reads a key passphrase from `/dev/tty` when the server has one
([`readpass.c` L126-143](https://github.com/openssh/openssh-portable/blob/V_9_9_P1/readpass.c#L126-L143)).

## Alternatives

| Option                                                                                                                                                                                                                                                                                              | For                                                                                                                                                                                               | Against                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (A) Status quo: never prompt (#283 decision B)                                                                                                                                                                                                                                                      | No change.                                                                                                                                                                                        | The person must sign in with their own Git first; the issue rejects this.                                                                                                                                                                                  |
| (B) Relax `GCM_INTERACTIVE` on the first attempt of an eligible call                                                                                                                                                                                                                                | One process per operation.                                                                                                                                                                        | The UI cannot tell a sign-in wait from a slow transfer, and the sign-in would hold the project lock and the status gate. A helper that is not GCM gains nothing.                                                                                           |
| (C) Revision 0: retry the operation inside its lock when stderr contains GCM's message                                                                                                                                                                                                              | No new RPC.                                                                                                                                                                                       | A remote can print the message through sideband text and force a second push. The sign-in holds the project lock and the status mutation guard, so status reads stop. A 10-minute cap (M2) on the whole retry would also cut long transfers after sign-in. |
| **(D) recommended:** the operation fails with `sign-in-required` on a line-anchored GCM refusal; the person approves the named destination; `git.signIn` runs a short authenticating command outside every lock with a 10-minute cap; the panel sends the resume request, bound to that destination | The cap measures the sign-in alone. No lock or status gate is held while a window is open. The person sees where they sign in before anything opens. A stored credential never reaches this path. | A new RPC, a new outcome and one approval click. A sign-in can succeed while the rerun then fails (for example a read-only token for a push); the rerun reports that as today.                                                                             |
| (E) Sign in through `git credential fill`, then `approve`                                                                                                                                                                                                                                           | No probe request.                                                                                                                                                                                 | BiBCode would hold the secret in memory and pipe it between processes, and would have to reproduce Git's URL resolution (`pushurl`, `insteadOf`, `credential.useHttpPath`).                                                                                |
| (F) A BiBCode askpass dialog for every helper                                                                                                                                                                                                                                                       | `osxkeychain` users could sign in too.                                                                                                                                                            | Rejected by Mauro (M3).                                                                                                                                                                                                                                    |

Eligibility alternatives:

| Option                                                                                                                                              | Against                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A payload flag set by the toolbar                                                                                                                   | Any caller can set a field, including the `/mcp` tools.                                                                                                                                    |
| `required_scope` or administrative scopes                                                                                                           | MCP clients and paired devices can hold the same scopes.                                                                                                                                   |
| Derive "local desktop" from `mode == Desktop && desktop_bootstrap_token.is_some() && !desktop_wsl_transport` (the `maintenance.rs:633-649` pattern) | Correct today, but a future launch path that reuses the bootstrap file descriptor (for example over SSH) would become eligible without anyone deciding it. The explicit flag fails closed. |
| Treat a loopback `bibcode serve` as local                                                                                                           | Rejected by Mauro (M4).                                                                                                                                                                    |

## Design

### Eligibility

One function, `sign_in_eligible(services, context)`, is true when:

```text
services.interactive_git_sign_in        // decision 2, from ServerConfig
&& context.principal().is_some_and(|p| p.subject == DESKTOP_BOOTSTRAP_SUBJECT)
```

`gitManager.runOperation` (`git_manager_rpc.rs:1023`) and `git.runStackedAction`
(`git_vcs.rs:592`) move to `register_stream_with_context`; `vcs.pull` already has its
context (`git_vcs.rs:609`). `git.signIn` checks it again on every call. The domain layer
receives a plain `CredentialPrompt::{Never, OfferSignIn}` value, not authentication types;
every other caller passes `Never`.

| Caller                                                  | Subject              | Server flag | Result                                                        |
| ------------------------------------------------------- | -------------------- | ----------- | ------------------------------------------------------------- |
| Desktop app, in-process server                          | `desktop-bootstrap`  | true        | Eligible.                                                     |
| Desktop app, WSL server                                 | `desktop-bootstrap`  | false       | Never.                                                        |
| Desktop app or browser, remote `bibcode serve`          | paired subject       | false       | Never.                                                        |
| Paired phone or browser on an exposed desktop server    | paired subject       | true        | Never; a window would open on a desktop the person is not at. |
| `/mcp` tools, any scopes                                | MCP client's subject | any         | Never.                                                        |
| `unsafe_no_auth` server                                 | no principal         | any         | Never.                                                        |
| Bootstrap fetch, watchers, automatic fetch, checkpoints | not these RPCs       | any         | Never; they keep `git_environment()`.                         |

UI intents cannot start an operation or a sign-in: `ui.publishIntent` carries a commit
message or a focus request only (`packages/contracts/src/uiIntents.ts:94`).

### Detecting that GCM needs the person

The trigger is an untrusted hint. It decides only whether the panel offers a sign-in.
Every security property rests on eligibility, the person's approval of a frozen
destination, and the checks in [Freezing the destination](#freezing-the-destination).

An eligible operation's network command runs as today. It reports `sign-in-required` when
all of these hold:

1. It exited non-zero and was not cancelled.
2. A line of its stderr starts with GCM's refusal,
   `fatal: Cannot prompt because user interactivity has been disabled.`, compared without
   case after stripping a trailing `\r`.
3. The remote's effective URL in the operation's direction (below) is an `https://` URL.
   Any other scheme, including SSH and `http://`, reports today's authentication error.
4. The remote has exactly one URL in that direction, counted with
   `git remote get-url --all <remote>` (fetch) or `git remote get-url --all --push <remote>`
   (push). `get-url` without `--all` prints only the first, while `git push <remote>`
   pushes to every push URL
   ([`builtin/push.c` L435-444](https://github.com/git/git/blob/v2.51.0/builtin/push.c#L435-L444)),
   so one approval could not cover them all. A remote with several reports today's
   authentication error followed by "BiBCode offers a sign-in only for a remote with one
   {fetch | push} URL. Sign in with your own Git."

A remote can forge the line. Band-2 sideband text gets a `remote: ` prefix on every line,
but Git's band-3 error path adds the prefix only once before the whole payload
([`sideband.c` L170-178](https://github.com/git/git/blob/v2.51.0/sideband.c#L170-L178)), so
a payload `error\nfatal: Cannot prompt because user interactivity has been disabled.`
puts the line at column 0. A local hook can print it too. A forged hint can only make the
approval appear. That approval names the frozen destination BiBCode resolved, which the
remote does not choose, and the person can answer Not now. The sign-in that follows
contacts only that destination.

The outcome carries `{ remote, destination, host, direction, resume }`:

- `destination` is the frozen effective URL without user information.
- `resume` is the request the panel sends after a sign-in (see [Rerun](#rerun)).

### Freezing the destination

The effective URL is what `git remote get-url <remote>` (fetch) or
`git remote get-url --push <remote>` (push) prints. Git expands `url.<base>.insteadOf` and
`url.<base>.pushInsteadOf` there
([git-remote](https://git-scm.com/docs/git-remote#Documentation/git-remote.txt-emget-urlem)),
once, with the longest matching prefix
([`remote.c` L42-66](https://github.com/git/git/blob/v2.51.0/remote.c#L42-L66)). The
value is the one the operation's own network step uses, because both read the same
remote. Its user name and password parts are dropped before it is shown or stored.

A URL passed to Git as an argument is rewritten again: `remote_get` turns an unknown name
into an anonymous remote through `add_url_alias`
([`remote.c` L799](https://github.com/git/git/blob/v2.51.0/remote.c#L799)), which applies
`insteadOf` and then `pushInsteadOf` to it
([L84-100](https://github.com/git/git/blob/v2.51.0/remote.c#L84-L100)). With rules A to B
and B to C, `get-url` prints B and a command given B contacts C. So `git.signIn` pins the
destination this way:

1. **A neutral repository.** The probe runs in a new empty repository that BiBCode
   creates with `git init -q` in a `0700` directory under its state directory and removes
   afterwards. The checkout's repository configuration, which an agent working there can
   edit, does not apply. Only the person's global configuration and the curated system
   file from #283 do.
2. **No rewrite may match.** In that repository, right before the probe, BiBCode reads
   `git config --includes -z --get-regexp '^url\..*\.(insteadof|pushinsteadof)$'`. If the
   destination starts with any value, the sign-in is refused with
   `GitSignInRewrittenError`: "Git rewrites this remote's address
   (`url.<base>.insteadOf`), so BiBCode cannot show where the sign-in goes. Sign in with
   your own Git." With no matching prefix, `alias_url` returns nothing and Git uses the
   destination unchanged. `get-url` already applied the first rewrite, so a match here
   means a second hop, which is the case refused. The probe's system layer is the #283
   curated file, which carries no `url.*` keys.
3. **HTTPS only, enforced by Git.** The probe sets `GIT_ALLOW_PROTOCOL=https`, which Git
   checks against the transport of the final URL
   ([`transport.c` L1114-1131](https://github.com/git/git/blob/v2.51.0/transport.c#L1114-L1131)).
4. **No redirects.** The probe adds `-c http.followRedirects=false` and
   `-c http.<destination>.followRedirects=false`, so a server at the destination cannot
   send the request, and the credential prompt, to another host
   ([git-config `http.followRedirects`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-httpfollowRedirects)).
   Git picks each `http.*` setting by how closely its URL matches
   ([`http.c` L1305-1321](https://github.com/git/git/blob/v2.51.0/http.c#L1305-L1321)), so a
   global `http.https://host.followRedirects=true` would beat the generic key. The
   destination's own key matches with the longest host and path. A config URL with a user
   name matches only a URL with that user
   ([`urlmatch.c` L507-515](https://github.com/git/git/blob/v2.51.0/urlmatch.c#L507-L515)),
   and the destination has none, so nothing matches more closely. On an equal match the
   later entry replaces the earlier one (`cmp_matches` returns 0 and
   `urlmatch_config_entry` replaces the stored value,
   [`urlmatch.c` L544-554 and L598-611](https://github.com/git/git/blob/v2.51.0/urlmatch.c#L544-L611)),
   and `-c` entries are read after every file, so BiBCode's value wins.

What stays open: the person's global configuration (or a file it includes) could change
between step 2 and the probe. Whoever can write that file can already set
`credential.helper` to any program, which every BiBCode Git call then runs, so the window
gives them nothing new. A rule added in that window still cannot change the scheme:
`GIT_ALLOW_PROTOCOL=https` fails a rewrite to `ssh://` or `file://` at the transport.

Cost: repository-level credential settings (`credential.useHttpPath`,
`credential.<url>.*` in the checkout's `.git/config`) do not apply to the sign-in. If they
change which credential Git looks up, the rerun asks again and the panel shows the error
in [Rerun](#rerun).

### Approval

The panel shows the destination before anything opens:

- Title: "Sign in to `github.com/owner/repo`?"
- Body: "Git Credential Manager needs you to sign in before it can {fetch from | push to}
  remote `origin`. It opens its own window or a browser page."
- Buttons: **Sign in** (primary) and **Not now**. Not now ends the operation with today's
  authentication error.

The text shows host and path, never user information or query. A long path is shortened
in the middle; the host is never shortened. An agent may have rewritten the remote URL
before the click; this is why the dialog shows the destination BiBCode froze at failure
time, and why `git.signIn` and the rerun check it again.

### `git.signIn`

A unary RPC, scope `orchestration:operate`, declared in `auth/scope.rs`, registered with
context, and added to `is_long_running` (`diagnostics/profiler/latency.rs:106`) because it
waits on a person. It is not run in a spawned task, so an interrupt drops it and the
supervised drop guard kills its process group or Job.

Input: `{ projectId, cwd, remote, direction, destination }`, where `destination` is the one
the person approved. Steps:

1. Refuse unless `sign_in_eligible`. The error is `GitSignInUnavailableError`.
2. Validate `cwd` as `gitManager.runOperation` does (project ownership, workspace
   admission).
3. Resolve the remote's effective URLs again in `cwd` with `--all`. If there is more than
   one, refuse with the several-URLs message above. If the one differs from
   `destination`, refuse with `GitSignInDestinationChangedError` carrying the new one; the
   panel asks again.
4. Take the server's single sign-in slot. If another sign-in is pending, refuse with
   `GitSignInBusyError` ("Another sign-in is open. Finish or cancel it first.").
5. Create the neutral repository and run the rewrite check
   ([Freezing the destination](#freezing-the-destination), steps 1 and 2).
6. Run one Git command in the neutral repository, with `destination` as the URL argument:
   - fetch: `git ls-remote <destination> HEAD`, which keeps the output to one line;
   - push:
     `git push --dry-run --no-verify --porcelain <destination> :refs/heads/bibcode-sign-in-<uuid>`.
     A push connects to the receive-pack service, which
     authenticates, before it matches refspecs, so a dry-run delete of a branch that does
     not exist authenticates and changes nothing. It needs no local commits, so it works in
     the empty repository. `--no-verify` keeps hooks out.
     It runs with `git_environment()` minus its `GCM_INTERACTIVE` entry, plus
     `GIT_ALLOW_PROTOCOL=https`, `http.followRedirects=false` and
     `http.<destination>.followRedirects=false`, the
     `for_network_transfer()` configuration, and a 10-minute timeout instead of 24 hours.
7. Answer `signedIn` when the command authenticated: exit 0, or a push that failed only
   because the probe branch does not exist on the remote. Answer `failed` with the
   classified message otherwise, `timedOut` after 10 minutes, and `cancelled` on interrupt.
   Remove the neutral repository in every case.

Git sends `store` to every helper after a request authenticates, so the credential is saved
before the probe ends. A public repository that needs no sign-in to read answers
`signedIn` for fetch without storing anything; the rerun then succeeds without one. For
push the probe asks for write access, so the stored credential is the one the push needs.

Environment of the sign-in command:

| Variable                              | Operations | `git.signIn`       | Reason                                                                                                                                                 |
| ------------------------------------- | ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GCM_INTERACTIVE`                     | `never`    | not set by BiBCode | GCM then allows interaction. Leaving it unset, instead of `auto`, lets the person's own `GCM_INTERACTIVE` or `credential.interactive=never` still win. |
| `GIT_TERMINAL_PROMPT`                 | `0`        | `0`                | Blocks Git's `/dev/tty` prompt and GCM's terminal fallback.                                                                                            |
| `GIT_ASKPASS`, `SSH_ASKPASS`          | empty      | empty              | No askpass program.                                                                                                                                    |
| `SSH_ASKPASS_REQUIRE`                 | `never`    | `never`            | SSH unchanged.                                                                                                                                         |
| `GIT_ALLOW_PROTOCOL`                  | inherited  | `https`            | The final URL must be HTTPS.                                                                                                                           |
| `GIT_CONFIG_SYSTEM`, `LC_ALL`, `LANG` | as #283    | as #283            | Same curated system file and stable messages.                                                                                                          |

`git_environment()` and `prompt_guard_environment()` stay unchanged for every other caller.
The sign-in environment is one function beside them in `git/repository.rs`.

### Rerun

After `signedIn`, the panel sends the outcome's `resume` request, never a request it builds
itself:

- Fetch, pull, push, publish-branch, force-push, tag-push and remote-branch-delete resume
  as the same request.
- A branch delete with `deleteRemote` already deleted the local branch before its remote
  step failed (`operations.rs:1299-1329`). It resumes as `remote-branch-delete` with the
  remote and remote branch of that failed step.
- `vcs.pull` resumes as `vcs.pull`.
- A stacked action resumes without the commit it already made (`git_vcs.rs:3378` lists
  each action's phases): `commit_push` and `push` resume as `push`, `commit_push_pr` and
  `create_pr` as `create_pr` (push, then pull request).

Every resume request carries `expectedDestination`, the approved destination. Right before
its network step, the operation resolves the remote's effective URLs in its direction
with `--all`, under the project lock and status guard it already holds, and fails with
`destination-changed` unless there is exactly one and it equals the approved one. The field can only add a refusal, so any caller may
send it. The resumed call is an ordinary non-interactive call, so a configuration change
racing that check can only send a non-interactive request elsewhere, as any operation
can today; it can never open a prompt.
If it reports `sign-in-required` again, the panel shows the error "Signed in, but Git
Credential Manager still asked to sign in. Sign in with your own Git, then try again." and
does not offer a second sign-in in a row.

### Locks while a sign-in is open

`git.signIn` takes neither the project mutation lock nor `begin_mutation`. While its window
is open:

| Caller                                                                                  | Effect                                                            |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Status reads, status streams, refs and history reads                                    | Continue.                                                         |
| Other Git Manager operations, Source Control mutations, `/mcp` Git tools on the project | Run normally. One that needs a credential fails as it does today. |
| Another `git.signIn` anywhere on the server                                             | Refused with `GitSignInBusyError`.                                |
| Checkpoints, bootstrap fetch, watchers                                                  | Unaffected.                                                       |

The operation that asked for the sign-in released its lock and guard when it failed with
`sign-in-required`. The rerun takes them again and revalidates as any operation does
(`run_branch_or_sync_operation` rebuilds its refs snapshot and checks blocked reasons
first), so a change made during the sign-in is seen.

### Cancellation and timeout

- **Cancel** during the sign-in interrupts `git.signIn`. The handler is dropped and the
  supervised runner kills the Git process group (Unix) or Job (Windows), which ends GCM and
  its `GitHub.UI` helper.
- **Losing the connection** (the window closes, the app quits, the backend restarts) and
  **server shutdown** drop the handler the same way
  (`docs/architecture/overview.md:392`).
- **Timeout** after 10 minutes (M2) kills the group or Job the same way and answers
  `timedOut`: "Sign-in timed out after 10 minutes. Nothing was fetched or pushed." No lock
  is held, so nothing else needs releasing.
- **What cancel does not undo.** Cancel and timeout stop BiBCode's processes and the probe.
  They do not undo authentication: a sign-in the person already finished in GCM may be
  stored (GCM persists OAuth refresh tokens and MSAL caches before returning; Git stores
  the credential once the request authenticates). A browser tab GCM opened, and the OS
  broker window (WAM), belong to other processes and stay open until the person closes
  them.
- The original operation never runs during the sign-in, so cancelling a sign-in cannot
  leave a half-done transfer.

### Source Control Cancel (M5)

The Source Control panel has no Cancel today, so its pull and push use the 10-minute
bounded transfer. M5 needs one before a sign-in can be offered there.

- **UI.** While `vcs.pull` runs, or while `git.runStackedAction` reports its `push`
  phase, the panel's progress row shows a **Cancel** button. The commit, branch and pull
  request phases show none: the first two are local and short, and the third is a provider
  API call, not a Git transfer.
- **`git.runStackedAction`.** A stream: Cancel interrupts it, its token fires, and the
  running push is killed. The stream then sends `action_failed` with phase `push` and the
  message "Push cancelled. Your commit is saved locally." A commit that finished stays.
- **`vcs.pull`.** Its work runs in a spawned task today, so an interrupt does not reach it.
  The handler holds a `CancellationToken::drop_guard()` for the operation token while it
  awaits the task, and disarms it when the task finishes. An interrupt or a lost
  connection then cancels the token and kills the pull's Git process group or Job. This is
  the same exposure the Git Manager's cancellable pull already has: Git killed during its
  merge step can leave `index.lock`, which the in-progress strip already reports.
  This reverses, for `vcs.pull` only, the server-owned lifecycle that lets a mutation finish
  after its caller disconnects (`docs/architecture/rpc-and-orchestration.md`, the
  cancellation invariants near line 5380). That document changes in the same patch.
- Both keep `for_bounded_transfer()` (10 minutes); Cancel is added, the bound stays.
- **Sign-in.** On an eligible session both report `sign-in-required` the same way:
  `vcs.pull` as a typed error `GitSignInRequiredError { remote, destination, host, direction, resume }`,
  the stacked action as an optional `signIn` object on `action_failed`. The panel shows
  the same approval and calls the same `git.signIn`.

### Process supervision and profiler coverage

- **Child processes.** The sign-in command runs through the same `GitRepository` runner and
  `process::supervised`, so exit and crash reporting match other Git commands. GCM is Git's
  child in the same group or Job. No new process kind.
- **RPC methods.** `git.signIn` is registered through the `rpc/session.rs` wrappers, which
  time it, and is listed in `is_long_running`, so a 10-minute wait raises no `rpc.slow` or
  `rpc.hang`. `gitManager.runOperation` and `git.runStackedAction` are timed to their first
  item (`FIRST_ITEM`, `latency.rs:36`) and are unchanged.
- **Events.** One new profiler event, `git.signInEnded`, with `direction`, `outcome`
  (`signedIn`, `failed`, `cancelled`, `timedOut`) and `waitMs`. It carries no remote name,
  URL, host, user name or Git output. It is documented in
  `docs/skills/bibcode-profiler/references/events.md` and the overview's Profiler section.
  The sign-in start is logged with `tracing::info!`, a failure or timeout with
  `tracing::warn!`, both with the direction only.
- Worktree removal, binaries and shutdown order: not touched.

### UI

Contracts (`packages/contracts`):

- The existing `failed` event of `GitManagerOperationEvent` uses code `sign-in-required`
  and gains an optional `signIn { remote, destination, host, direction, resume }` object, the same shape as
  on `action_failed`. `StreamSchema` needs no change. Only the in-process server sends it,
  to the desktop app's own WebView, which ships in the same build.
- `vcs.pull` gains `GitSignInRequiredError`; `action_failed` gains an optional `signIn`.
- `git.signIn` input and result schemas, and its four errors. Its client command sets no
  `timeoutMs` (`packages/client-runtime/src/state/runtime.ts:925`), so the server's
  10-minute cap decides, as for `vcs.pull`.

Web (`apps/web`):

- The approval in [Approval](#approval), shown in place of the operation banner
  (`gitManager/toolbar/GitManagerOperationBanner.tsx`) and the Source Control progress row.
- While `git.signIn` runs: "Finish signing in with Git Credential Manager in the window or
  browser page it opened." with a spinner and **Cancel**. After `signedIn`, the banner
  returns to "Running {operation}…" for the rerun.
- `failed`, `timedOut` and `cancelled` show their messages from
  [`git.signIn`](#gitsignin) and [Cancellation and timeout](#cancellation-and-timeout).
  Cancelled reads "Sign-in cancelled. Nothing was fetched or pushed."
- Nothing changes when no `sign-in-required` arrives, which covers every ineligible caller
  and every helper that is not GCM.

The implementation is reviewed against `UI.md` and `vercel-react-best-practices`.

### Security

- No prompt is reachable from MCP: the `/mcp` context carries the MCP client's principal,
  never `desktop-bootstrap`. Its operations never report `sign-in-required`, and a direct
  `git.signIn` through `invoke_local` is refused by eligibility. No `/mcp` tool lists
  `git.signIn` among its methods.
- No prompt is reachable from a remote client: paired sessions have their own subjects, and
  remote and WSL servers never set the flag.
- A remote or a local hook can forge the hint. That only shows an approval naming the
  frozen destination, which the person can decline.
- An agent that rewrites a remote URL cannot redirect an approved sign-in: the dialog shows
  the frozen destination, `git.signIn` compares it again, and the probe runs in a neutral
  repository where no `insteadOf` or `pushInsteadOf` value matches it, with redirects off.
- A resumed operation refuses a destination that changed since the approval.
- Only `https://` destinations get a sign-in, and `GIT_ALLOW_PROTOCOL=https` enforces it
  on the final URL.
- The desktop bootstrap credential stays in the desktop process. The implementer confirms
  that no spawned process (terminals, providers, Git) receives it in its environment; this
  design does not change that.

### Pre-existing behaviour outside this change

`docs/architecture/rpc-and-orchestration.md:349-351` says no BiBCode Git call opens a
credential window or prompt. `osxkeychain` and `libsecret` can still raise an OS
Keychain or keyring dialog on any Git call, and `ssh` can read a passphrase from
`/dev/tty`. These are not credential-manager sign-ins and are not changed here.

## Tests

Rust, `apps/server`:

1. `git/manager/mod.rs`, `assert_non_interactive_git` (`:92`) also asserts
   `GCM_INTERACTIVE=never`, so every read and operation stays guarded, including on an
   eligible session.
2. Detection: a recording runner returns GCM's refusal line for fetch, pull, push,
   publish-branch, force-push, tag-push, remote-branch-delete and branch-delete with
   `deleteRemote`. With `OfferSignIn` and an `https://` remote each fails with
   `sign-in-required` carrying remote, destination without user information, host,
   direction and `resume`. Exactly one network spawn, no retry. A branch delete's `resume`
   is `remote-branch-delete` for the failed remote step.
3. Detection negatives, each giving today's `authentication`: the same text after
   `remote: `; an "Authentication failed" stderr without the line (osxkeychain);
   "permission denied (publickey)"; an SSH or `http://` remote; `Never`. Forged hints from a
   multiline band-3 payload (`remote: error` then the GCM line at column 0) and inside a
   protocol-error message still produce `sign-in-required` only on an eligible session,
   and its destination is the frozen effective URL, never text from stderr.
4. `git.signIn` environment: no `GCM_INTERACTIVE`, and `GIT_TERMINAL_PROMPT=0`,
   `GIT_ASKPASS=`, `SSH_ASKPASS=`, `SSH_ASKPASS_REQUIRE=never`, `GIT_ALLOW_PROTOCOL=https`,
   `http.followRedirects=false` and `http.<destination>.followRedirects=false`; the
   working directory is the neutral repository; the
   arguments are `ls-remote <destination> HEAD` or
   `push --dry-run --no-verify --porcelain <destination> :refs/heads/bibcode-sign-in-<uuid>`,
   never the remote name. The neutral repository is removed after every outcome.
5. `git.signIn` refusals: ineligible session (flag off, paired principal, no principal, MCP
   principal with administrative scopes through `invoke_local`); destination changed
   since the approval; a second concurrent sign-in; a global `insteadOf` or
   `pushInsteadOf` value that prefixes the destination (the A to B, B to C chain), and the
   same value in the checkout's own `.git/config`, which the neutral repository ignores
   and so does not refuse; a remote with two fetch URLs (fetch direction) or two push
   URLs (push direction), refused before any network spawn, while detection on such a
   remote reports the authentication error with the several-URLs message and no
   `sign-in-required`.
   Redirects: with a global `http.https://<host>.followRedirects=true` and a destination
   that answers with a redirect to another host, the probe does not follow it and makes
   no request to that host.
6. `git.signIn` outcomes: exit 0 and a dry-run delete refused because the probe branch does
   not exist answer `signedIn`; an
   authentication failure answers `failed`; a runner that never exits answers `timedOut`
   at the configured cap (the test injects a short cap) and its process is killed; an
   interrupt answers `cancelled` and kills it.
7. Locks: while a `git.signIn` is pending, a status read on the same worktree completes and
   a Git Manager operation on the same project acquires the project lock.
8. Stream tests: a `desktop-bootstrap` principal with the flag on receives
   `sign-in-required`; with the flag off, a paired principal, no principal, and an MCP
   principal through `invoke_local_stream`, the same failure is today's `authentication`
   and no `sign-in-required` is sent.
9. Resume: each `resume` request with `expectedDestination` succeeds when the destination
   is unchanged, and fails with `destination-changed` before any network spawn when the
   remote's URL was changed after the approval.
10. Source Control: `vcs.pull` interrupted mid-transfer kills its Git process and ends with
    the cancelled error; `git.runStackedAction` cancelled in its push phase keeps the commit
    and sends the "Push cancelled" failure; both report `sign-in-required` on an eligible
    session only.
11. `ServerConfig`: `interactive_git_sign_in` is false by default, from `bibcode serve`, and
    from a WSL bootstrap; `server_config_for_launch` sets it.
12. Profiler: each `git.signIn` outcome emits one `git.signInEnded` with no remote, URL,
    host or output; `is_long_running("git.signIn")` is true.

Contracts and web:

12. Contract tests decode `sign-in-required`, `GitSignInRequiredError`, the `signIn` field,
    and the `git.signIn` schemas.
13. Git Manager and Source Control component tests: the approval names host, path and
    remote; Not now gives the authentication error; Sign in shows the waiting state with
    Cancel; `signedIn` sends the outcome's `resume` request once with
    `expectedDestination`, a stacked action resumes as `push` or `create_pr` without a
    second commit, and a branch delete resumes as `remote-branch-delete`; a second `sign-in-required` after
    a sign-in shows the error without a new offer; the Source Control Cancel appears only while
    pulling and in the push phase.

Native checks, added to `docs/testing/windows-desktop.md`, `macos-desktop.md` and
`linux-desktop.md` by the implementer, not run in this round:

14. Windows 11, Git for Windows with GCM, no stored credential for a private HTTPS
    repository: Git Manager Fetch shows the approval with the right host; Sign in opens
    GCM's window; finishing it completes the fetch, and a second fetch needs no sign-in.
    Repeat for Push and for Source Control commit and push. Cancel during the window closes
    it; waiting 10 minutes times out. The same fetch from the `/mcp` `git_fetch` tool fails
    with the authentication error and no window.
15. macOS with GCM installed: the same checks, plus that GCM detects a desktop session when
    Git runs under the desktop app (unverified today). With only `osxkeychain`, no approval
    appears and the error is unchanged.
16. Linux desktop with GCM and `credential.credentialStore=secretservice`: the same checks.
17. A WSL server and a paired browser on an exposed desktop server: no approval; the
    authentication error as today.
18. Confirm on each OS that GCM's line reaches Git's stderr at column 0 as "fatal: Cannot
    prompt because user interactivity has been disabled.", and that a successful
    `ls-remote` and the dry-run delete make Git store the credential on GitHub, GitLab and
    Azure DevOps. If either differs, the
    detection string or the probe changes with it.

## Documents changed at implementation

- `docs/architecture/rpc-and-orchestration.md`, "Git process environment" and "Git Manager
  flow", plus the Source Control methods (coordinator-reserved for this round; text in the
  lane report).
- `docs/architecture/overview.md`, Profiler section (coordinator-reserved).
- `docs/skills/bibcode-profiler/references/events.md`.
- The three desktop runbooks under `docs/testing/`.
- `2026-11-07-checkpoint-git-isolation-design.md` question 1 is answered by this note; that
  file is left unchanged.

## Risks

- GCM's line is matched as text. A GCM release that rewords it turns the offer off, never
  on. Test 18 guards it.
- GCM may not detect a desktop session for a Git spawned by the desktop app on macOS. Then
  it falls back to the terminal, `GIT_TERMINAL_PROMPT=0` blocks it, and `git.signIn`
  answers `failed`. Test 15.
- When the person's own environment or Git configuration sets `GCM_INTERACTIVE=never` or
  `credential.interactive=never`, the approval still appears, then `git.signIn` inherits
  the setting and answers `failed`.
- A credential that reads but cannot write (a fetch sign-in followed by a push) makes the
  push fail; the push then offers its own sign-in, whose dry run asks for write access.
- Cancel cannot take back a sign-in the person already finished.
- A server that serves the receive-pack advertisement anonymously and authenticates only
  the pushed data lets the dry-run delete answer `signedIn` without storing anything; the
  resumed push then reports `sign-in-required` again and the panel shows "Signed in, but
  Git Credential Manager still asked to sign in." Test 18 checks GitHub, GitLab and Azure
  DevOps.

## Review findings and resolutions

Codex review (gpt-6.1-sol, high) of revision 0 at `50b8223c1a`. No authentication bypass
found. Each finding was checked against the source.

| #    | Finding                                                                                                                                                                                                    | Checked                                                                                     | Resolution                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2 1 | Remote sideband text can contain GCM's message and force a retry and a misleading banner, even with only `osxkeychain`. Ask the person to approve a named destination; an agent can rewrite the URL first. | Accepted: revision 0 matched the message anywhere in stderr.                                | **Fixed.** No automatic retry. Detection needs a line starting with GCM's refusal, which sideband lines (`remote: ` prefix) cannot produce. The person approves "Sign in to host/path for remote X"; `git.signIn` re-resolves the URL, refuses if it changed, and passes the URL string to Git. Only `https://`. Tests 2, 3, 4, 5. |
| P2 2 | An abandoned sign-in holds `begin_mutation`, which closes the status read gate and owns the mutation mutex (`status_owner.rs:507-540`); Source Control mutations take it too (`git_vcs.rs:801-843`).       | Confirmed in `begin_mutation`.                                                              | **Fixed by redesign.** The sign-in is its own RPC with no project lock and no status guard; the operation released both when it failed and revalidates on rerun. Blocked callers are listed in [Locks while a sign-in is open](#locks-while-a-sign-in-is-open); test 7.                                                            |
| P2 3 | Cancel cannot promise nothing was stored: GCM OAuth persists refresh tokens before returning, Entra registers an MSAL cache, and a group or Job kill does not close an OS broker window.                   | Accepted; the generic provider line numbers come from the review and were not re-read here. | **Fixed.** [Cancellation and timeout](#cancellation-and-timeout) says cancel stops BiBCode's processes and the probe, not authentication, and names the browser tab and the broker window. The research section is corrected.                                                                                                      |

Codex review (gpt-6.1-sol, high) of revision 1 at `832ff8488`. The desktop gates, the single
sign-in slot and the Source Control pull cancel were confirmed. Four findings, each checked
against Git's source at v2.51.0 and BiBCode at `c079af0048`.

| #    | Finding                                                                                                                                                               | Checked                                                                                                                                                                  | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2 4 | The line-start trigger can still be forged: band-3 sideband prefixes its payload once.                                                                                | Confirmed: `sideband.c` L170-178 adds one `remote: ` before the whole band-3 payload.                                                                                    | **Fixed by framing.** The trigger is an untrusted hint. A forged one only shows an approval naming the frozen destination, which the person can decline. Test 3 adds the multiline band-3 and protocol-error cases.                                                                                                                                                                                                                                                |
| P2 5 | Passing the URL to `git.signIn` does not pin the destination: Git rewrites an explicit URL argument again, so A to B and B to C contacts C and can defeat HTTPS-only. | Confirmed: `remote.c` L799 sends an unknown name through `add_url_alias` (L93-100), which applies `insteadOf` and `pushInsteadOf` once with the longest prefix (L42-66). | **Fixed.** [Freezing the destination](#freezing-the-destination): the probe runs in an empty BiBCode-owned repository, refuses when any `insteadOf` or `pushInsteadOf` value prefixes the destination, sets `GIT_ALLOW_PROTOCOL=https` (`transport.c` L1114-1131) and `http.followRedirects=false`. The remaining window needs write access to the person's global Git configuration, which already allows running any program as `credential.helper`. Tests 4, 5. |
| P2 6 | Replaying a branch delete cannot finish the remote deletion, because the local branch is already gone.                                                                | Confirmed: `operations.rs:1299-1329` deletes the local branch before the remote step.                                                                                    | **Fixed.** The failure carries `resume: remote-branch-delete` for the failed remote step. Tests 2, 13.                                                                                                                                                                                                                                                                                                                                                             |
| P2 7 | The automatic rerun is not bound to the approved destination.                                                                                                         | Accepted: revision 1 rebuilt the request without the destination.                                                                                                        | **Fixed.** The panel sends the server-provided `resume` request with `expectedDestination`; the operation re-resolves its effective URL under its lock right before the network step and fails with `destination-changed` on any difference. Test 9.                                                                                                                                                                                                               |

Codex narrow check of revision 2. Two findings, both checked against Git v2.51.0.

| #    | Finding                                                                                      | Checked                                                                                                                                               | Resolution                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2 8 | A URL-specific global `http.<url>.followRedirects=true` beats the generic `-c` key.          | Confirmed: `http.c` L1305-1321 collects `http.*` through `urlmatch_config_entry`, and `cmp_matches` (`urlmatch.c` L544-554) prefers the closer match. | **Fixed.** The probe also sets `http.<destination>.followRedirects=false`; it matches most closely and wins ties as the last entry. Test 5.                                    |
| P2 9 | `get-url --push` prints only the first push URL, but `git push <remote>` visits all of them. | Confirmed: `builtin/push.c` L435-444 loops over every push URL.                                                                                       | **Fixed.** Detection, `git.signIn` and the resume check count URLs with `--all` and offer or accept a sign-in only for a remote with exactly one URL in the direction. Test 5. |

## Questions only Mauro can answer

None open. Revision 0's five questions are answered (M1 to M5).
