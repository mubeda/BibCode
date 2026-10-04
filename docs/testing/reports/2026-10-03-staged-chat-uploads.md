# Staged chat uploads and browser-close measurements

Issue #17 implements design C, Tasks 2/4/5. Design B (#18) remains deferred.
The feature matrix and supplemental raw WebSocket measurement have distinct
outcomes. The latter is not a passing delivery profile.

## Feature behavior and native provenance

The feature matrix at source `916340447c3d230eebf9d1c0f50237b93a7615d8`
passed all fourteen Plain/Noise cases across attempts 1 and 2 of
[native run 37130526153](https://github.com/mubeda/BibCode/actions/runs/37130526153).
This is retained historical native evidence, not a rerun of the final assembly.
The retained Plain/dark and Noise/light freeze receipts observed client
close code 4408 after 29.175 and 29.6793 seconds, respectively, within the
approved 33-second bound, then resumed the upload successfully. Each selected
matrix receipt still has `fullMatrixComplete:false`; broader retention,
max-batch and admission/remount procedures are not inferred from it.

Its receipts and original light/dark images cover staged progress,
interruption/cancellation and reconnect/checkpoint recovery. That matrix
explicitly deferred admission remount; it is not native coverage of that seam. Required UI.md and Vercel React reviews were performed separately.

At assembled product source `22f724112de8ba8161243f6e4d9c81e0e455e016`,
a direct Git comparison found no differences from that native input in the
upload-binding/registry/RPC owners, client staging/admission/next-session
operations, thread commands, upload contracts, ChatView and upload/timeline
rendering. Adjacent provider publication, CLI diagnostic and desktop-auth
changes have separate integration coverage; the complete application tree is
not claimed identical to the historical native input.

Task 2 binds only complete owned uploads through durable turn admission and
rolls back uncommitted file leases. Task 4 retains at most two outstanding
append requests, adapts chunk size from observed RTT, joins old calls and
resumes from the replacement session checkpoint. Task 5 renders send-scoped
progress and a focusable Cancel action, retaining draft/send ownership through
navigation. Compiled ChatView tests cover admission remount in the final
web gate; this is component evidence, not a native remount result. Cancel interrupts the per-send operation and makes a best-effort
`uploads.cancel` call bounded to one second; it does not close the shared
WebSocket or require an entire large inline frame to flush after closure.

## Supplemental native profile: FAIL

[Run 37165892586](https://github.com/mubeda/BibCode/actions/runs/37165892586)
used source `ff7d95da30e632ea5ea0d35dd2e84bfaf2c2d46a` and pinned Chromium/
ChromeDriver `154.0.8037.57`. Both probes sent 3,145,728 bytes through the
same 16 KiB/s profile; payload, rate, time limits and verdicts were unchanged.

| Probe                          | Observed result                                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mid-message Ping/Pong          | PASS: complete payload and matching digest; one native Ping and matching Pong during the message; received Close after the message; clean browser code 1000; joined owned cleanup.                                                 |
| Immediate close after queueing | Failed successful delivery: receiver obtained 1,068,872 of 3,145,728 bytes (about 34%); digest incomplete, partial frame, no received Close; browser code 1006 and unclean close; proxy still had 110,592 bytes queued at capture. |

The failed receipt does not retain `bufferedBeforeClose` or the full queue
trajectory. Its final browser API queue of zero and `browser.failed: false`
do not prove receiver delivery. One active proxy connection and unjoined
probe cleanup at failure capture are separate from the subsequent outer
cleanup: zero remaining owned processes and a reaped controller. WebKitGTK
was unavailable and remains **not measured**.

The approved plan/spec require recording whether queued bytes flush after
`close()`, rather than guaranteeing that outcome. The current stronger
supplementary runbook/collector condition requires a complete receiver digest,
observed Close and clean browser event. That condition remains unmet and
unchanged; the overall supplemental profile remains **FAIL**. Completing
Tasks 2/4/5 does not satisfy or supersede this stronger profile. This distinction
is an explicit acceptance-wording discrepancy, not a reclassified test pass.

The [matching Chromium source](https://chromium.googlesource.com/chromium/src/+/154.0.8037.57/net/websockets/websocket_channel.cc)
defines a 60-second closing timeout. A 3 MiB payload needs at least 192 seconds
at the configured rate. The timing and source support a timeout explanation,
but the native timeout event was not retained: causality is inferred, not
directly observed. The [WebSockets standard](https://websockets.spec.whatwg.org/#dom-websocket-close)
orders pending sends before closure; API queue accounting excludes operating
system/network buffers and does not establish successful receipt in this run.
The legacy whole-request residual remains documented in connection-runtime.

## Final assembly validation

Fresh validation of the assembled source and its test-only bind-fixture
correction passed:

- `node scripts/run-local-vp.mjs check` and `node scripts/run-local-vp.mjs run typecheck`: formatting/lint and all eleven tasks passed.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -j 2 -- -D warnings`: passed with the pinned Rust 1.98.0 toolchain.
- Changed compiled web targets: 32 files / 1,369 tests passed; changed client-runtime, contract and tooling targets: 16 files / 359 tests passed.
- `node scripts/run-local-vp.mjs run check:contracts`: normal regenerated fixtures and parity passed without drift.
- `cargo test -p bibcode-server --lib -j 2`: 2,646 passed, 2 ignored. `cargo test -p bibcode-desktop --lib -j 2`: 449 passed after the existing restart test received its established isolation wrapper; the preceding 448/1 bind-failure run remains recorded.
- `cargo test -p bibcode-server --test production_maintenance --test trace_diagnostics --test turn_delivery_recovery --test production_provider_runtime --test git_coverage --test production_git_vcs_rpc -j 2`: every selected target passed; ignored private helpers were not counted as successful active checks.

Independent final source composition, UI.md and Vercel React reviews passed.
The initial typecheck failure was a missing checkout-local workspace dependency
link; normal frozen install restored it without changing the lockfile or
source. Final source checks were rerun after the test-fixture correction.
These are assembled-source checks, not a final release or supplemental
browser-profile PASS.

The source-gate anchor above precedes this documentation-only report. Final
merged-source identity and exact native CI results will be recorded in the issue's
integration comment. No release, general immediate-close delivery guarantee,
WebKitGTK verification or passing supplemental profile is claimed here.
