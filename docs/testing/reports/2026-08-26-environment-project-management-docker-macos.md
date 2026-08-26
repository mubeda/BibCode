# Environment Project Management Docker/macOS Validation

**Result:** PASS WITH RESIDUAL RISKS

## Tested revision

- Repository: `mubeda/BibCode`
- Remote: `https://github.com/mubeda/BibCode.git`
- Branch: `codex/environment-project-management`
- Local HEAD: `653b9d65b15fb46ed9c9a9e57f1bcbb2366fec2e`
- Upstream: none configured for the tested branch; no fetch was performed during this run.
- Dirty state before execution: clean feature branch; no unrelated user changes observed.
- Dirty state after execution: 32 modified implementation/test/living-documentation files plus this report; no generated build output is tracked.

## Native environment

- Host: macOS 26.6.2 (25G83), Darwin 25.6.0, Apple silicon `arm64`.
- Rust/Cargo: 1.98.0.
- Node/pnpm: 26.7.0 / 11.15.0. The repository requests Node 26.5.0, so pnpm emitted an engine warning.
- OpenSSH client: OpenSSH 10.3p1, LibreSSL 3.3.6.
- Desktop artifact: debug Tauri app at
  `/Users/admin/projects/workspaces/Codex/62ae/BibCode/target/debug/bundle/macos/BiBCode.app`.
- Signing: ad-hoc signing succeeded. Notarization was not attempted because Apple signing credentials were unavailable and signing remains optional for this validation.
- Remote fixtures: two independent disposable Linux `arm64` Docker/OpenSSH hosts, named Linux A and Linux B.

## Focused and workspace validation

