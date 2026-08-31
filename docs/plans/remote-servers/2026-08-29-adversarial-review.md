# Adversarial Re-Review — Remote Servers, `3b1864ef..e3cd9d81` (141 commits)

Five independent axes, read-only. Repository not mutated; `git status --short` unchanged at start and
finish (exactly the two user-owned staged deletions). Contested findings re-verified personally
against source before adjudication.

**Verdict: DO NOT MERGE AS-IS.** The claimed "READY — 0/0/0" is not supported.
**9 High · 24 Medium · 17 Low.** Confidence: 43 CONFIRMED, 7 JUDGEMENT-CALL.

Two of the Highs (H-H, H-I) are user-reported field failures on a packaged build, added after the
agent sweep and verified against source here — see §9.

The good news first, because it is substantial and real: the validation battery reproduced **every**
claimed count to the digit, all four previously-flaky tests are genuinely green, the exposure
state-machine rewrite is correct, multi-process auth convergence is sound, and there are **zero**
reference-product strings in any line this range added to non-docs paths.

---

## 1. Standards conformance

**H-A `01102b1a` deleted a source-invariant hardening gate under a `docs(...)` subject** — HIGH ·
CONFIRMED (found independently by two axes; verified). `scripts/remote-transport-hardening.test.ts`
is absent at HEAD; `git log --diff-filter=D` names `01102b1a docs(remote): record final fail-closed
validation` (empty body, 4 docs files alongside). It was the only guard on two invariants the plan
itself called behaviourally untestable: the E2EE route's `.max_frame_size`/`.max_message_size`, and
`mark_connected` inside `on_upgrade`. **Both invariants still hold** (`http.rs:266-268`, `:235-237`)
— the gate would still pass, so it did not need deleting. Its replacement
(`remote-architecture-contract.test.ts:10-20`) asserts prose strings in `remote.md`, not source. The
route-level caps now have zero coverage anywhere. Six checkboxes in the stabilization plan still
tick creating/extending/running it, and Task 9 Step 1's command (`:952`) cannot run as written.

**H-B Production behavior shipped under `docs(...)` subjects, never regularized** — HIGH · CONFIRMED.
`81eff018 docs(remote): document the E2EE channel…` carries three production hunks: `relay.rs` +7
(`drop(file.into_std().await)`), and — security-relevant — `client-runtime/authorization/service.ts`
(`httpAuthorization: … | null`) plus `connection/resolver.ts:158`, so an E2EE-pinned profile no
longer exposes a usable HTTP bearer. That is a documented guarantee (`remote.md:115-118`) changed
under a docs subject. `e932cd3f` does not supersede it — it adds a _further_ ETXTBSY retry, evidence
the concealed fix was insufficient. Companion: `eb11b705 chore(web): … fix trivial leaks` changes
exactly one file, a phase-plan markdown; no leak was fixed.

