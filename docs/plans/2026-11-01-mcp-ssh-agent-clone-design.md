# MCP clone: SSH agent clones pinned to the checked address (#217)

Status: **Proposed, needs the user's decision** (see [Decision for the user](#decision-for-the-user)).
Issue: #217. Follows #139 slice X6 and its Revision 4 (`docs/plans/2026-10-30-mcp-remaining-slices-design.md`,
historical).

## Problem

An outside agent's clone (`clone_repository`, and `vcs.clone` / `sourceControl.cloneRepository`
called by an `mcp-client` principal) accepts HTTPS only. SSH was refused because `ssh` resolves
the host again after BiBCode's check, so DNS can move it to a private address that presents a
host key the person already trusts (Revision 4, X6 P2). The issue asks to allow SSH with the same
guarantee as HTTPS: pinned to the checked public address, host key verified for the hostname, in
an isolated environment, and to decide whether an agent clone may use the person's SSH keys.

## Current behavior

- `apps/server/src/git/clone_policy.rs:11-14` and `:221` (`target`): every URL that does not
  start with `https://` is `clone_url_refused` with `NOT_HTTPS` (`:122`), before Git or DNS run.
- `clone_policy.rs:388` (`environment`) and `:76` (`INHERITED`): agent clone Git commands run
  with `env_clear` plus an allowlist (`PATH`, temp folders, `LANG`, `LC_*`, `TZ`, Windows system
  variables), `HOME` = null device, `GIT_CONFIG_GLOBAL` = null device, `GIT_CONFIG_NOSYSTEM=1`,
  no proxies, `GIT_ALLOW_PROTOCOL=https`. `SSH_AUTH_SOCK`, `GIT_SSH`, `GIT_SSH_COMMAND` and
  `GIT_SSH_VARIANT` are therefore never inherited today.
- `clone_policy.rs:431` (`plan`): checks the Git version (2.37 for `http.curloptResolve`),
  expands `insteadOf` with `git ls-remote --get-url`, checks every address of the original and
  rewritten host (`is_public`), and pins each named host with
  `http.curloptResolve=<host>:<port>:<first address>`.
- `apps/server/src/git/repository.rs:7502` (`ReservedClone::transfer`): runs `git -c … clone
  --template= -- <url> <leaf>` with the plan; maps curl's 3xx into an actionable message
  (`:7545`). `git_environment` (`:7892`) adds `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS=`,
  `SSH_ASKPASS_REQUIRE=never`, `GCM_INTERACTIVE=never`.
- `apps/server/src/production/git_vcs.rs:1796` (`agent_clone_plan`): only `mcp-client`
  principals get a plan; a person's clone is unchanged (and keeps SSH).
- HTTPS agent clones are effectively anonymous: the global and system configuration (and so
  every credential helper, Git Credential Manager included) is off. `docs/reference/mcp.md`
  ("Git uses the credentials it already has, which in this isolated environment means none")
  and `docs/user/mcp.md` ("it reaches only public repositories directly") say so.

## Verified facts (2026-11-01, this machine)

Clients: Git for Windows 2.56.0 bundled `/usr/bin/ssh` = `OpenSSH_10.6p1`; Windows
`C:\Windows\System32\OpenSSH\ssh.exe` = `OpenSSH_for_Windows_9.5p2`. Linux and macOS ship
upstream OpenSSH (macOS with Apple patches); their option parser is the same `readconf.c`.
Each fact below was checked on both Windows clients with `ssh -G` and with real connections to
`github.com` / `ssh.github.com:443` (no key offered):

1. **Which `ssh` Git runs.** Git for Windows prepends `/ucrt64/bin` and `/usr/bin` to `PATH`, so
   a plain `ssh` is the bundled MSYS client, not the Windows one (`git -c alias.w='!command -v
   ssh' w` printed `/usr/bin/ssh`). Git invokes `ssh -o SendEnv=GIT_PROTOCOL -p <port>
   <user>@<host> 'git-upload-pack …'` (`GIT_TRACE`), appending to `GIT_SSH_COMMAND` through
   `sh -c`.
