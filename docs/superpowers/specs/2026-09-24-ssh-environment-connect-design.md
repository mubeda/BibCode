# SSH environments: launch, pairing, and reconnect credentials

Status: **Approved by the user on 2026-09-24** (the recommended option on every ruling; the user explicitly chose "SSH access decides" for revocation and standard scopes).

Input: research item 2 of `docs/plans/remote-servers/orca-fixes-since-port-research.md`
("SSH connect and reconnect re-exchange a consumed one-time token"), verified by the s1-ssh
spike on 2026-09-24 at `fd5effbb`.

## Problem and evidence

Desktop-managed SSH environments cannot be added, and could not stay connected if they were.
Three independent defects each break **Add** on a real host, which meets them in the order
A, B, C. The throwaway spike `apps/desktop/src-tauri/tests/ssh_token_reuse_spike.rs`
(untracked, `#[ignore]`d) drives the production `SshEnvironmentManager`, launch and stop
scripts, the real `bibcode` binary, and the production exchange. Only the SSH hop is fake: a
stand-in client runs remote commands locally, joined with spaces and run with `sh -c` as
`ssh(1)` and `sshd(8)` (OpenSSH 10.2p1) specify. Result: 2 passed, 3 failed, one per defect.

### A. The launch script cannot start the remote server

`ssh.rs:141` starts `serve` as `nohup env BIBCODE_NO_BROWSER=1 …`. The CLI declares that
variable as a strict boolean (`apps/server/src/config.rs:661-662`), so `serve` exits with
`invalid value '1' for '--no-browser' [possible values: true, false]` and the launch fails
after its 15 s readiness wait ("Remote BiBCode server did not become ready…", 15.97 s).

### B. The remote shell splits the pairing command

`issue_remote_pairing_token` passes `sh`, `-lc`, and
`bibcode pairing issue --base-dir "$HOME/.bibcode" --json` as three arguments
(`ssh.rs:1373-1409`). OpenSSH joins them and the remote login shell runs the result, so
`sh -lc` executes a bare `bibcode`; with A neutralized the fake remote `bibcode` received
`argc=0`. From source (the harness does not start it), a bare `bibcode` is `CliAction::Run`
(`config.rs:826-891`), a server on 127.0.0.1:3773: it exits with a bind error while the
managed server holds that port, and otherwise keeps running, so the pairing command, which
has no timeout (`ssh.rs:1396-1398`), hangs. Launch and stop survive the join: they send
`sh -s --` and write the script to stdin (`ssh.rs:1228-1288`).

### C. Reconnects re-exchange a consumed one-time token

`ensure_environment` returns a live tunnel's cached bootstrap before it looks at
`issue_pairing_token` (`ssh.rs:452-454`, `642-659`); that bootstrap keeps the one-time token
minted with the tunnel (`ssh.rs:495-521`, stored at `693`). Onboarding exchanges the token
(`apps/web/src/connection/platform.ts:202-233`) and discards the 30-day bearer it receives
(`packages/client-runtime/src/connection/onboarding.ts:250-271`; `SshConnectionRegistration`
has no credential, `catalog.ts:91-97`). Every supervisor preparation calls
`ensureSshEnvironment({ issuePairingToken: true })` and exchanges the same token again
(`platform.ts:289-321`). The server consumes pairing links atomically
(`apps/server/src/auth/service.rs:2145-2193`, `persistence/repositories.rs:2211`) and answers
401 (`auth/http.rs:768-771`); the bridge reports `[ssh_http:401]` (`bridge.rs:188-202`); the
web maps that to transient `remote-unavailable` (`platform.ts:188-200`); the supervisor
retries every 1–16 s forever (`supervisor.ts:31`, `621-658`).

With A and B neutralized, the onboarding exchange was accepted. The next `ensure` took 37 µs,
ran no SSH command, returned the same token, and its exchange got `[ssh_http:401]`. A fresh
token through the same tunnel was accepted, and a retry repeated the 401. A new manager
(desktop restart) and a killed tunnel each minted a new token and connected.

