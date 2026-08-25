# Process Lifecycle Validation

Use this focused runbook whenever a change affects process admission,
cancellation, shutdown, reaping, remote setup, WSL forwarding, SSH tunnels,
providers, terminals, or packaged desktop cleanup. Read
[Cross-platform validation](./cross-platform-validation.md) and the native OS
page first.

## Ownership invariant

Every spawned process has one retained owner from admission through terminal
wait and cleanup. Cancellation transfers ownership to a bounded reaper; it does
not detach a child. Natural leader exit does not release late descendants.
Independent BiBCode runtimes and unrelated host processes are never signalled,
waited, or reaped.

Record identity before any action:

| Platform    | Required identity                                                            |
| ----------- | ---------------------------------------------------------------------------- |
| Windows     | PID, parent PID, creation FILETIME, executable, command line, Job membership |
| Linux/macOS | PID, parent PID, process group, start time, executable, command line         |

Labels and command substrings are not sufficient ownership proof.

## Focused contracts

Select the owners affected by the change and run them before broad gates:

```sh
cargo test -p bibcode-server process:: --lib -- --nocapture
cargo test -p bibcode-server terminal::manager::tests:: --lib -- --nocapture
cargo test -p bibcode-server terminal::pty::tests:: --lib -- --nocapture
cargo test -p bibcode-desktop shell_environment::tests:: --lib -- --nocapture
cargo test -p bibcode-desktop remote_operation::tests:: --lib -- --nocapture
cargo test -p bibcode-desktop wsl:: --lib -- --nocapture
cargo test -p bibcode-desktop wsl_transport::tests:: --lib -- --nocapture
cargo test -p bibcode-desktop ssh::tests:: --lib -- --nocapture
cargo test -p bibcode-desktop --test bridge_public_contract -- --nocapture
cargo test -p bibcode-desktop --test ssh_public_contract -- --nocapture
```

Discover filters from current source and `cargo test -- --list`; omit an
inapplicable invented filter. On Windows, use
`node scripts/run-msvc-x64.mjs` before Cargo. Do not run broad Cargo commands in
parallel or serialize them to hide an ownership race.

## Required scenarios

For each affected owner, exercise:

1. successful natural exit with output tasks joined;
2. cancellation before spawn, during spawn, and during I/O;
3. child exit before ownership publication;
4. natural leader exit with a late descendant;
5. timeout followed by bounded terminate/wait/reap;
6. duplicate cancellation and a replacement generation;
7. shutdown while work is admitted and while rollback is running;
8. independent peer runtime survival; and
9. final zero-survivor evidence.

For server shutdown, prove mutation admission closes, accepted work drains,
provider/terminal roots are reaped, transport/control tasks join, and the store
guard is released in that order. A native service manager force-stop is only a
bounded fallback after protected local-control drain.

For WSL, include the server, Windows listener, every accepted-socket
`wsl.exe` forward, setup child, transfer I/O task, and rollback. A forward or
server failure must clean its peer. No unrelated distro or WSL process may be
terminated.

For SSH, include effective-config/trust probes, password prompt, askpass helper,
artifact work, transfer/install child, tunnel, descriptor/pairing stream,
stderr tasks, rollback, and private helper directory. Forget closes admission
before drain, and shutdown waits for every retained reaper.

## Native observation and cleanup

Use the native process inventory for evidence and retain only run-owned rows.
Take snapshots before launch, after readiness, during each cancellation seam,
and after final shutdown. Revalidate identity immediately before any signal.

Cleanup only exact fixture roots, service registrations, mounts, profiles, and
processes created by the run. If identity has changed or cannot be proved, do
not act; preserve the evidence and report the survivor. Never recursively
remove a broad temporary, build, application-data, or user directory.

Record exact commands, exit codes, deadlines, child counts, survivor counts,
and any unavailable native evidence in the execution report.