2. **`-F none`** reads no configuration file: a user config with `ProxyCommand /bin/false`,
   `ControlMaster auto` and `ControlPath` is in effect with `-F <it>` and absent with `-F none`.
3. **Pin + alias.** `-o HostName=<checked IP> -o HostKeyAlias=github.com` connects to the IP and
   looks the key up under `github.com`: with an empty known_hosts, "No ED25519 host key is known
   for github.com … Host key verification failed"; with a known_hosts holding the key under
   `github.com` only, the host key is accepted (`git@<IP>: Permission denied (publickey)`); with
   the key filed under another name, verification fails.
4. **Non-default ports.** With `HostKeyAlias`, ssh does not add the port: for
   `ssh.github.com:443` an alias `ssh.github.com` fails against a known_hosts entry
   `[ssh.github.com]:443`, and the alias `[ssh.github.com]:443` passes. The alias must be
   `[host]:port` when the port is not 22.
5. **Fail closed.** An unknown option is `command-line: line 0: Bad configuration option` and
   ssh exits 255; ssh never silently ignores an `-o` (unlike Git's unknown `-c` keys).
6. **No keys means no public SSH.** GitHub answers `Permission denied (publickey)` without a key,
   so "public-read over SSH" does not exist on GitHub (GitLab behaves the same). An SSH agent
   clone is useful only with the person's key.
7. `-o IdentityFile=none` suppresses the default `~/.ssh/id_*` files (`-v` offers none);
   `IdentityAgent=none`, `BatchMode=yes`, `StrictHostKeyChecking=yes`, `UpdateHostKeys=no`,
   `CheckHostIP=no`, `ForwardAgent=no`, `ClearAllForwardings=yes`, `ControlMaster=no`,
   `ControlPath=none`, `ProxyCommand=none` are accepted by both clients; a quoted
   `UserKnownHostsFile="C:/Users/Some Name/.ssh/known_hosts" "…/known_hosts2"` parses on both.

Not verified here: ssh-agent authentication (the Windows `ssh-agent` service is disabled on this
machine and `SSH_AUTH_SOCK` is unset), macOS and Linux runs. The implementation's real-`ssh -G`
test (below) runs on all three CI operating systems; agent authentication is a manual runbook
step.

## Options for the key question

| Option | What an agent can reach | Security | Cost |
| --- | --- | --- | --- |
| **A. Person's ssh-agent, strict known_hosts** | Every repository the person's loaded SSH keys can read on a public host, private ones included | **Widens** what an agent can read: today an agent clone is anonymous (public HTTPS only). The agent picks the host and repository, so a prompt-injected agent can pull a private repository it was never pointed at. Host key checked against the person's known_hosts, never written. | Policy + plan + error mapping; no new UI |
| **B. Refuse SSH, point to HTTPS** | Unchanged (public HTTPS) | No change | Message only: the refusal names the `https://` equivalent of an SSH URL on a known forge form |
| **C. Per-request approval prompt** | A, one URL at a time, after the person approves | Narrowest A; the person sees the URL | New approval UI, persisted pending state, timeouts inside the 50 s wait, behaviour with nobody watching. No such prompt exists for outside-agent tools today. |

Two gates were considered for A:

- **A1, the Terminals gate (recommended form of A).** SSH clones are allowed only when the agent
  could already run `git clone` over SSH as the person: the **Terminals** set on, an effective
  ceiling of Full access, and a credential holding `terminal:operate` — the same three checks
  `mcp/tools/terminals.rs` makes (`check_full_access`, the set and the scope). Such an agent has
  a shell as the server's user, with the person's ssh-agent, so A1 grants no new reach. What it
  adds over the shell is the tool's guarantees (pinned, checked public address, isolated
  configuration, owned and cancellable, registered as a project), which still matter against a
  confused or prompt-injected agent that is handed an `ssh://` URL pointing inside the network.