- **Stuck:** Add; any reconnect while the tunnel lives (remote restart or update, probe
  timeout); Retry; Disconnect then Connect (only intent flips, `registry.ts:802-822`); window
  reload or a second window (the tunnel map is host state); remove and re-add (repeats Add).
- **Recovers:** desktop restart, until the next drop that leaves the tunnel alive; a dead
  link, once ssh keepalive ends the tunnel (about 45 s).

**Related gaps.** A cache hit also skips launch and readiness, so a remote server that stops
under a live SSH session is never relaunched (code reading); the remote updates draft relies
on that relaunch (`2026-09-24-remote-server-updates-design.md:225-226`). Both SSH success
toasts say "Environment connected … is ready over an SSH-managed tunnel" when registration
returns, before any connection (`ConnectTab.tsx:1028-1032`, `1183-1189`).

**Why tests missed it.** The web fake bridge accepts every exchange of one token
(`platform.test.ts:161-209`), the only desktop reuse test covers a missing target
(`ssh.rs:2583-2601`), and no report records a live SSH **Add**. All three defects date from
the initial import (`bfbecf59`, 2026-07-31); the pairing repair `f65bed06` renamed only the
subcommand.

## Alternatives and decisions

### A. Launch environment

**Recommended:** drop `env BIBCODE_NO_BROWSER=1`; `serve` already implies no browser
(`config.rs:826`, `875`). **Ruling:** the CLI stays strict (`true`/`false`). Accepting `1`/`0`
would help only older desktops, which still fail at B and C, and would widen the parsing of
every boolean environment flag. Revisit it as CLI ergonomics, not in this fix.

### B. Pairing command transport

1. **Stdin script through `run_remote_ssh_script` (recommended).** A `REMOTE_PAIRING_SCRIPT`
   replaces `REMOTE_PAIRING_ISSUE_COMMAND` and travels like launch and stop. Only `sh -s --`
   reaches the login shell, which parses the same in POSIX shells, fish, and tcsh. The
   script runs under the same non-login `sh` as launch, the `PATH` the
   user guide documents (`docs/user/remote-access.md:160-161`), so pairing uses the `bibcode`
   that serves the environment.
2. **One shell-quoted argument.** Smaller, but the login shell still parses it (fish and tcsh
   quote differently), and `sh -lc` keeps a login `PATH` that can differ from the launch's.

**Timeout:** `run_remote_ssh_script` gains a per-operation deadline (pairing 30 s, launch 60 s,
stop 30 s); on expiry it terminates and reaps the SSH child and fails transiently. Launch and
stop share the helper, so **Add** becomes bounded end to end; deadlines inside the
supervisor's 15 s window stay with research item 5.

### C. Reconnect credentials

1. **Saved bearer plus a no-cache guard (recommended).**
   - Onboarding saves the bearer it already receives: `SshConnectionRegistration` gains
     `credential: BearerConnectionCredential`, written in the same catalog update as bearer
     registrations (`platform/storageDocument.ts:121-144`) and removed with the entry.
   - Reconnects call `ensureTunnel` (`issuePairingToken: false`), then `authorizeBearer` with
     the saved bearer, as bearer targets do (`resolver.ts:111-166`). No SSH command runs
     while the tunnel lives.
   - When the bearer is missing, or `authorizeBearer` fails with
     `ConnectionBlockedError("authentication")` (`connection/errors.ts:114-119`), `mintBearer`
     runs once: `ensureSshEnvironment({ issuePairingToken: true })`, exchange, save, retry. A
     rejection after that mint becomes `ConnectionBlockedError("authentication")`, and the
     supervisor waits for Retry instead of looping.
   - Saved SSH targets without a credential mint on their next connection; credentials are a
     separate array keyed by connection id, so no stored document is rewritten. The refreshed
     credential is written only if the entry still exists, so removal leaves no orphan.
   - Desktop guard: cached bootstraps never carry a token, and `issue_pairing_token: true` on
     a live tunnel always mints fresh. The gateway's `prepare` becomes `ensureTunnel` and
     `mintBearer`; `provision` keeps its order (mint, fetch the descriptor, then exchange), so
     a descriptor failure still does not spend the token (`platform.test.ts:305-323`).