| Command                                                                                                                                  | Result | Evidence and warnings                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @bibcode/client-runtime test`                                                                                             | PASS   | 53 files, 619 tests passed.                                                                                        |
| `pnpm --filter @bibcode/web test src/components/ChatView.hooks.test.tsx`                                                                 | PASS   | 1 file, 150 tests passed after correcting the stale macOS remote-reconnect expectation.                            |
| `pnpm --filter @bibcode/web test`                                                                                                        | PASS   | 396 files; 5,512 passed and 22 skipped. Experimental Node `localStorage` warnings only.                            |
| `cargo test -p bibcode-desktop --no-default-features`                                                                                    | PASS   | 400 unit, 4 bridge public-contract, and 5 SSH public-contract tests passed; doc and platform-empty targets passed. |
| `cargo clippy -p bibcode-desktop --all-targets --no-default-features -- -D warnings`                                                     | PASS   | Exit 0; no warnings.                                                                                               |
| `cargo fmt --all --check`                                                                                                                | PASS   | Exit 0.                                                                                                            |
| `vp check`                                                                                                                               | PASS   | 1,926 files formatted; 1,353 files with no lint warnings or errors.                                                |
| `vp run typecheck`                                                                                                                       | PASS   | Exit 0. Existing non-failing Effect schema suggestions were emitted.                                               |
| `git diff --check`                                                                                                                       | PASS   | No whitespace errors.                                                                                              |
| `VITE_BIBCODE_DESKTOP_E2E=1 pnpm exec tauri build --debug --features desktop-e2e --config ./src-tauri/tauri.e2e.conf.json --bundles app` | PASS   | Native macOS application bundle produced and launched.                                                             |

## Environment, project, and Main invariants

- Linux A exposed distinct environment and storage identities:
  `686c0efb-b0bf-4eba-ab87-29a1f2121335` and
  `cccd719a-1d8c-4d19-9669-928203b62921`.
- The native overview reported Linux `arm64`, server 0.4.1, protocol range 1-1, and Repository Identity capability.
- `shared-main` was added once beneath Linux A and produced exactly one Main thread.
- Re-adding the same repository path and adding its linked worktree both returned **Already added in this environment** and did not create duplicates.
- An independent clone, `shared-clone`, was accepted as a second Linux A project.
- The same repository was accepted beneath Linux B, proving environment-scoped ownership rather than global repository ownership.
- Linux A retained Main plus durable `Review notes` and `Feature planning` threads.
- Existing worktree identity behavior remained covered by the passing client, web, and native suites.

## SSH trust, pairing, reconnect, and cleanup

- The desktop used native OpenSSH tunnels to numeric loopback endpoints and native pairing.
- Pairing/session traffic used DPoP-bound authorization; raw pairing credentials were not rendered or persisted in renderer state.
- Stopping Linux A changed only that environment to **Reconnecting** while Linux B remained online and usable.
- Restarting Linux A on its fixed fixture port automatically recovered the environment and restored its cached project/thread tree.
- An online removal plan showed separate local cleanup, optional remote uninstall, and optional remote data purge, with server data preservation recommended.
- The transient portable fixture was not service-installed, so the identity-bound native uninstall planner correctly refused remote destructive actions. No remote uninstall or purge was executed.
- Offline force removal required the exact environment alias and a separate consequence acknowledgement. The UI explicitly warned that the remote server, projects, worktrees, data, and other clients could remain.
- Both test-only environment records were force-removed through the UI after the fixtures were offline. Only the native Local environment remained.
- A real macOS application quit initially exposed two orphaned SSH tunnels. The desktop exit path was fixed so both `ExitRequested` and final `Exit` run the complete shutdown barrier. Retest with app PID 54218 and tunnel PIDs 54441/54442 ended with zero run-owned app or tunnel survivors.

## Packaged UI and visual evidence

All 15 final captures decoded successfully at 1093 x 768 and were inspected at original resolution.

| Scenario                   | Screenshot                                                                                                                                                    | Pixel-review finding                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| First run                  | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/01-first-run-current.png`                   | Initial native environment presentation captured.                                                        |
| Local online               | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/01-local-online-fixed.jpeg`                 | Native local row and online state visible.                                                               |
| Protected storage failure  | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/02-linux-a-protected-storage-failure.png`   | Fail-closed credential state is explicit.                                                                |
| Linux overview             | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/03-linux-a-online-overview.png`             | Identity, platform, version, protocol, and center settings tabs are visible.                             |
| Add Project host selector  | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/04-add-project-host-selector-fixed.png`     | Host selector is in the center modal; no left-side informational panel or tabs.                          |
| Project/Main tree          | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/05-linux-a-project-main-tree.png`           | Environment owns project; project owns Main.                                                             |
| Two distinct projects      | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/06-linux-a-two-distinct-projects.png`       | Independent clone is separate within Linux A.                                                            |
| Main and multiple threads  | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/07-linux-a-main-and-multiple-threads.png`   | Main, Review notes, and Feature planning appear beneath one project.                                     |
| Two owning environments    | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/08-linux-a-linux-b-own-projects.png`        | Linux A and Linux B independently own `shared-main`; Linux A's two projects and threads remain distinct. |
| Partial outage             | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/09-linux-a-reconnecting-linux-b-online.png` | Linux A reconnects while Linux B stays online.                                                           |
| Recovery                   | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/10-linux-a-recovered.png`                   | Linux A returns online with its hierarchy preserved.                                                     |
| Online removal             | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/11-linux-a-removal-warning.jpeg`            | Client cleanup, server uninstall, and data purge are separate and explicit.                              |
| Removal planner refusal    | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/12-removal-plan-verification-failure.jpeg`  | Exact native error is visible; destructive controls remain unavailable.                                  |
| Offline warning            | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/13-offline-force-removal-warning.jpeg`      | Unknown remote consequences and preservation risks are explicit.                                         |
| Force-removal confirmation | `/Users/admin/.codex/visualizations/2026/08/24/01a0359a-86b4-72c3-8cc9-abe87a147010/bibcode-docker-e2e-2026-08-26/14-offline-force-removal-confirmation.jpeg` | Exact alias plus acknowledgement are both required before client-only removal.                           |

## Privacy, process, and temporary-root cleanup

- Diagnostics UI was inspected: data is presented as local/redacted, with explicit export and no upload, analytics, crash, or usage controls.
- A deny-by-default outbound capture was not run, so this report does not claim packet-level telemetry absence.
- The app, run-owned SSH tunnels, Docker containers, test images, test volume, SSH agent, mounted DMG, temporary scripts/roots, and exact test keychain references were removed.
- Docker inventory and process inventory showed no remaining run-owned resources.
- Cleanup targeted only exact test-owned names and paths; no unrelated resource was intentionally modified.

## Residual platform risks and unavailable evidence

- No Apple Virtualization macOS guest bundle/IPSW or prepared Apple VM was available. The current host supplied native macOS desktop evidence, but a second macOS SSH server was not tested.
- No native Windows host or WSL installation was available; Windows, WSL discovery, and Windows server-installer flows still require native validation.
- The Linux fixtures used transient portable server binaries, so Linux package-manager install/uninstall and native service registration were not exercised.
- Direct HTTPS was not exercised live. Plain HTTP is absent from the supported environment UI and was not enabled.
- Remote purge was intentionally not executed; the safe-plan refusal and user-facing warnings were validated instead.
- The debug bundle was ad-hoc signed and not notarized.