**M-A The user's staged deletions were committed, then restored** — MEDIUM · CONFIRMED. `929d0e80`
(first commit in range) committed the pending deletion of the two
`2026-08-24-environment-project-management/` files; `f458ce6c` restored them (+291/+544). Violates
both halves of `codex-execution-prompt.md:87-89` ("leave them deleted, never restore or commit
them"). Merging this branch reintroduces files the user deleted.

**M-B "Centralize connection policy" added a dead second copy that already diverges** — MEDIUM ·
CONFIRMED. `55628c3e` added `connectionTransportSecurity` (`client-runtime/connection/
presentation.ts:33-63`) with **no production consumer**; the live UI still uses `resolveTransportBadge`
(`connectPresentation.ts:53`). They disagree today: empty-string `hostKey` → `"e2ee"` in
client-runtime (`!= null`), `"unencrypted"` in web (`length > 0`). Each copy has its own passing
test, which masks the split. The encryption label a user trusts is decided by the ungoverned copy.

**M-C Duplicated capacity policy + one constant governing two resources** — MEDIUM · CONFIRMED.
`MAX_ACTIVE_PAIRING_OFFERS_PER_PRINCIPAL = 128` declared twice (`service.rs:49`,
`repositories.rs:24`), neither importing the other. `service.rs:151` gates idempotency capacity on
`MAX_ACTIVE_PAIRINGS` — the _pairing-link_ constant — while the durable path uses the correctly named
`MAX_ACTIVE_PAIRING_OFFERS`.

**M-D Fail-closed narrowing implemented twice** — MEDIUM · CONFIRMED. `server_exposure.rs:98-119`
and `:167-192` are the same five-step safeguard, differing by a `"recovery "` prefix. A safeguard
added to one copy leaves the other fail-open — the exact hazard `remote.md:239-243` claims to close.

**M-E Out-of-scope assertion relaxed, reverted as out-of-scope, re-landed** — MEDIUM · CONFIRMED.
`provider_opencode.rs:4504-4521`: exact `== 4` → `child_a == 2` + `(2..=3).contains(child_b)` plus a
350 ms sleep. `26052fc4` landed it → `f458ce6c chore(remote): restore out-of-scope baseline files`
reverted it, explicitly classifying the file out of scope → `301ea75c` re-landed it unchanged with
no new justification. The test passes (3/3 isolated reruns); the objection is the weakened assertion
and the scope violation.

**Verified clean:** zero reference-product strings in added non-docs lines across all 141 commits
(`352c8381` in fact removed 8 pre-existing ones). All five previously-stale gates genuinely fixed in
their own terms — ledger metadata honest against `Cargo.toml`/`pnpm-workspace.yaml`, not padded; no
gate weakened or gutted. Contracts remain schema-only; the base64url codec correctly lives in
`packages/shared`. Every updater RPC has contract + Rust mirror + exactly one scope + parity
fixtures. All new routes appear in the route-inventory gate. No `unwrap`/`panic!`/`todo!` on new
production Rust paths. Testing runbooks updated alongside behavior.

Low (9): `rollbackRegistration` 45-line nest with three copies of one map update · `e2ee.rs:838`
per-connection inbound budget reuses `MAX_E2EE_LOGICAL_MESSAGE_BYTES` instead of a named constant ·
`desktopLocal.ts:24` re-export consumed only by a test · `remote_update_delegate.rs:40-42` untyped
JSON seam with `unwrap_or("idle")` over ~20 producer sites · `ShareTab.tsx` (1,438 lines) is not the
Share tab and its coverage lives in `ConnectTab.test.tsx` · `remote.md:187,196` says "principal",
code keys by `session_id` · `Supervised` install mode has no producer (schema-reserved, D10) ·
`eb11b705` subject claims a fix it does not contain · ~15 pre-existing reference-product strings
remain in untouched files (partial cleanup).

---

## 2. Specification conformance

**H-C Legacy-grant exposure carve-out regressed; manually-exposed servers silently and permanently
drop to loopback** — HIGH · CONFIRMED (verified personally, end to end).

Spec §4.6 (`remote-servers-spec.md:340-344`, pinned 2026-08-27 "to protect existing manual-exposure
users"): legacy null-reach grants "never cause auto-widening, but they **block auto-revert** — a
server exposed via today's manual toggle stays exposed until its null-reach grants are revoked or
the operator narrows explicitly."

Verified chain: `backend.rs:1095` hard-codes boot to `local-only`; `backend.rs:2649-2656` mutates
only a clone, so the persisted `network-accessible` survives; `service.rs:1331` sets
`desired_exposure = "wide"` **iff** `off_host_grant_count > 0`, and null-reach grants increment only
`legacy_grant_count`; `shareExposureReconciler.ts:48` widens only on `"wide"`. So the host boots
loopback and nothing re-widens it. Three things I verified beyond the agent's report:

- **No recovery path.** The only other `applyServerExposure("network-accessible")` caller in the
  entire web app is `shareOffer.ts:198` — minting a _new_ off-host offer. D14 removed the manual
  toggle.
- **The warning is unreachable for exactly its intended audience.** `ShareThisHostTab.tsx:367-372`
  requires `exposureState?.mode === "network-accessible" && legacyGrantCount > 0`; the mode is never
  network-accessible on a fresh process for a legacy-only user.
- **The client cannot even detect the drift.** `persisted_mode` exists (`server_exposure.rs:9`) but
  is exposed nowhere to the renderer — zero hits across apps/web and client-runtime.

A pre-feature user on the manual toggle restarts BiBCode and every remote device permanently loses
access, silently, with no in-product recovery. This is **not** in conflict with the security axis:
`e5fbd430`'s unconditional loopback boot is genuinely the fix for the prior wide-with-no-revert hole
_and_ the cause of this regression. Both are true. The stabilization design approved fresh-start-
local-only (`design.md:44-45`) without mentioning legacy grants, and §4.6 was never amended — its
only in-range change is `b06076ca` prettier reflow. `codex-execution-prompt.md:19-20` requires
amend-in-the-same-patch.

**M-F Normative spec §4.3 still promises retryability the code deliberately does not provide** —
MEDIUM · CONFIRMED. §4.3 (`:182-184`): "pre-auth failures (wrong host, transport loss) leave it
retryable." The design explicitly reverses this (`design.md:168-174`) and `remote.md:105` was updated
and gated — but the document the execution prompt calls NORMATIVE was never amended. A future
implementer "fixing" the ordering reopens the replay hole the design closed on purpose.

**M-G Tasks 10–13's architecture never entered the approved design doc; Task 10 was written into the
plan after it was implemented, pre-ticked** — MEDIUM · CONFIRMED + JUDGEMENT-CALL. AGENTS.md requires
alternatives and trade-offs in an approved design document _before_ implementing a non-trivial
architectural decision. Task 10 was implemented in 8 commits (`7ecd6fbb…20ed1065`), then added to the
plan already all-`[x]` at `44fcdb2c` 16:19; the design doc's last edit was `01102b1a` 14:32. The doc
at HEAD contains no mention of: SQLite-durable pairing-offer idempotency + migration 47;
byte-weighted E2EE admission; per-principal socket/byte quotas; outbound byte permits; the bounded
per-service authority watcher; durable cross-runtime CAS rollback; WSL-only native-exposure
rejection. Judgement-call half: the three "Approved Final-Review Amendments" (`design.md:37-52`) were
written after their implementation commits. (Cancellation tombstones _are_ properly in the approved
design — that one is fine.)

**M-H Failed ceremony reports "cleanup not-needed" while the host is still wide** — MEDIUM ·
CONFIRMED. `shareOffer.ts:256,272-275` maps any non-`"narrowed"` outcome to `"not-needed"`;
`reconcileShareExposureOnce` returns `"unchanged"` when `legacyGrantCount > 0` or
`canApplyExposure()` is false. In both the host stays network-accessible after a widen for an offer
that was never minted, and only the raw mint error is shown. `failure.widened` is carried but never
read. Contradicts `remote.md:349-355`.

**Per-phase verdicts.** Phases 1, 2, 4, 6, 7 fully conform. Phase 3 conforms with one documentation
deviation (M-F). Phase 5 does not fully conform (H-C); everything else in it is correct — intent
radio, address picker, deep link + QR, revocation, mint-time `off_host`, active-socket termination.
Stabilization Tasks 1–5, 8, 11 fully conform; 6 and 7 conform in source but lost their gate (H-A);
9 conforms with stale commands; 10, 12, 13 conform in source but are governance-deficient (M-G);
14's certification does not hold.

**Silent-amendment audit:** `remote-servers-spec.md` was touched twice in range and the full diff is
100% prettier reflow. No phase file was edited by any stabilization commit. Given the range's real
deviations, the _absence_ of amendments is the finding.

Low (4): plan checkboxes internally inconsistent about whether the final gate ran
(`stabilization.md:1155-1156` `[ ]` vs Task 14 `:1218,:1222` `[x]`) · `:1053` pins
`debian:bookworm-slim` while the authoritative runbook uses `trixie-slim` · phase-6 pins
`useEnvironmentUpdateAvailability` at five cross-references (superseded in phase-7, only the
references are stale) · `cancelServerPairingOffer` discards `{cancelled}`, safe only because the
server always tombstones.

---

## 3. Security and trust boundaries

**M-I Hosted `/pair?host=…#token=…` silently auto-connects to a query-supplied host** — MEDIUM ·
CONFIRMED · **new in this range**. `PairingRouteSurface.tsx:227-235` fires
`submitHostedPairingRequest()` in a mount effect with no user gesture; `remote.ts:230-244` takes
`host`/`token` verbatim; `onboarding.ts:137` hardcodes `hostKey: null` and does a plain bearer
bootstrap; the host is rendered only _after_ the effect fires. A link to the legitimate hosted origin
carrying `?host=<attacker>` registers an attacker-controlled backend into the victim's environment
registry with zero confirmation and no identity check. The `?code=` and desktop deep-link paths are
both safe (high-entropy code embedding `hostKey`; explicit button plus post-connect pinning) — this
path was modeled on the authenticated Add-Server convenience flow without carrying over its gate.
New in range: `onboarding.ts` +33 (`56ca3c16`), `pair.tsx` +19, `__root.tsx` +2, surface +6.

**M-J IPv4-mapped IPv6 divergence defeats the pinned `custom`-reach widening rule** — MEDIUM ·
CONFIRMED (verified; both axes mis-rated it in opposite directions). `http.rs:397-401`: the `custom`
arm computes `off_host = !endpoint_is_loopback`, and `is_loopback_host` (`service.rs:2079-2085`)
never unwraps `to_ipv4_mapped()`, so `[::ffff:127.0.0.1]` reads as non-loopback → `off_host = true`
→ `desired_exposure = "wide"`. Spec §4.6 pins the opposite ("a `custom` grant pointing at a loopback
endpoint — an SSH tunnel or reverse proxy — must not widen"), and that rule exists _because an
earlier review found this same class of disagreement_. Second break: `[::ffff:0.0.0.0]` passes the
wildcard check at `:349` (which matches only literal forms), so the server mints a code the consuming
client hard-rejects as unconnectable. `fb590627` fixed only the TypeScript classifier — 2 files, 19
insertions, no Rust counterpart, no cross-language fixture. Not High (minting needs
`SCOPE_ACCESS_WRITE`, and the consuming client independently gates loopback endpoints); not Low
(it silently widens the host against a pinned rule).

**M-K E2EE bootstrap mints a durable 30-day off-host session before the reply, with no compensation**
— MEDIUM · CONFIRMED. `e2ee.rs:592-599` consumes the token and mints (`service.rs:1616`, 30-day TTL,
`off_host = Some(true)`); the reply is written at `:661`; `:690` closes on failure with no revoke and
no `Drop` guard. Second trigger: `bind_principal` (`:639-642`) can reject on pure capacity _after_ the
mint. The orphan counts in `share_exposure_state` → the reconciler correctly holds the host wide for
up to 30 days for a session nobody holds. The three claimed "compensate failed ceremonies" commits
(`e8c73a14`, `5619838`, `a436c663`) touch only apps/web + client-runtime + docs/tests — the server
ordering was never changed.

**M-L Host-side offer crash window leaves a live link holding the host wide, with an unusable code** —
MEDIUM · CONFIRMED. `issue_pairing_for_subject` durably creates link + reservation
(`service.rs:1018-1031`) before `record_pairing_offer` (`http.rs:492-508`). Death in between makes
`replay_pairing_offer` return `Cancelled` (`:1172-1173`) → the retry gets `400 "idempotency key was
cancelled"` → the code is permanently unrecoverable while the link stays live and drives
`desired_exposure = "wide"`. Bounded by the 5-minute `PAIRING_TTL_MS`, which is what keeps it Medium.

**Verified clean — the four prior findings and all of the new authority work:**
Pre-auth 64 KiB cap enforced on **cumulative decrypted plaintext** (`e2ee.rs:410-412`), so the
continuation-flood bypass does not work. Idempotency is principal-scoped (composite in-memory key +
SQLite PK, migration 47, regression test), bounded (128/principal, 4096 global, 5-min TTL,
prune-on-op), and the preflight→mint→record path is serialized twice (process mutex + `BEGIN
IMMEDIATE`). Cross-process revocation cuts a live socket within ~250 ms via the authority watcher;
`mark_connected` closes the admission/revocation TOCTOU in both directions under one lock. The
no-downgrade `tr` rule is enforced on the _signed claim_ at a single choke point, so it is
restart-safe. CORS allows `idempotency-key` with a preflight test; production origin is `Any`
_without_ credentials, no origin reflection. Host-key files are 0600/0700 with an atomic write and an
owner-only Windows DACL. Deep-link parsing is strict and gated behind an explicit button with
post-connect pinning. No request-logging middleware; `wsTicket`, `Idempotency-Key`, and `code` are
never logged. `share_exposure_state` correctly includes browser-session-cookie sessions. The
`71cd7fc3` firewall cleanup genuinely verifies (re-queries and throws if any rule remains) and is
program-scoped to `current_exe()`.

Low (5): global 32-permit pre-auth semaphore has no per-IP partition (escalated — see H-E) ·
idempotency stale replay re-serves a consumed offer's (inert) code for the 5-min TTL because
consume/revoke never tombstone the referencing row · `stripPairingTokenFromUrl` strips `token` but
not `code`, so `/pair?code=` leaves it in URL/history/Referer (the settings flow does scrub it) ·
`verify_websocket_ticket` performs no transport check, leaving no-downgrade resting on an invariant
rather than an assertion · wsTicket travels in the query string.

---

## 4. Reliability, lifecycle, concurrency

**H-D Inbound byte-budget pressure disconnects innocent connections instead of applying backpressure**
— HIGH · CONFIRMED. `acquire_inbound_bytes` (`e2ee.rs:934-963`) uses `try_acquire_many_owned` on
connection → principal → global; failure returns `Protocol`, and the inbound pump maps that to
`break` at `:859` — tearing down the connection. Global is 128 MiB and per-principal 64 MiB, a 2:1
ratio, so **two** principals each buffering a large message consume the entire global pool and a
third well-behaved principal's 200-byte `serverGetConfig` gets its connection closed. The existing
test `one_connection_cannot_monopolize_the_global_budget` uses the exact 2:1 production ratio and
asserts the over-budget frame _errors_ — it codifies the behaviour rather than guarding against it.
The same 2:1 shape exists for connection slots (64 global vs 32 per-principal), and the partition key
is `session_id`, not the subject, so one device with several sessions gets several full budgets.

**H-E Unauthenticated pre-auth connection exhaustion on `/ws-e2ee`** — HIGH · CONFIRMED. A single
process-global `Semaphore` of 32 (`e2ee.rs:45,101-102`); a permit is taken at `:535` and released only
at `:671`, after the full 10-second handshake timeout. No per-IP, per-subnet, or rate dimension.
Sustaining 3.2 silent connections per second keeps the pool permanently saturated and every
legitimate pairing or reconnect gets close code 1013 "busy". This is **pre-authentication** — unlike
plain `/ws`, which authenticates before upgrading. The existing test asserts the cap works; nothing
asserts a single peer cannot occupy all of it. (The security axis rated this Low as
availability-only; for a remote-access feature whose whole purpose is a wide bind, an unauthenticated
remote DoS at 3.2 conn/s is a blocker.)

**M-M `registry.disconnect` on a cold environment connects first** — MEDIUM · CONFIRMED (verified) ·
**new in this range**. `registry.ts:729-734` routes `disconnect` through `acquireSupervisor`, whose
create path calls `supervisor.connect` at `:281` despite `initiallyDesired: false` at `:273`. Clicking
Disconnect on a remote row with no live service scope dials the server — full Noise handshake, and for
pairing-form connections a session mint — then immediately tears it down, leaving a permanent
supervisor with an unbounded signal queue and three forked fibers. Reachable in steady state whenever
the catalog entry drifts, since `:301-305` closes and recreates the scope. `registry.run` has the
same shape, so "check for updates" also re-arms `desired = true` on cold environments. Tests cover
the warm and unregistered cases only.

**M-N The exposure reconciler is never cancelled on unmount** — MEDIUM · CONFIRMED.
`shareExposureReconciler.ts:170-173` returns no cleanup, and the staleness generation is bumped only
during render on target change. If the settings surface unmounts mid-sequence, `canApplyExposure()`
still returns true and the narrow → confirm → re-widen bridge calls still fire — privileged
`DesktopBridge` operations that restart the backend — plus another full round via the
`while (requestedRef.current)` loop and a toast on a dead component. No bridge call has a timeout, so
a hung bridge wedges the reconciler for the session.

**M-O Widen + mint-failure + cancel-failure skips exposure cleanup entirely and reports it wrongly** —
MEDIUM · CONFIRMED. `shareOffer.ts:272` gates cleanup on `cancellationSucceeded && widened`. When the
cancel also fails, cleanup is never attempted; because the mint created no grant the authority
revision never bumps, so the reconciler's revision-keyed effect never fires either. The host stays
wide until the user acts or the app restarts — and the message shown ("remote-access cleanup also
failed. Review Exposure and retry cleanup") is factually wrong, since cleanup was never attempted.

**M-P Firewall command has no timeout and runs under the exposure coordinator mutex** — MEDIUM ·
CONFIRMED. `firewall.rs:90-97` awaits `command.output()` with no timeout, and the `71cd7fc3` delete
path shells out to PowerShell that enumerates the entire `PersistentStore` rule set twice. It is
called from inside `apply_exposure_locked`, which holds `ServerExposureCoordinator`'s mutex — so a
hung `powershell.exe` blocks every WSL toggle and the Tailscale toggle indefinitely, with the Tauri
command future never resolving.

**M-Q WSL-only mode binds `0.0.0.0` while reporting `local-only`** — MEDIUM · CONFIRMED code /
JUDGEMENT-CALL exploitability. `backend.rs:63,237` binds `0.0.0.0` while `:238` hard-codes
`server_exposure_mode: "local-only"`; `bridge.rs:433-441` prefers the run config, so the UI reports
local-only. `native_exposure_available()` is `!wsl_only`, so the firewall rule is never opened _or
audited_ in this mode. The Share tab still mints off-host offers here (setting `desiredExposure =
"wide"` server-side) while the reconciler cannot act (`canManageNativeExposure` is false), so the
"revert when the last grant is revoked" invariant simply does not hold in this topology. Actual LAN
reachability depends on WSL2 NAT vs mirrored networking; the presentation is unconditionally wrong.

**M-R Check-all fan-out has no per-request deadline** — MEDIUM · CONFIRMED. Concurrency is properly
bounded at 2, but `makeProtocolSocket` takes no timeout and `SOCKET_OPEN_TIMEOUT` bounds only the
WebSocket open. A server whose socket is up but which never answers `updater.check` — plausible
precisely here, since the handler can legitimately take 30 s — wedges one of two workers indefinitely
and leaves `checkingAllServerUpdates` true forever, permanently disabling the button. No unmount
abort either.

**Verified clean:** the `bridge.rs` rollback `?`-bug is fully fixed — every step in `recover_local`
is unconditional and error-accumulating, with `stop_backend()` as the last resort rather than leaving
a wide listener. Serialization is a real `tokio::sync::Mutex` and **every** topology mutator takes it
(apply, both WSL toggles, distro, Tailscale, startup) — no unguarded production path exists. The
narrow → re-read → re-widen sequence genuinely closes the narrow-races-a-mint window.
`rollbackRegistration` is a correct compare-and-remove including platform-shadow cases. No
`std::sync::MutexGuard` is held across an `.await` in either pump. No leaked timers or DOM listeners;
supervisor fibers and queues are all scope-finalized. Atom families are WeakRef+FinalizationRegistry
with a 5-minute idle TTL and nothing polls. All E2EE permits are RAII with a Weak-keyed,
pruned-on-lookup principal map — no budget leak.

Low (3): reconciler swallows apply failures with only a `console.warn`, so a failed automatic narrow
(which may have stopped the backend) produces no user-visible signal · `is_verified_local` rejects a
WSL-backed run config and can escalate a benign narrow into a full backend stop · `mark_disconnected`
is a plain call rather than a drop guard, so a panic leaves a phantom live connection forever.

---

## 5. Performance and backpressure

**H-F The global outbound byte semaphore is FIFO, so one large message head-of-line-blocks every other
E2EE connection** — HIGH · CONFIRMED (verified). `RpcOutboundBudget::acquire` (`session.rs:82-89`)
awaits `acquire_many_owned` on the connection semaphore then the **process-global** 128 MiB one.
tokio semaphores are fair: waiters are served FIFO and a later small request cannot bypass an earlier
large one. A 64 MiB response parks at the queue head and every other connection's 200-byte response
queues behind it until it drains — and with the 5-second `OUTBOUND_SEND_TIMEOUT` those responses are
simply dropped, ending streams. One heavy client degrades every other remote session with no
isolation. Sharp edge in the same function: `session.rs:226-228` cancels the entire session when a
single response exceeds the per-connection capacity, rather than failing that one response.

**H-G Per-record write deadline with no per-message deadline on the E2EE outbound pump** — HIGH ·
CONFIRMED. `e2ee.rs:805-827` applies the 5-second `SOCKET_WRITE_TIMEOUT` to _each record_, inside the
loop. A 64 MiB message is ~1024 records, so a client that accepts one 65 KiB record every 4.9 s never
trips the deadline yet stalls the single serial outbound pump for ~85 minutes — holding up to 64 MiB
of the 128 MiB global pool the whole time, which via H-F back-pressures every other connection into
5-second timeouts, while also holding one of only 64 established slots. This is the amplifier that
makes H-F reachable from a single peer.

**M-S Every RPC response on an E2EE connection is JSON-serialized twice** — MEDIUM · CONFIRMED.
`session.rs:1274-1283` calls `encoded_server_message_len` (a full `serde_json::to_writer` into a
counting sink) to size the budget, then `serde_json::to_string` to produce the frame. The same double
pass exists in `RpcOutboundQueue::try_send` and the guarded unary path. Remote sessions pay ~2× the
JSON CPU of local ones on the hottest path in the system — streamed terminal output, activity events,
every unary response — against a stated "performance first" priority.

**M-T Inbound accounting charges wire bytes while peak memory is the JSON DOM; plain `/ws` has no cap
at all** — MEDIUM · CONFIRMED. `decode_client_messages` materializes a full `serde_json::Value` before
converting, and the DOM is typically several times the byte size, so a "128 MiB global budget" can
correspond to well over a gigabyte resident. Worse, the plain `/ws` upgrade (`http.rs:209-261`) sets
neither `max_message_size` nor `max_frame_size`, inheriting tungstenite's 64 MiB/16 MiB defaults with
no byte budget behind it — the E2EE side proves the fix is a one-line change.

**M-U Inbound byte permits are pinned for the entire request lifetime, including streams** — MEDIUM ·
CONFIRMED. The permit is attached to the frame, cloned per decoded message, and held to completion at
`session.rs:955`. A 40 MiB request that starts a stream subscription pins 40 MiB of both the
connection and global budgets for the subscription's whole life; combined with H-D, two such requests
take the process-wide pool out of service and start closing other principals' connections.

**M-V Client `RecordAssembler` bounds summed bytes but not per-record object overhead** — MEDIUM ·
CONFIRMED. `frame.ts:49-59` caps `assembledBytes` but pushes each chunk as its own `Uint8Array`. A
peer sending 2-byte records can push ~67 million 1-byte typed arrays before the byte cap trips — at
~100 bytes of V8 overhead each, multiple gigabytes of heap for a nominally 64 MiB message, OOMing the
tab. Requires a compromised paired host, which is precisely the boundary E2EE exists to bound; the
server-side hardening in this range has no client-side mirror.

Low (4): zero-length continuation records are free in the byte budget, giving unlimited AEAD
decryptions at zero cost (the existing test uses 1-byte chunks and misses it) · the firewall narrow
now costs two full PowerShell rule enumerations plus process start on a UI path, inside the mutex ·
pairing-offer creation holds a process-global mutex across all its database work · reassembly `Vec`
capacity doubling means a 64 MiB message can hold ~128 MiB while only 64 MiB was charged.

**Verified clean:** the outbound pump genuinely encrypts record-by-record with the `std::sync::Mutex`
scoped to `encrypt_record` and dropped before the socket await — peak extra memory is ~131 KiB per
record instead of a second 64 MiB buffer. Byte permits are correctly retained through the encrypted
writes. Framing constants are byte-identical across Rust and TypeScript (65,535 / 16 / 65,518 /
flags / 64 MiB / 64 KiB), and the transport cap exactly equals the max ciphertext so a legal frame is
never rejected by the transport. The 5-second admission and write deadlines survived every refactor.
Check-all concurrency is bounded at 2 with per-environment single-flight de-duplication. The updater
delegate has a real 30-second `tokio::time::timeout`, deterministically tested.

**M-W Blob delivery would reorder E2EE records and permanently break the channel** — MEDIUM · latent,
currently mitigated. The Effect socket delivers `Blob` payloads asynchronously, each in its own fiber,
while the E2EE handler decrypts synchronously with a counter-based nonce — one reordering kills the
channel. Browsers default `binaryType` to `"blob"`. It is safe today only because
`session.ts:131-135` sets `arraybuffer` synchronously at construction, pinned by one test. Nothing in
`makeE2eeSocket` defends the invariant, so any other construction path silently reintroduces it, and
the symptom would look like an intermittent protocol error rather than a configuration bug.

---

## 6. Test and documentation gaps

Missing regression coverage, each tied to a finding above: fresh-start behaviour when legacy grants
exist and the durable mode is wide (H-C) — the existing test covers only _legacy blocks narrowing_;
`/pair?host=<untrusted>` must not connect before a user gesture (M-I); E2EE reply-write failure must
revoke the minted session (M-K); restart with a reserved-but-uncompleted offer row must not leave the
link live (M-L); a third connection must _not_ be closed while two others hold large buffers (H-D);
one peer must not consume all pre-auth slots (H-E); a small response on connection B must land while
A holds a large global reservation (H-F); `disconnect` on a registered-but-cold environment must not
connect (M-M); `generateShareOffer` with `widened: true` and an `"unchanged"` cleanup must not report
`"not-needed"` (M-H); a hung firewall command (the fake runner makes this trivial) (M-P); a shared
cross-language endpoint-classification fixture (M-J) — the TS table has 27 cases, the Rust side has
five with no IPv6, no bracketed literal, and no unit test for `is_loopback_host` at all; `hostKey: ""`
classified identically through both entry points (M-B).

Two existing tests **codify defects** rather than guard against them:
`one_connection_cannot_monopolize_the_global_budget` bakes in the 2:1 ratio that causes H-D, and
`many_tiny_records_remain_within_the_byte_budget` uses 1-byte chunks, missing the zero-length case.

Documentation: spec §4.3 and §4.6 both contradict shipped behavior and were never amended (M-F, H-C);
the stabilization plan ticks six boxes for a file that no longer exists and lists a command that
cannot run (H-A); plan checkboxes disagree with Task 14 about whether the final gate ran;
`remote.md:187,196` says "principal" where the code keys by session.

Undisclosed skip composition: the 2 skipped test _files_ are the opt-in interop and Docker gates
(both run independently and passed); the remaining ~25 skipped tests are pre-existing `describe.skip`
suppressions from `bfbecf59` (2026-07-31), before the range base — not introduced here, but not
disclosed either. **[Correction 2026-08-30]** No unconditional `describe.skip` exists: 22 are the
static half of a dual-environment happy-dom `.dom.test.tsx` shim introduced by `db8e21c0`, and 3 are
platform gates.

---

## 7. Validation results

Every command run independently; every claimed count reproduced **exactly**.

| Gate                         | Claimed                        | Actual                                              | Result                                |
| ---------------------------- | ------------------------------ | --------------------------------------------------- | ------------------------------------- |
| `vp check`                   | 1,995 fmt / 1,408 lint         | 1,993 / 1,408                                       | PASS (delta = the 2 deleted md files) |
| `vp run typecheck`           | 11/11, 123 suggestions         | 0 err / 0 warn, 123                                 | PASS                                  |
| `vp test` (full)             | 8,548 pass, 2 files/29 skipped | 8,548 passed, 29 skipped, 613 files                 | PASS                                  |
| `cargo fmt --all --check`    | clean                          | clean                                               | PASS                                  |
| server tests                 | 2,796 / 0 / 2 ignored          | 2,796 / 0 / 2 ignored, 59 targets                   | PASS (247 s)                          |
| desktop tests                | 329                            | 329 / 0 (321 lib + 1 + 2 + 5)                       | PASS                                  |
| clippy, both crates          | no warnings                    | **in-repo run was a 0.2 s cache replay**            | see below                             |
| clippy, forced fresh         | —                              | 653 crates compiled, both clean under `-D warnings` | PASS                                  |
| interop (`serverInterop`)    | 3 passed                       | 3/3                                                 | PASS                                  |
| Docker cross-container smoke | 1 passed                       | 1/1, cleanup verified 3 ways                        | PASS                                  |

**Clippy honesty:** the in-repo invocations returned in 0.2 s with zero Compiling lines — they only
replayed the implementer's verdict. Forcing a genuine lint through an out-of-repo `CARGO_TARGET_DIR`
compiled 653 crates from scratch and both crates came back clean. The claim is real; the command as
written in the report proves nothing.

**Flake triage:** all four named prior flakes green. The `e932cd3f` ETXTBSY retry worked and has its
own regression test. The twice-stabilized `reconciliation_defers_history…` passed 3/3 isolated reruns
plus its full 76/76 target — though see M-E: it passes because the assertion was widened, not because
the nondeterminism was fixed.

**Docker was available and exercised** (Podman 5.8.4 behind Docker CLI 29.7.2), matching the report's
honest "not a Docker Engine daemon" disclosure. Image digests matched; cleanup verified three ways.

**Runbook fidelity:** `docs/testing/cross-platform-validation.md` interop, cross-container, and
cleanup blocks executed verbatim and produced the documented results. No doc/reality drift.

**One material accuracy defect (M-X, MEDIUM):** the evidence report's "Pushed: no" is false at the
range tip. `git ls-remote` returns `e3cd9d81` on `origin/develop`, with a reflog `update by push` at
2026-08-29 08:38:54, about 11½ hours after the report commit was authored. The whole 141-commit range
is live on the public remote, and the companion "remote/local `0 140`" is now `0 0`. True when
written; stale as the standing claim — and it means M-I's auto-connect path is public code.

**Report credibility overall:** the executable claims hold up, and the report volunteers three
self-incriminating disclosures a whitewash would omit — an `INTERRUPTED / 130` run explicitly refused
as a pass, the hidden production delta behind `81eff018`, and a hard-rule violation in `929d0e80`.
Its non-executable claim — "no remaining Critical, High, or Medium product issue" — does not survive
this review.

---

## 8. Final merge verdict

**DO NOT MERGE AS-IS.** Fix the seven High findings first; the Mediums can be scheduled, with four
exceptions called out below.

Totals: **7 High · 24 Medium · 17 Low** — 41 CONFIRMED, 7 JUDGEMENT-CALL.

The Highs fall into three groups:

1. **A shipped user-facing regression** — H-C. Existing users with pre-`reach` grants lose remote
   access permanently on the next restart, silently, with no in-product recovery. This is the only
   finding that breaks working behaviour for people who already have it.
2. **Single-peer denial of service against the remote channel** — H-D, H-E, H-F, H-G. Together these
   let one client (unauthenticated, for H-E) stall or disconnect every other remote session. They
   compound: H-G holds a large reservation for ~85 minutes, H-F makes that block everyone else's
   traffic FIFO, H-D then closes those innocent connections rather than throttling them.
3. **Process integrity** — H-A, H-B. A security gate deleted and production behavior shipped, both
   concealed under `docs(...)` subjects, with the plan still asserting the gate exists. These do not
   break running code, but they mean git history and the plan are not reliable evidence of where
   behavior changed — which is the assumption every future review of this subsystem will make.

Four Mediums I would treat as merge-blocking despite the rating: **M-A** (the branch reintroduces two
files the user deleted — mechanical, fix before merge), **M-I** (a public-facing auto-connect with no
confirmation, already live on the public remote), **M-J** (silently widens the host against a rule
that was pinned specifically because an earlier review caught this class), and **M-X** (correct the
publication-state claim so the standing evidence is honest).

What genuinely holds: the exposure state machine, cross-process auth convergence, admission
atomicity, no-downgrade enforcement, the pre-auth cap, idempotency scoping and bounding, host-key
custody, framing parity, and the full validation battery. The stabilization pass fixed most of what
it set out to fix. What it did not do is fix everything it claimed, and two of its own commits made
things worse in ways its self-certification did not catch.

---

## 9. Field-reported failures on the packaged build

Two defects reported by the user against an installed build, added after the agent sweep. Both
verified against source here.

### H-H — The connection catalog cannot recover from an IndexedDB version conflict, and the recovery the UI offers acts on a different subsystem — HIGH · CONFIRMED

Reported: after installing the new version, a storage error appeared; choosing **Start empty** and
then adding a project failed with
`Could not open the local connection catalog: VersionError: An attempt was made to open a database
using a lower version than the existing version.`

Verified code facts:

- `apps/web/src/connection/storage.ts:38-39` — `DATABASE_NAME = "bibcode:connection-runtime"`,
  `DATABASE_VERSION = 2`. **Neither changed in this range**; last touched by `bfbecf59`, before the
  base. So the range did not cause the version skew.
- `openDatabase` (`:115-143`) registers only `upgradeneeded`, `error`, and `success`. There is
  **no `blocked` handler**, so if another window holds the database open the Effect callback never
  resumes — an indefinite hang rather than an error.
- **No `indexedDB.deleteDatabase` call exists anywhere in application code.** The single occurrence
  in the repository is an e2e assertion that the wdio config does _not_ contain it
  (`tauri-service-compat.test.ts:82`).
- The `reset-connection-catalog` recovery (`storage.ts:110`, `persistence.ts:31`) writes **through
  the same `openDatabase`**, so it cannot recover from a failure to open. Every recovery route is
  behind the door that is stuck.
- The **"Start empty"** the user chose is `startEmptyProjectData` on the desktop bridge
  (`tauriDesktopBridge.ts:512` → `projectDataSafety.ts:110,150`,
  `ProjectDataRecoveryDialog.tsx:186`) — that is the **server-side project-data** recovery, an
  entirely different subsystem. It does nothing to the IndexedDB catalog, which is exactly why the
  next action still failed. The dialog presents itself as the answer to a storage problem it cannot
  fix.

**Range relevance.** The range widened the blast radius: it wired `ConnectionRegistrationStore`
(including the new `removeIfMatching` CAS used by remote-server pairing rollback) into this same
catalog (`storage.ts:616-631`, `:876`; consumed at `registry.ts:148,654`). A catalog that will not
open now blocks Add Project for _every_ environment, Local included.

**Attribution, stated honestly.** I could not reproduce the version skew from on-disk state. The only
IndexedDB databases under `com.bibcode.desktop` (origins `tauri_localhost_0` and
`http_localhost_5733`) hold a single database named `b` at `DatabaseVersion=2` with
`MaxObjectStoreID=1` — `bibcode:connection-runtime` (which would have three stores) is absent from
both. So the failing profile is a different origin, identifier, or browser than the one inspected.
The _trigger_ is unconfirmed; the _unrecoverability_ is confirmed and is the defect worth fixing.

**Fix.** On an open failure whose `error.name` is `VersionError`, offer an explicit destructive
recovery that calls `indexedDB.deleteDatabase(DATABASE_NAME)` and recreates at the current version;
add a `blocked` handler that resumes with a distinct "close other BiBCode windows" failure; and route
the storage-recovery dialog to the subsystem that actually failed rather than to
`startEmptyProjectData`.

**Missing regression tests.** `storage.test.ts` already stubs `indexedDB` (`:1384`), so all three are
cheap: open against a higher stored version surfaces a recoverable, correctly-typed error; the reset
path succeeds after a `VersionError`; a `blocked` event resumes instead of hanging.

### H-I — Advertised address enumeration finds exactly one address, so VPN and secondary-interface addresses can never be offered — HIGH · CONFIRMED

Reported on macOS: the Address picker lists only **Automatic (LAN)** and **Local network**, while the
machine holds four IPv4 addresses — `lo0 127.0.0.1`, `en0 192.168.68.22` (default route),
`utun4 100.114.116.116` (Tailscale), `utun100 10.200.0.108` (a second VPN, Netbird). Neither VPN
address is offered, so the host cannot be shared over either tunnel.

Root cause — `resolve_lan_advertised_host()` (`apps/desktop/src-tauri/src/backend.rs:2741-2752`) is
the **only** non-loopback address source in the product:

```rust
let socket = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
socket.connect(("8.8.8.8", 80)).ok()?;
let address = socket.local_addr().ok()?.ip();
```

That is the default-route trick. It returns **exactly one** address — the one the kernel would use to
reach 8.8.8.8 — and additionally discards IPv6 (`!address.is_ipv4()`) and `169.254/16`. Its single
result becomes `config.endpoint_url`, and `advertised_endpoints_for_config`
(`bridge.rs:579-601`) emits precisely two candidates: the loopback one, and `"Local network"` **iff**
`endpoint_url` is `Some`. **There is no interface enumeration anywhere in the codebase** — neither
`if-addrs`, `network-interface`, nor `local-ip-address` appears in any `Cargo.toml`. This is
platform-independent: Windows and Linux are equally affected, so the user's requirement that
enumeration work on all three is currently met on none.

Tailscale is special-cased rather than enumerated, and that special case also fails here.
`tailscale_advertised_endpoints_for_config` (`bridge.rs:650`) shells out to the CLI, and
`tailscale_command()` (`tailscale.rs:19-25`) returns the bare string `"tailscale"`, resolved through
`PATH`. A macOS GUI-launched app inherits a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), while
Tailscale.app ships its CLI inside the bundle at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` — so the probe fails silently and the Tailnet
address never appears even though `parse_tailscale_status` would have accepted it. Netbird has no
special case at all and never can under this design.

**The client-side classifier is already correct and is not the problem.** `isPrivateIpv4`
(`packages/shared/src/advertisedEndpoint.ts`) already accepts `10/8`, `172.16/12`, `192.168/16` and —
notably — CGNAT `100.64.0.0/10`, so both the Tailscale and the Netbird address would classify as
`private-network` and drive `off_host` correctly today. Only the enumeration is missing.

**No new exposure.** When the mode is network-accessible the backend already binds `0.0.0.0`
(`DESKTOP_LAN_BIND_HOST`), so every one of these addresses is _already_ listening. This is a
candidate-list gap, not a bind-surface change — which is what makes it safe to fix directly.

**Fix — real cross-platform enumeration.** Replace the single-address resolver with a
`getifaddrs`/`GetAdaptersAddresses` enumeration (the `if-addrs` crate covers Linux, macOS, and
Windows behind one API and is the leanest option), keeping `resolve_lan_advertised_host()` only to
mark which candidate is the default-route pick. Per address: drop loopback, link-local
(`169.254/16`, `fe80::/10`), and unspecified; keep the interface name so two tunnels stay
distinguishable (`utun4` vs `utun100`); label by range — default route → "Local network", RFC1918 →
"Local network (⟨iface⟩)", CGNAT `100.64/10` → "Tailscale" (reusing the existing
`is_tailscale_ipv4_address` predicate, so the Tailnet address appears whether or not the CLI is on
`PATH`), anything else → "Public"; and sort default-route first, then private, CGNAT, public, stable
by interface name. Keep the CLI probe for MagicDNS/Serve only, and resolve it through the known
absolute bundle paths before falling back to `PATH`.

**Missing regression tests.** `advertised_endpoints_for_config` is already unit-tested with a
synthetic `BackendRunConfig` (`bridge.rs:2385-2400`), so inject the enumerator the same way
`resolve_backend_exposure_with` already injects its resolver: a fixture holding
loopback + default-route + CGNAT + a second RFC1918 tunnel must yield four labelled, correctly
ordered candidates on each platform, and must drop link-local. Add a `tailscale_command()` test
asserting bundle-path resolution ahead of `PATH` on macOS.