2. **Guard only (mint on every preparation).** Every reconnect runs an SSH command inside the
   15 s window (possibly a password prompt, item 5) and adds a 30-day session that is never
   superseded; at `MAX_ACTIVE_SESSIONS = 4096` (`auth/limits.rs:6`, `service.rs:2103-2106`)
   issuance fails for every client of that host. Rejected.
3. **The desktop keeps the bearer in memory.** Survives reloads without a catalog change, but
   mints on every app start and changes the bridge contract more. Rejected.

**Ruling for the user:** a bearer revoked on the host is minted again on the next connection,
because SSH access is the real authority. To cut a desktop off, remove its SSH access or the
environment on that desktop; the user guide says so.

### Scope of the SSH bearer

`/oauth/token` accepts `scope` (`auth/http.rs:152`) and refuses anything outside the grant
(`service.rs:826-832`); `auth_http.rs:2006-2014` exchanges an administrative bootstrap for
exactly the standard set. Pairing-link onboarding already requests `AuthStandardClientScopes`
(`onboarding.ts:120`); only the SSH exchange sends none and gets `ADMINISTRATIVE_SCOPES`
(`service.rs:2678`). **Ruling:** `bootstrapSshBearerSession` gains an optional `scopes`
argument sent as `scope`, and the web passes `AuthStandardClientScopes`, so a leaked saved
bearer (renderer storage outside Windows) cannot mint pairings or manage access. Cost: an SSH
connection cannot create pairing links or offers (`auth/http.rs:244`, `289`) or use
`subscribeAuthAccess`, `auth.confirmPairing`, or relay-client install
(`auth/scope.rs:145-153`); updates need only `orchestration:operate`. No regression: SSH
connections have never worked.

### Classification, relaunch, and onboarding

- **Classification:** the web reads the bridge's `[ssh_http:<status>]` prefix: 401 becomes
  `ConnectionBlockedError("authentication")`, 403 `"permission"`, 400 `"configuration"`;
  network errors and 5xx stay transient; a cancelled prompt stays blocked.
- **Relaunch:** on a cache hit, `ensure_environment` probes `/.well-known/bibcode/environment`
  through the tunnel (2 s, `ssh.rs:33`). On failure it drops the cached tunnel and takes the
  full path, whose launch-or-reuse relaunches a dead managed server. One round trip per
  preparation; it makes the updates draft's relaunch promise true.
- **No UI-level onboarding timeout:** the deadlines above bound every stage of **Add**, and
  the Tauri command cannot be cancelled, so a UI timeout would abandon work that keeps
  running. Stage copy needs progress events over the bridge; it belongs with item 5.

## UI and copy

- **SSH success toasts** (`ConnectTab.tsx:1028-1032`, `1183-1189`): **Environment added**
  (**Environment updated** for a saved alias), "<label> is connecting over SSH." The
  environment row shows the real state.
- **Blocked after a rejected mint:** "<host> rejected a new pairing credential. Choose Retry.
  If it keeps failing, remove the environment and add it again."
- **Pairing timeout:** "The remote host did not issue a pairing credential within 30 seconds.
  Check the connection and choose Retry."
- Nothing else changes. Review against `UI.md` and `vercel-react-best-practices`.

## Validation

- **Desktop unit tests** (`ssh.rs`, SSH program injected through a test-only constructor, no
  `PATH` changes): a cache hit carries no token; `issue_pairing_token: true` on a live tunnel
  mints, `false` runs no SSH command; a dead endpoint drops the cached tunnel; on Unix the
  pairing invocation, joined and run with `/bin/sh -c`, gives a recording fake `bibcode`
  `pairing issue --base-dir <home>/.bibcode --json`; a never-exiting fake SSH fails at a
  shortened deadline and is reaped; the launch script runs `serve` without environment
  assignments.
