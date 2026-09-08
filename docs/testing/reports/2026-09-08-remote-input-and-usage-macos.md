# Remote input and provider usage: macOS execution report

**Result:** PASS WITH RESIDUAL RISKS

## Tested revision and requested scope

- Repository: `/Users/admin/projects/BibCode`, branch `develop`.
- HEAD: `f68781e5cd` plus the uncommitted implementation in this checkout.
- Requested outcome: improve remote terminal typing and display usage from the
  selected server. The user approved the proposed ordered-input design.
- No target remote revision or release version was requested; no fetch, merge,
  commit, push, installation, or live application/server restart was performed.
- The two previously staged dependency/toolchain planning documents and the
  pre-existing untracked `outputs/` directory were preserved.

## Native environment

- macOS 26.6.2, build 25G83, arm64.
- Node 26.8.1; Vite+ 0.2.5; Vitest 4.1.10.
- Native Rust tests and the standalone test binary used the initially selected
  Homebrew Rust 1.98.0. Final workspace typecheck, rustfmt, and Clippy used the
  repository-pinned Rust/Clippy 1.97.1, selected explicitly through PATH.
- Windows and Linux received source/contract compatibility coverage only;
  native execution on those hosts was not performed.

## Implemented behavior

The status bar reads the selected environment for usage, refresh, reset actions,
terminal counts, and remote diagnostics. Its separate desktop-local diagnostic
source remains intact. Loading or disconnected remote usage does not borrow
local values; late results remain associated with their originating environment.

Ordered terminal input is negotiated from the actual RPC session. A server
lease binds a physical socket and exact PTY generation. Attachment sequences
prevent a delayed old begin from replacing a newer lease. Frames carry their
own sequences; the server orders delivery, bounds admission before workspace
I/O, and stops dependent input after failure. No uncertain input is replayed.

The connection has at most 16 input frames/256 KiB in flight, reserves eight of
its 64 RPC slots for other operations, and caps waiting dispatch payload at
1 MiB. Each terminal scheduler and negotiated binding separately cap pending
input at 1 MiB; this is not a single aggregate renderer-memory limit.

Open/restart confirmations prepare input on the same captured session before
returning, including for legacy servers. Visual hide/reparent preserves the
binding. **Reconnect input** refreshes attachment without restarting the agent
process. Older servers retain serialized writes without new RPC calls.

## Performance evidence

A controlled 20-character test with 30 ms between characters and a simulated
120 ms acknowledgement round trip measured:

| Mode              | Median queued before send | Maximum queued before send | Delivery             |
| ----------------- | ------------------------- | -------------------------- | -------------------- |
| Serialized, run 1 | 59 ms                     | 118 ms                     | Exact text, in order |
| Ordered, run 1    | 0 ms rounded              | 0 ms rounded               | Exact text, in order |
| Serialized, run 2 | 58 ms                     | 117 ms                     | Exact text, in order |
| Ordered, run 2    | 0 ms rounded              | 0 ms rounded               | Exact text, in order |

This measures client queue time, not total key-to-screen latency. The original
live remote connection had 300–1,286 ms encrypted ping round trips and was
already direct through Tailscale. Those network conditions were not changed.

## Validation commands and results

Commands were run from the repository root. The package suites overlap the
focused tests; their counts must not be added together as unique coverage.