- **A2, a dedicated switch** ("Agents may clone over SSH with your SSH keys", off by default).
  SSH clones without granting terminals. New setting, persisted field, Settings row and docs;
  this is the genuinely widening variant.

**Recommendation: A1, with B's message for every agent that does not pass the gate.** It
delivers the issue (pinned SSH clones with the person's keys) without widening what any agent can
reach, and needs no new setting, persisted shape or UI. A2 and C are follow-ups if the person
wants SSH clones for agents without terminals.

### Decision for the user

1. **Confirm that an agent clone may use the person's SSH agent at all** (option A). This is a
   credential-use decision the issue leaves open.
2. **Confirm the gate: A1 (only agents that already hold terminals at Full access)** — no new
   reach — or A2 (a new off-by-default switch), which widens agent reach to private
   repositories without a shell.
3. If neither is confirmed, implement **B only** (better refusal message) and close #217 as
   "SSH stays refused for agents".

The rest of this design assumes A1 and is unchanged under A2 except for the gate predicate.

## Design (A1)

### URL shape

- Accept `ssh://[user@]host[:port]/path` with the same plain-writing rule HTTPS has (the `url`
  crate's canonical form equals the input, ignoring case; no password; no trailing dot; no
  encoded host). `user` matches `[A-Za-z0-9._-]+` and does not start with `-`; Git already
  refuses a host starting with `-`.
- Refuse the scp-like `user@host:path` and `git+ssh://` / `ssh+git://` with `clone_url_refused`
  and a message naming the `ssh://` spelling (computed when the input has the simple
  `user@host:path` form: `git@github.com:owner/repo.git` → `ssh://git@github.com/owner/repo.git`).
  Parsing Git's scp-like rules exactly is not worth a second host parser.
- Every other transport stays refused as today.

### Order of checks in `ClonePolicy::plan`

1. Leaf check, URL shape (above). An SSH URL from an agent that fails the gate is refused here
   with the new reason `clone_ssh_not_allowed` (before DNS and Git run), naming the HTTPS
   equivalent for `github.com`, `gitlab.com`, `bitbucket.org` and `codeberg.org`, otherwise
   "use the repository's https:// URL".
2. Git version (unchanged; 2.37 stays the floor for all agent clones; SSH alone needs only
   `GIT_SSH_COMMAND` 2.3 and `GIT_SSH_VARIANT` 2.16).
3. `git ls-remote --get-url` (unchanged). The **expanded** URL decides the transport Git uses:
   `GIT_ALLOW_PROTOCOL` and `protocol.<transport>.allow=always` admit exactly that transport (an
   `ssh` → `https` rewrite gets the HTTPS plan; `https` → `ssh` gets the gate and the SSH plan).
   Both URLs must pass the shape and address checks, as today.
4. Resolve and check every address (unchanged `addresses`), then pin the expanded SSH target.

### The pinned SSH command

The plan sets `GIT_SSH_COMMAND` (the highest-precedence source, above `core.sshCommand` from the
enclosing repository's configuration; the server's own value is never inherited) and
`GIT_SSH_VARIANT=ssh`:

```
<ssh> -F none
  -o HostName=<first checked address, IPv6 without brackets>
  -o HostKeyAlias=<host>            (or [<host>]:<port> when the port is not 22)
  -o StrictHostKeyChecking=yes -o BatchMode=yes
  -o UpdateHostKeys=no -o CheckHostIP=no
  -o UserKnownHostsFile="<home>/.ssh/known_hosts" "<home>/.ssh/known_hosts2"
  -o IdentityFile=none -o IdentityAgent=<agent, see below>
  -o ProxyCommand=none -o ControlMaster=no -o ControlPath=none
  -o ForwardAgent=no -o ClearAllForwardings=yes
  -o ConnectTimeout=30
```

- **Pinning.** `HostName` is a literal address, so ssh resolves nothing; Git's destination
  argument (`user@host`) only supplies the user. Git's `-p <port>` comes from the URL that was
  checked; the plan sets no `Port` so the two cannot disagree. Any SSH connection this Git makes
  (the expanded URL's, and none other since submodules are off) goes to the checked address and
  must present the checked host's key.
- **Host key.** Verified under the hostname (`HostKeyAlias`) against the person's known_hosts
  (`<home>` = `dirs::home_dir()` of the server process, as `config.rs` already uses) and the
  client's default global file. `StrictHostKeyChecking=yes` never adds a key and
  `UpdateHostKeys=no` never rewrites one: BiBCode never writes the person's known_hosts for an
  agent. An unknown key fails, so DNS rebinding to a private address cannot succeed: the address
  is pinned, and a host that is not the trusted one fails verification.
- **Configuration isolation.** `-F none`: no `~/.ssh/config`, no system `ssh_config`, so no
  `Include`, `ProxyJump`, `ProxyCommand`, `Match exec`, `LocalCommand`, `KnownHostsCommand`,
  `ControlMaster` reuse, forwarding or custom identity of the person's. The explicit
  `ProxyCommand=none`, `ControlPath=none` and `ForwardAgent=no` repeat the defaults so the
  generated command states its guarantee. A person whose known_hosts lives elsewhere (set in
  their `ssh_config`) gets the unknown-key refusal below.
- **Keys: the agent only.** `IdentityFile=none` means BiBCode never makes ssh read a private key
  file for an agent; only keys the person loaded into their agent are offered. Encrypted keys
  would fail under `BatchMode` anyway, and the person controls what is available by loading or
  removing keys. Keys added with `ssh-add -c` (confirm) fail, since `SSH_ASKPASS` is off.
- **Quoting.** Every value is single-quoted for `sh` (`'` → `'\''`); paths inside
  `UserKnownHostsFile` are double-quoted for ssh. Paths use `/` on Windows. Host names are
  plain DNS names by the shape rule.
- **Agent and client per platform.**
  - Linux, macOS: `<ssh>` = `ssh` (from the allowlisted `PATH`, the client the person's Git
    uses). `IdentityAgent` = the server process's `SSH_AUTH_SOCK` when it names an existing
    socket; otherwise `clone_ssh_unavailable`. macOS GUI apps get launchd's `SSH_AUTH_SOCK`.
  - Windows: when `SSH_AUTH_SOCK` is set, Git's bundled `ssh` with that value (MSYS agents,
    `ssh-pageant`). Otherwise `%SystemRoot%\System32\OpenSSH\ssh.exe` with its default agent
    (the `\\.\pipe\openssh-ssh-agent` pipe of the "OpenSSH Authentication Agent" service), when
    both the binary and the pipe exist; otherwise `clone_ssh_unavailable`. The bundled MSYS
    client cannot reach that pipe, which is why the Windows client is chosen explicitly.
  - A server started over SSH or in WSL has an agent only if its environment carries one; the
    refusal says so.
  An old client lacking an option fails with "Bad configuration option" (fact 5), mapped to
  `clone_ssh_unavailable`.

### Environment and Git settings for an SSH plan

Beside today's isolation: `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT=ssh`, `GIT_ALLOW_PROTOCOL=ssh`,
`-c protocol.allow=never -c protocol.ssh.allow=always`, and `SSH_AUTH_SOCK` only when the agent
is a socket. `HOME` stays the null device (no file under it is needed: every ssh path is
explicit). The `http.*` settings stay (harmless) and LFS, submodule, hooks and fsmonitor
settings are unchanged.

### The gate

One predicate, shared with the terminal tools rather than copied: "this principal may act as the
server's user" = Terminals set on, effective ceiling Full access (`McpControl::effective_ceiling`),
scope `terminal:operate`. `terminals.rs` keeps calling it; `GitVcsRpcServices::agent_clone_plan`
passes its result to `ClonePolicy::plan`, so `vcs.clone` and `sourceControl.cloneRepository`
called directly meet the same gate. If `GitVcsRpcServices` cannot reach the live MCP settings,
the implementation adds that handle (it is the same server); it must not fall back to the scope
alone, which outlives a person turning Terminals off.

### Failure messages (reason, then message)

- `clone_ssh_not_allowed`: "Agent clones over SSH use your SSH keys, so BiBCode allows them only
  when Terminals is on and Agents may is at Full access. Clone https://github.com/owner/repo.git
  instead, or clone it in BiBCode yourself."
- `clone_url_refused` (scp-like): "Write the SSH URL as ssh://git@github.com/owner/repo.git."
- `clone_ssh_unavailable`: "BiBCode found no SSH agent for this server (SSH_AUTH_SOCK is not
  set). Start ssh-agent and add your key with ssh-add, or clone over https://." On Windows:
  "Start the OpenSSH Authentication Agent service and add your key with ssh-add, or clone over
  https://." For an unsupported client: "This server's ssh does not support <option>. Update
  OpenSSH, or clone over https://."