- **Desktop integration** (the converted spike, `tests/ssh_environment.rs`, Unix): real launch
  script, fresh `bibcode`, OpenSSH join semantics. Add then prepare accepts a fresh token; a
  no-token ensure runs no SSH command; restart; dead tunnel; relaunch after killing the remote
  server under a live tunnel; pairing timeout; standard scopes issued.
- **Client runtime:** onboarding saves the credential; the saved bearer connects with no
  mint; a missing credential mints once; a 401 mints once and retries; a second rejection
  blocks; a transient tunnel failure keeps the credential; removal deletes it and a later
  conditional write is a no-op.
- **Web:** the fake bridge rejects a second exchange of one token with the exact
  `[ssh_http:401] …` string, and provision followed by a reconnect succeeds; status prefixes
  map as above; the exchange passes `AuthStandardClientScopes`; toast copy.
- **Server:** none (narrowing is covered by `auth_http.rs:2006`, `service.rs:4483`). **Live:**
  the new runbook with key and with password authentication, plus the usual gates.

**The spike file** stays untracked until the implementation change, which removes it; its
scenarios become the assertions above. The fake client and remote wrapper move from the
scratchpad to
`apps/desktop/src-tauri/tests/fixtures/ssh/` (Python 3), keeping only the OpenSSH join mode.
Unit tests run in CI by default. The integration test stays `#[ignore]`, because it needs a
fresh `bibcode` that `cargo test -p bibcode-desktop` neither builds nor checks; CI's Test job
runs it after `cargo build -p bibcode-server --bin bibcode`, and so does the runbook.

## Documentation to update with the implementation

- **`docs/architecture/remote.md`, "Desktop-managed SSH"** (lines 707-759 at `fd5effbb`;
  741-793 in today's working tree): it says the host "returns a local HTTP/WSS bootstrap plus
  bearer credential" (it returns a one-time credential that the web exchanges), and its
  "Fresh setup mints …" paragraph describes a mint that A and B prevent without saying when
  minting happens. Rewrite both for the saved standard-scope bearer, minting on rejection
  only, the stdin script and deadline, the uncached token, relaunch, and the revocation rule;
  update the client-targets row (line 56) and the access-versus-launch diagram (767-774).
- **`docs/architecture/connection-runtime.md`** (the `SshConnectionTarget` row, line 74) and
  **`docs/operations/ci.md`** (the SSH integration step).
- **`docs/user/remote-access.md`, "Desktop-managed SSH"** (156-166): the desktop becomes a
  device with standard access on the host's Share tab; access management happens on the
  host; revoking it does not lock out a desktop that keeps SSH access.
- **New `docs/testing/ssh-environments.md`,** linked from `docs/testing/README.md`: a real
  host with `bibcode` on non-interactive `sh`'s `PATH`, key and password authentication;
  Add, remote restart with the tunnel alive, Disconnect then Connect, reload, desktop
  restart, optionally a dead link over 45 s; then exactly one device with standard scopes on
  the host; harness commands and cleanup.
- **`docs/testing/execution-report-template.md`:** an "SSH environment evidence" section
  (host OS and shell, authentication, remote CLI version, scenario table with evidence
  classes, device count and scopes before and after, exact errors). Research §2 may point
  here; it is historical and stays as written.

## Residuals

- **Research item 5 remains** (password prompt inside the 15 s window, uncancellable command,
  no single-flight). Reconnects no longer run SSH while the tunnel lives, but the first
  preparation after a restart still launches and tunnels inside that window, and two windows
  that see a 401 at once may each mint (one extra session).
- **Sessions:** one per **Add**, plus one per rejection-triggered mint; old ones expire after
  30 days, since a standard-scope bearer cannot revoke them. On macOS and Linux the saved
  bearer sits in renderer storage, as for bearer targets (`remote.md`, "Current limitations").
- **Unchanged:** research item 8 (one askpass answer for every prompt), no detection of an
  externally started server, and the fixed `~/.bibcode` data root. **Spike limits:** no live
  SSH host; OpenSSH emulated from its manual pages; askpass and Windows `ssh.exe` untested.