| Command                                                                                                                                                                                                                                      | Result                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `vp run --filter @bibcode/client-runtime --filter @bibcode/web test`                                                                                                                                                                         | Exit 0: client runtime 743 passed/5 skipped; web 6,053 passed/22 skipped                        |
| `vp test run packages/contracts/src/terminal.test.ts packages/contracts/src/environment.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts packages/contracts/scripts/export-rust-rpc-fixtures.test.ts` | Exit 0: 98 passed                                                                               |
| `cargo test -p bibcode-server --lib terminal:: -j 2`                                                                                                                                                                                         | Exit 0: 236 broader terminal/provider-terminal tests passed                                     |
| `cargo test -p bibcode-server --lib ordered_input -j 2`                                                                                                                                                                                      | Exit 0: all 11 final ordered-input owner tests passed, including the subsequent stale-begin fix |
| `cargo test -p bibcode-server --lib rpc::session::tests -j 2`                                                                                                                                                                                | Exit 0: 12 passed                                                                               |
| `cargo test -p bibcode-server --test production_server_terminal_rpc --test rpc_wire --test e2ee_ws -j 2`                                                                                                                                     | Exit 0: 15 terminal RPC, 13 RPC wire, and 24 E2EE tests passed                                  |
| `cargo build -p bibcode-server --bin bibcode -j 2`                                                                                                                                                                                           | Exit 0: current-source native server built                                                      |
| `BIBCODE_E2EE_SERVER_BIN=/Users/admin/projects/BibCode/target/debug/bibcode vp test run packages/client-runtime/src/e2ee/serverInterop.test.ts`                                                                                              | Exit 0: 4 passed, including a real native PTY over E2EE                                         |
| `vp run --filter @bibcode/contracts generate:rust-rpc-fixtures`                                                                                                                                                                              | Exit 0: SHA-256 comparison proved all 362 fixture/manifest files unchanged on regeneration      |
| `vp check`                                                                                                                                                                                                                                   | Exit 0: no formatting or lint errors/warnings                                                   |
| `env PATH="/Users/admin/.rustup/toolchains/1.97.1-aarch64-apple-darwin/bin:$PATH" vp run typecheck`                                                                                                                                          | Exit 0: all 11 package tasks passed                                                             |
| `env PATH="/Users/admin/.rustup/toolchains/1.97.1-aarch64-apple-darwin/bin:$PATH" cargo fmt --all --check`                                                                                                                                   | Exit 0                                                                                          |
| `cargo clean -p bibcode-server -p bibcode-desktop -p bibcode-updater-verifier`                                                                                                                                                               | Exit 0: required fresh-lint cache cleanup                                                       |
| `env PATH="/Users/admin/.rustup/toolchains/1.97.1-aarch64-apple-darwin/bin:$PATH" cargo clippy --workspace --all-targets -- -D warnings`                                                                                                     | Exit 0 with the pinned Clippy toolchain                                                         |
| `vp run --filter @bibcode/web build`                                                                                                                                                                                                         | Exit 0: final production web build                                                              |
| `git diff --check`                                                                                                                                                                                                                           | Exit 0                                                                                          |

The native E2EE smoke sent frame sequences 2, 1, then 0 and verified the real
shell produced `ordered-input-ok` in its disposable directory. A second socket
using the same bearer was denied the first socket's input lease. The shell and
channels were closed, the temporary root was removed, and no fixture server
process remained. The native binary was tested before the later required Cargo
cache cleanup; this report does not deliver a release installer.

## Red/green evidence and review

- Usage: selected remote 70% remaining initially rendered local 10%; the
  regression passed after switching the selector.
- Scheduler and mounted renderer: a second input initially waited behind the
  first acknowledgement; the ordered cases now send both immediately.
- Stale begin: client and Rust regressions reproduced old issuance replacing
  a newer lease. Attachment sequencing fixed both; independent re-review passed.
- Lifecycle: legacy reattachment skipped preparation, and confirmed open/restart
  could leave programmatic input fenced. Mounted and actual Atom-command
  regressions were red, then green; independent re-review passed.
- Contract and integration reviews completed with no remaining actionable
  findings. The UI was reviewed against `UI.md`.

## Gate corrections and warnings

The shell's default Rust 1.98 Clippy failed on a pre-existing
`chunks_exact_to_as_chunks` lint in Git conflict parsing. `rustup run` selected
the pinned Cargo binary but still found the Homebrew Clippy subcommand. Explicit
toolchain-bin PATH selection resolved that mismatch without changing unrelated
Git code. A new-code Clippy style finding was fixed using Result-based lazy
permit acquisition, preserving its admission order.

Node emitted the existing localStorage availability warning in unit workers.
Typecheck reported the existing informational Effect suggestion in
`ActivityPanel.tsx`. macOS Rust test linking reported the existing large
`__eh_frame` warning; native tests completed successfully.

## Runbooks, unavailable evidence, and residual risks

The shared testing runbook now includes ordered input, legacy compatibility,
stale attachment issuance, backpressure, and reconnect without replay. The
affected native Windows/Linux/macOS runbook sections were **reviewed and remain
accurate** through that shared procedure. VCS, Git Manager, repository/worktree
lifecycle, packaging, signing, and release publication were outside this change.

- `vercel-react-best-practices` review: **not run**, because that skill was
  unavailable in the configured skill locations. `UI.md` review and React tests
  were completed.
- Patched packaged desktop visual validation: **not run**. The installed app
  was used only for initial diagnosis and was not replaced.
- Native Windows/Linux execution: **not run**; those hosts still need native
  validation of the new terminal interaction.
- Live latency after deployment: **not measured**. Both desktop client and
  remote server need the updated build to activate ordered input; the usage
  selector fix is a client change. Network round-trip delay remains.
- No dependencies changed, so no configured vendored subtree needed a sync.
- No commits, pushes, merges, published artifacts, or installed updates were
  created. The implementation remains reviewable in the checkout.