- Git failures keep `GitCommandError` and get one appended line, as the redirect mapping does
  (`repository.rs:7545`), matched on ssh's stable stderr:
  - "Host key verification failed" / "No … host key is known": "BiBCode checks <host>'s key
    against your known_hosts and never adds one for an agent. Connect once yourself (ssh -T
    <user>@<host>) to trust it, then retry."
  - "REMOTE HOST IDENTIFICATION HAS CHANGED": "The server at the checked address does not have
    the key you trust for <host>, so BiBCode stopped. Check the host before trusting a new key."
  - "Permission denied (publickey": "No key in your SSH agent is accepted by <host>. Add one
    with ssh-add, or clone a public repository over https://."
- `clone_host_refused`, `clone_host_unresolved`, `clone_git_too_old`: unchanged.

New reasons are additive extra fields on the existing `GitCommandError` /
`SourceControlRepositoryError` (as X6 did); no contract change.

## Persisted, protocol and security impact

- **Persisted:** none under A1 (A2 would add one settings field).
- **Protocol:** no new RPC method or tool; two new `reason` strings; the `clone_repository`
  description says SSH needs the Terminals gate.
- **Security:** A1 adds no reach beyond terminals. Residual risks: (1) the person's ssh-agent is
  offered to the checked public host, so a malicious public host learns the person's public keys
  (as any SSH connection does) and could use agent-forwarding only if forwarding were on (it is
  off); (2) a person's clone of the same URL that an agent joins stays unpinned (existing,
  documented); (3) behind an SSH-only network that requires a jump host, agent SSH clones fail
  closed (`ProxyJump` is ignored).

