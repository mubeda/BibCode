# Approved Decision Log

All decisions below were approved during the 2026-08-24 design interview.

## Ownership And Navigation

1. The hierarchy is `Environment → Project → Main and additional workspace
threads`.
2. A project belongs to exactly one environment. The same repository in two
   environments produces two independent projects.
3. One environment cannot contain two active projects for the same verified
   local Git common-directory/worktree family.
4. Separate clones of the same remote repository are allowed in one
   environment.
5. A duplicate add attempt focuses the existing project and shows a non-error
   “Already added in this environment” notice.
6. Every project has exactly one system-defined Main thread, created atomically
   with the project and not independently deletable or archivable.
7. Selecting a project opens Main.
8. Ordinary and worktree-backed workspace threads remain a flat list under the
   project with distinct icons/badges; no extra Worktrees level is introduced.
9. Current server-owned worktree creation, discovery, adoption, retargeting,
   detach, and deletion safeguards are preserved.
10. Panel threads remain center-workspace tabs. The left panel contains no
    center tabs or supplementary information panels.

## Left Panel

11. Use the visible hierarchy direction: every non-hidden environment row stays
    visible in the main tree.
12. Use selected-path expansion on first discovery. Afterward, restore the
    client's exact manual collapse state.
13. The disclosure caret expands/collapses. Selecting the environment name opens
    its overview/settings in the center. A kebab menu exposes contextual actions.
14. The native primary machine is a normal, permanent environment node.
15. Default order is pinned/manual order, primary machine, running WSL,
    connected remotes, then offline/stopped environments. Temporary connection
    changes never reorder rows.
16. Search spans visible environment names, projects, threads, repository paths,
    and worktrees while retaining matching ancestors.
17. The client restores its exact last environment/project/thread selection,
    initially renders cache, and keeps an offline selected item selected. It
    falls back only after explicit deletion/forgetting.
18. Hidden environments leave the main tree but remain recoverable under
    Settings → Environments → Hidden.
19. Environment aliases, ordering, pinning, collapse, hiding, preferred route,
    autoconnect, and last selection are client-owned preferences.
20. Each environment exposes both the server-reported canonical identity and a
    client-local alias; editing the alias does not rename it for other clients.

## Status And Offline Behavior

21. Environment states are Online, Connecting, Reconnecting, Offline,
    Authentication required, Version incompatible, Updating, and Stopped for
    WSL. Avoid a generic Error state.
22. Setup required is a provisioning condition, not a generic connection error.
23. Project and thread activity states remain independent from the environment
    transport state.
24. Cached children remain expandable and recent cached thread content remains
    openable read-only while offline.
25. Offline content displays its last synchronization time and stale/read-only
    state. Server-dependent actions are disabled with a reason. No write is
    invisibly queued for reconnection.
26. Offline cache is encrypted, bounded by age and LRU/bytes, keyed through the
    platform secret store, and cleared on Forget.

## Environment And Route Identity

27. One environment may have several verified, ordered routes. A storage or
    environment identity mismatch never merges silently.
28. A server-generated UUID persisted with its data is the durable environment
    identity. The storage-instance UUID remains separate.
29. WSL names, host names, URLs, and SSH aliases are mutable discovery locators.
30. A data-preserving reinstall keeps environment identity. A reinstall without
    its data creates a new environment.
31. Route choice is sticky after verification, respects an explicit user pin,
    and may fail over only among routes proving the same identities.
32. The secure route set is desktop-managed local/WSL, SSH tunnel, and direct
    HTTPS/WSS. BiBCode Connect is removed.
33. HTTP is permitted only on loopback or within a desktop-owned encrypted SSH
    forward. A non-loopback bind requires TLS; startup otherwise fails.
34. Direct TLS accepts a system-trusted certificate or a pinned certificate
    whose fingerprint was verified through the host-local/SSH enrollment
    channel. Blind trust-on-first-use is forbidden.

## Pairing, Secrets, And Privacy

35. Enrollment starts from `bibcode auth pairing create` over an OS-protected
    local socket/named pipe and yields a five-minute, single-use code/link.
36. The client binds its DPoP key during enrollment. Generic pairing, scoped
    sessions, DPoP, WebSocket tickets, and revocation survive Connect removal.
37. Every paired client initially receives all environment administrator scopes;
    there is no permission-level editor.
38. Desktop secrets use Windows DPAPI, macOS Keychain, or Linux Secret Service.
    If secure storage is unavailable, persistence fails closed and credentials
    remain session-only.
39. Telemetry, analytics, usage reporting, and automated crash uploads are
    forbidden. Diagnostics are local, bounded, redacted, and exported only by
    explicit user action.

## WSL

40. Every currently running WSL distribution is automatically presented as a
    platform-managed environment.
41. Running distributions without BiBCode Server show Setup required; install
    or upgrade requires explicit user action.
42. BiBCode may start its server inside an already-running distro but never
    starts a stopped distro automatically.
43. Previously added stopped distributions remain visible as Stopped. Other
    installed/stopped distributions remain discoverable from Add Environment.
44. Multiple running distributions operate independently.
45. BiBCode never calls or exposes `wsl --unregister`.

## Services, Installation, And Updates

46. The server-only bundle contains the native server/CLI and compiled web
    assets, with no production Node.js runtime or Tauri desktop shell.
47. Workstation mode is the default: Windows logon task, macOS LaunchAgent, and
    Linux systemd user service.
48. Explicit headless mode uses a dedicated `bibcode` account and Windows
    Service, macOS LaunchDaemon, or Linux system service.
49. SSH provisioning probes first and requires consent before installing or
    upgrading an exact OS/architecture/version artifact.
50. Updates require administrator approval by default; unattended stable
    updates are opt-in. Update drains, backs up, atomically replaces, restarts,
    and verifies identity. Only the binary rolls back automatically; database
    downgrade is forbidden.
51. Windows ships signed x86_64 and ARM64 MSI plus portable ZIP; macOS ships a
    universal PKG plus architecture tarballs; Linux ships x86_64 and ARM64 DEB,
    RPM, and tarballs. All ship checksums, signatures, SBOM, and provenance.
52. macOS Developer ID signing/notarization remains optional. The existing
    working ad-hoc signing behavior remains the credential-free baseline.

## Removal Semantics

53. Disconnect stops transport only. Hide is reversible and retains local
    secrets/cache/settings. Forget clears this client's routes, secrets, cache,
    and metadata without mutating the server.
54. “Fully remove” opens a consequence wizard and asks whether to keep or purge
    remote data and whether to uninstall the remote server. Keep-data is the
    default; uninstall is independent and unchecked.
55. Purge is separately destructive and requires typing the environment name.
56. If offline, uninstall and purge cannot execute. The UI offers Force remove
    from this client after warning that the remote server/data and other paired
    clients remain untouched and re-pairing will be required.
57. Uninstall preserves data unless purge was separately and explicitly chosen.
58. WSL removal never unregisters a distribution.

## BiBCode Connect And Documentation

59. BiBCode Connect is removed completely from active source, runtime, schemas,
    dependencies, infrastructure, CI/deployment, settings, and living docs. No
    compatibility alias or fallback remains.
60. Connect removal preserves only generic direct authentication primitives.
61. All affected living installation, usage, administration, privacy,
    architecture, testing, troubleshooting, and release documentation changes
    in the implementation, including future documents required to make the new
    behavior operable.