## Profiler coverage

- **Child processes:** ssh is Git's child, spawned inside the clone's supervised Git process
  (`process::supervised` through the repository runner), so cancellation, the stall timeout and
  reaping cover it; a test proves a stalled ssh is stopped on cancel (Windows included). No new
  BiBCode-owned process; ssh-agent is the person's and is not registered.
- **RPC methods:** none new; `vcs.clone` and `sourceControl.cloneRepository` are already in
  `is_long_running` (`diagnostics/profiler/latency.rs:121`).
- **Events, findings, logs:** no new profiler event. Refusals are returned, not logged; no URL
  user, key or known_hosts content is logged.
- Worktree removal, binaries, shutdown: not touched.

## Test plan

Acceptance criteria from the issue, each with its test (fails first: each SSH-accepting test is
seen failing against today's `NOT_HTTPS` refusal, each isolation test with the option removed).

| Criterion | Test |
| --- | --- |
| SSH pinned to the checked public address | Unit: `plan` for `ssh://git@github.com/o/r.git` with a map resolver returns `GIT_SSH_COMMAND` with `HostName=<first address>`, `HostKeyAlias=github.com`; port 2222 gives `[host]:2222`; IPv6 gives a bare address. A name resolving to any private address is `clone_host_refused` and the fake ssh is never run. |
| Host key verified under the hostname | Real-client test (all CI OSes; returns early with a printed note if no `ssh`): run the system `ssh -G` with the generated options and assert `hostname`, `hostkeyalias`, `stricthostkeychecking true`, `batchmode yes`, `identityagent`, and no `proxycommand`/`controlpath` lines, with a `$HOME`/user config holding `ProxyCommand` and `Include` present to prove `-F none`. |
| Isolated environment | Integration (`cfg(unix)`, Windows where Git's `sh` runs it): a **fake ssh** script, injected through `FixtureAllowance` as `<ssh>`, records its argv and runs the requested `git-upload-pack '<path>'` locally against a bare fixture repository, so a full SSH-transport `clone_repository` → `vcs.clone` → `transfer` → registration runs hermetically. The fixture's inherited environment sets `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_SSH_VARIANT=plink` and the enclosing repository sets `core.sshCommand`; the recorded argv is BiBCode's command. |
| Keys: decision enforced | Integration: an agent without the gate gets `clone_ssh_not_allowed` naming the HTTPS URL; with Terminals on, Full access and `terminal:operate` it clones; turning Terminals off after minting refuses again. |
| Rewrites | Unit: `insteadOf` ssh → private ssh host refused; ssh → https gets the HTTPS plan and `GIT_ALLOW_PROTOCOL=https`; https → ssh meets the gate. |
| Actionable failures | Unit: the stderr mapping for unknown key, changed key, publickey denial and "Bad configuration option"; the fake ssh exits 255 with each stderr in one integration case. Unit: scp-like URL refused naming the `ssh://` form; quoting round-trip of paths with spaces and `'`. |
| People's clones unaffected | Existing person-clone tests stay green; one asserts a person's SSH clone gets no plan. |
| Cancel stops ssh | Integration: a fake ssh that sleeps; `cancel_clone` stops it and removes the folder. |

Not hermetic, so a manual step: `docs/testing/cross-platform-validation.md` gains "agent SSH
clone" on Windows (both agent kinds), Linux and macOS against one of the user's
`sample-project` repositories with a key loaded, plus the unknown-known_hosts negative.

## Docs to update in the implementation

- `apps/server/src/git/clone_policy.rs` module doc (Revision 4 sentence replaced).
- `docs/architecture/rpc-and-orchestration.md` "Clone tools" (SSH plan, gate, reasons).
- `docs/reference/mcp.md` clone section (`:3940-3947`: transports, reasons) and
  `docs/user/mcp.md` clone bullets (`:424-433`).
- `docs/skills/bibcode-mcp/SKILL.md` if it states HTTPS-only (currently it does not).
- `docs/testing/cross-platform-validation.md` (manual step above); `ssh-environments.md`
  reviewed (an SSH-launched server has no agent unless its environment carries one).
- No profiler reference change.

## Open questions and decisions

| Question | Decision |
| --- | --- |
| HostKeyAlias + IP, or ProxyCommand to the checked address? | **HostKeyAlias + `HostName=<IP>`**: verified on both Windows clients; a `ProxyCommand` would need a helper (`nc`/`ssh -W`) not present everywhere and adds a process. |
| `-F none` or a generated config? | **`-F none` with `-o`**: no file to create, clean up or race; same effect. |
| Which client on Windows? | Bundled MSYS `ssh` when `SSH_AUTH_SOCK` is set, else the Windows OpenSSH client with its agent pipe; refuse when neither has an agent. |
| Key files or agent? | **Agent only** (`IdentityFile=none`). |
| Write known_hosts? | **Never** (`StrictHostKeyChecking=yes`, `UpdateHostKeys=no`). |
| Agent forwarding, ControlMaster, ProxyJump? | **Off**; a jump-host network fails closed. |
| May agent clones use the person's keys? | **User decision** (above); recommended A1. |
