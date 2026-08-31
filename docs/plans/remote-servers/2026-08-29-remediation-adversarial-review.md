# Adversarial Review — Remediation Range `e3cd9d81..0e4767b5`

Six independent axes over 17 commits (70 files, +4,440/−501), plus the full feature range
`3b1864ef..0e4767b5` (158 commits). Read-only: `git status --short` byte-identical at start and
finish on every axis — the two staged deletions and the untracked prior review, untouched.
Every contested or verdict-changing claim was re-verified personally against source before adjudication.

**Verdict: DO NOT MERGE AS-IS.** The remediation is substantial and mostly genuine — 14 of the 24
prior Medium findings and 2 of the 7 prior Highs are properly fixed with real regression coverage.
But it introduces **four new High-severity regressions**, two of which break working behaviour for
honest users, and one of which defeats a security control added in this same range.

**6 High · 27 Medium · 14 Low.** Confidence: 41 CONFIRMED, 6 JUDGEMENT-CALL.
Separately tracked: 9 PRE-EXISTING defects (not introduced here) and 1 residual platform gap.

---

## 0. The six blockers

| #      | Finding                                                                                        | Origin                        | Verified   |
| ------ | ---------------------------------------------------------------------------------------------- | ----------------------------- | ---------- |
| **H1** | Flat 5 s deadline per _logical message_ imposes a ~107 Mbit/s floor; expiry kills the session  | **NEW** (`e2ee.rs`)           | personally |
| **H2** | Inbound budget still disconnects innocent connections — now via FIFO head-of-line blocking too | **NEW** + unfixed             | agents ×2  |
| **H3** | Hosted-pairing confirmation renders the raw `host` param — userinfo/IDN spoofing               | **NEW** (defeats the M-I fix) | personally |
| **H4** | `resolve_lan_advertised_host` lost its loopback/link-local guards — fail-open widen            | **NEW** (`6622d9a2`)          | personally |
| **H5** | Pre-auth pool still exhaustible from 8 source addresses; the new test codifies it              | partial fix                   | personally |
| **H6** | Per-connection outbound tier is still plain FIFO with no deadline                              | partial fix                   | personally |

---

## 1. Repository standards and package ownership

**Fixed and verified.** Duplicated capacity constants are single-sourced in a new
`apps/server/src/auth/limits.rs`, imported by both `service.rs:21` and `repositories.rs:19`, with the
wrong-constant gate corrected to `MAX_ACTIVE_PAIRING_OFFERS`. The transport-security policy is
genuinely centralized: `connectPresentation.ts:52` delegates to `connectionTransportSecurity`, and the
disputed empty-string semantic is resolved once via `(profile?.hostKey?.trim().length ?? 0) > 0`.
`packages/contracts` stays schema-only; the range adds no WS RPC methods so parity rules are vacuously
satisfied, and the new contract surface correctly crosses `DesktopBridge`. `if-addrs 0.15.0` is
properly ledgered (`rustRegistry` 81→82) and the ledger gate passes 13/13. **Zero reference-product
strings** in any line added to a non-docs path.

**M1 · MEDIUM · CONFIRMED — the "production under a `docs(...)` subject" pattern recurred, for the
third time.** `0e4767b5 docs(remote): record adversarial remediation validation` (empty body) carries
five non-docs files: the repository gate `scripts/remote-architecture-contract.test.ts:18-19`, a
public test API (`e2ee/testSupport.ts:19,109-117` gains `sendRecords`), +63 lines of Docker smoke that
are the **only** end-to-end coverage of the per-peer admission fix, `ConnectTab.test.tsx`, and an
unrelated activity fixture. Consequence: the report's own "Tested revision" names `e3cd9d81..f3eb0ab7`
and calls `0e4767b5` "the final documentation/evidence commit" — **so the 8,565-test run did not
validate HEAD.** In fairness this one _is_ disclosed at `report.md:178-186` with red/green evidence,
unlike `81eff018`. A commit-lint rule rejecting non-docs paths under a `docs(...)` subject would end
the pattern permanently.

**M2 · MEDIUM · CONFIRMED — the M-B centralization is undone in test form.**
`ConnectTab.test.tsx:207-229` is a full-module `vi.mock("@bibcode/client-runtime/connection")` with no
`importOriginal`, reimplementing `connectionTransportSecurity` inline. It already diverges from
`presentation.ts:56-76` (tests `connectionId?.startsWith("local:")` for any tag; falls through to
`"unencrypted"` where the real switch is exhaustive). Forty ConnectTab tests assert against the copy.

**M3 · MEDIUM · CONFIRMED — a third network classifier, not fixture-governed.** `6622d9a2` added
`network_interfaces.rs:66-79` alongside the two `1bcff049` had just unified, with two vocabularies for
one concept: `AdvertisedEndpointReachability` (`loopback|lan|private-network|public`) vs
`PairingEndpointClassification` (no `lan`). `192.168.1.20` is `"lan"` per `bridge.rs:620` and
`"private-network"` per the shared fixture. `is_private_network` _includes_ `is_cgnat_or_tailscale`, so
`bridge.rs:617-624` is correct only by branch order — reorder the `if`/`else if` and every tailnet
address silently becomes `"lan"`.

**M4 · MEDIUM · CONFIRMED — prior M-D is unfixed and the approved design committed to it.**
`server_exposure.rs` does not appear in the range's 70-file diffstat. `a0fecd32` touched `bridge.rs`
and the UI instead. The two five-step narrowing safeguards (`:98-124`, `:167-192`) still differ only
by a `"recovery "` prefix. The design says "Desktop local-recovery helpers share one internal
safeguard routine"; the plan's Task 13 omits the clause while marked all-`[x]` with the report
recording PASS.

**M5 · MEDIUM · CONFIRMED — merging still reintroduces the user's deleted files.** `git ls-tree HEAD`
returns both blobs (`344c6326`, `43c6505b`). `f458ce6c`'s restoration was never reverted. The worktree
is correct only because the user re-staged; HEAD and `origin/develop` are not. One commit fixes it.

**L1–L6 · LOW.** `f3eb0ab7 refactor(remote)` contains three real fixes (invisible to
`git log --grep='^fix'`) · prior M-E unfixed (`provider_opencode.rs` untouched: `:4505` sleep, `:4517`
`== 2`, `:4521` `(2..=3)`) · `rpc/session.rs` is now 2,145 lines owning both session semantics and a
byte-weighted allocator · `tailscale.rs:117-129` loops 4 candidates × 1.5 s = 6 s worst case on a
DesktopBridge path · `databaseHealth.ts` is a module-level mutable singleton with a test-reset hatch ·
prior H-B never disclosed (zero occurrences of `81eff018`/`eb11b705`/`01102b1a` in any remediation doc).

---

## 2. Specification fidelity and undisclosed deviations

**M6 · MEDIUM · CONFIRMED — non-amendment of the normative spec is now written into the approved
design.** Zero commits touch `docs/plans/remote-servers/`. The remediation design (`:275-276`) states
"The original phase specification remains historical and is not rewritten," converting last round's
oversight into deliberate policy. **The stated rationale does not survive inspection**: the spec
already carries nine dated in-place amendment markers (`:95, :107, :131, :174, :191, :258, :303, :322,
:343`) — dated amendment _is_ this document's own convention. Five shipped behaviours now contradict
§4 without record: §4.6 "stays exposed" vs per-boot re-consent; §4.3 "leave it retryable" vs the
deliberately burned token; §4.3 framing gains a 2,048-record cap and zero-continuation rejection (a
conforming client chunking below ~32 KiB can no longer deliver the pinned 64 MiB message); §4.3's
outbound deadline (see H1); §4.8's new Share-tab surface. And `0e4767b5` _strengthened_ the gate
pinning the opposite text into `remote.md`, so a repository gate now mechanically enforces a
contradiction with the document the execution prompt calls NORMATIVE.

**M7 · MEDIUM · CONFIRMED — `remote.md` documents a client-side revocation that does not exist.**
`:254-258`, added by `0e4767b5`: "Verification or local-persistence failure after credential delivery
**also attempts authenticated server-side revocation**." No such code — `pairingAdd.ts` and
`onboarding.ts` are unchanged across the entire range, and the only `revoke` reference is the manual
instruction string at `pairingAdd.ts:73`. The commit **replaced accurate text**; the prior wording
said "The operator can revoke the incomplete session from the host's client list." Found independently
by the spec and security axes.

**M8 · MEDIUM · CONFIRMED — `remote.md` contradicts itself on `hostKey`, and the code implements the
wrong half.** `:452-453` says a non-null `hostKey` selects `/ws-e2ee`; `:454-455` says null, empty, _or
whitespace_ is a legacy `/ws` profile. `authorization/service.ts:132` checks only `undefined`/`null`
with no trim, and `catalog.ts:27` decodes `""` as `""`. So a blank `hostKey` takes `/ws-e2ee` **and
nulls `httpAuthorization`, breaking HTTP fallback**, while `presentation.ts:74` trims and badges it
"Unencrypted". M-B's divergence was relocated, not closed.

**M9 · MEDIUM · CONFIRMED — `remote.md:154-155` still claims inbound permits are held "through
handling"** when `session.rs:982-987` now releases them at dispatch. Verified an unchanged _context_
line inside a hunk the same commit rewrote around. The narrowing itself is deliberate and documented
in the design; only the living doc was missed.

**Genuinely fixed — prior M-G.** Design 11:09:19 → plan 11:11:54 → first implementation 11:13:19.
Every remediation subsystem, including endpoint enumeration and DB recovery, is described in the
pre-approved design. The +5 lines to the stabilization design in `0e4767b5` are the supersession note
that design itself prescribed — not post-hoc justification. This was last round's governance finding
and it is properly closed.

**L7 · LOW — plan/tree drift.** All 56 boxes `[x]` and every literal verification command runs, but
three `**Files:**` entries name paths never touched (`plan:70, :319, :432`), two "Modify" claims went
unsatisfied, and `plan:556/563` marks `vp check` `[x]` while `report:192` lists it under **Commands
not run**.

---

## 3. Security and trust boundaries

**H3 · HIGH · CONFIRMED (verified personally; the security axis rated this Medium — I disagree).**
The hosted-pairing confirmation renders the **raw** `host` query parameter.
`PairingRouteSurface.tsx:257` renders `{request.host}`; `hostedPairing.ts:53` reads
`url.searchParams.get("host")?.trim()`; and `normalizeRemoteBaseUrl` (`packages/shared/src/remote.ts:106-162`)
clears `pathname`, `search`, and `hash` but **never touches `username`/`password`**, so userinfo
survives normalization. Confirmed against the real WHATWG parser:

```
my-home-server.local@203.0.113.9      -> origin https://203.0.113.9   (username "my-home-server.local")
trusted.example@attacker.example:8080 -> origin https://attacker.example:8080
аpple.com  (Cyrillic а)               -> origin https://xn--pple-43d.com
```

A link on the **genuine** hosted origin —
`https://<hosted-app>/pair?host=my-home-server.local@203.0.113.9&label=My%20Home%20Server#token=…` —
displays `Host: my-home-server.local@203.0.113.9` and connects to `https://203.0.113.9/`. One click
registers the attacker's backend with `hostKey: null` (plain bearer), after which the victim's agent
activity — files, terminals, git — runs against the attacker's server.

I rate this High rather than Medium because the entire purpose of the M-I remediation was "render the
host before any network call so the user can refuse," and the gate now renders attacker-controlled
text: the control provides no protection while appearing to. No compromise of the hosted origin is
required. The approved design explicitly specifies "renders the **normalized** backend host"
(`remediation-design.md:46`). Tests miss it because `PairingRouteSurface.test.tsx` fixes an
already-normalized `host`. **Fix:** normalize once, render `url.host`, refuse userinfo, fail closed if
normalization throws.

**H5 · HIGH · CONFIRMED (verified personally).** `E2EE_MAX_PREAUTH_CONNECTIONS = 32` (`e2ee.rs:48`)
against `E2EE_MAX_PREAUTH_CONNECTIONS_PER_PEER = 4` (`:49`) means **8 source addresses drain the whole
pre-auth pool** — one IPv6 /64 is free. The lease releases only at `:839`, after the 10 s handshake
timeout, and 4 tokens per 10 s against burst 8 refilling at 1/s is sustainable indefinitely. Every
legitimate pairing and E2EE reconnect then gets close 1013. The per-peer partition is well-built
(bounded, TTL-pruned, RAII-released, real `ConnectInfo` wiring at `lifecycle.rs:377`) — it raised the
attacker's cost 8× without touching the ceiling. **The new test
`preauth_admission_keeps_global_capacity_and_prunes_idle_peers` (`e2ee.rs:1215-1239`) builds 8×4 and
asserts the 9th peer gets `Err("busy")` — it codifies the defect**, so it will survive future
refactors unchallenged. **Fix:** reserve global headroom and key the bucket on an IPv6 /64.

**M10 · MEDIUM — prior M-K is partial: compensation is in-process only.** `e2ee.rs:624-665` is a pure
in-memory `Drop` guard; no startup or periodic sweep exists. Both _triggers_ are correctly covered
(armed `:768-771`, covers the `bind_principal` rejection at `:804-807` and the reply-write failure at
`:826`, disarmed `:827-829`, revocation durable at `service.rs:1447-1471`) — but a crash in the
mint→reply window still leaves an unrevoked off-host session that `service.rs:1357-1381` counts toward
`desired_exposure = "wide"` for up to 30 days.

**M11 · MEDIUM — behind a proxy, SSH tunnel, or NAT the deployment collapses into one peer bucket.**
`http.rs:274-281`; no loopback exemption. Spec §4.6 explicitly contemplates tunnel and reverse-proxy
`custom` grants, which carry a `hostKey` and therefore route to `/ws-e2ee` — all arriving as
`127.0.0.1`, sharing 4 concurrent + 1/s. More than four devices reconnecting after a restart get
rate-limited.

**M12 · MEDIUM — a globally routable default-route IPv4 is labelled "Local network" and pre-selected.**
`bridge.rs:627-636` branches on `is_default_route` _before_ any reachability test. On a VPS or cloud
dev box the endpoint ships as `label: "Local network"`, `isDefault: true`, `reachability: "public"` —
the most dangerous candidate carries the safest label. No firewall mitigation on Linux/macOS
(`firewall.rs:185-188` is an unconditional no-op).

**M13 · MEDIUM — enumerated IPv6 addresses are advertised as `available` while the server binds
IPv4-only.** `bridge.rs:614-641` emits IPv6 GUA/ULA with a hardcoded `"status": "available"` and no
probe, but `DESKTOP_LAN_BIND_HOST = "0.0.0.0"` yields an AF_INET socket. Selecting one widens the real
IPv4 surface plus the firewall rule for an endpoint that can never accept a connection. Bounded by the
5-minute pairing TTL. `bridge.rs:2504-2506` asserts this as correct.

**M14, M15, M16 · MEDIUM — the IndexedDB recovery dialog.** A `blocked` reset tells the user nothing
was deleted **while the deletion stays queued and will proceed**, so abandoning the reset and closing
the blocking tab loses all credentials anyway; and `settled` (`databaseHealth.ts:84`) suppresses the
later `success`, so the undismissable modal stays up for a database that no longer exists (found
independently by three axes). The `incompatible` branch offers destruction as its **only** exit —
`Reload` exists only in the non-incompatible branch — even though `VersionError` means a _newer_
client wrote the database, so the correct remedy (use the newer client) is never offered. And a
double-click defeats the two-step confirmation, because React flushes discrete clicks synchronously
so the DOM swaps before click 2 is hit-tested while `busy` is still false.

**L8–L11 · LOW — all four prior security LOWs remain open.** Idempotency stale replay
(`prune_and_get_active_auth_pairing_offer` returns `pairing: None` for a consumed link at
`repositories.rs:1274-1285`, yet `service.rs:1219-1223` still returns `Original(result)`) · `code` not
stripped on `/pair` (`remote.ts:212-221` deletes only the token param; the settings route _does_
scrub) · `verify_websocket_ticket` still asserts no transport (`service.rs:691-711`) · `wsTicket` in
the query string.

**Verified still clean.** No-downgrade is restart-safe for the right reason: the load-bearing check is
`service.rs:618` on the **signed JWT claim**, exactly as design §4.3 specifies. Host-key pinning cannot
be weakened by the IndexedDB reset — structurally there is no unpinned-E2EE path. The pre-auth record
cap is now strictly tighter (2,048 records replacing effectively 65,536 one-byte records), and
`e2ee_ws.rs:636-654` exercises the genuine _cumulative_ path.

---

## 4. Reliability, cancellation, restart, rollback, concurrency

**H4 · HIGH · CONFIRMED (verified personally; found independently by four axes).** `6622d9a2` silently
dropped two deliberate fail-closed guards. The pre-range `resolve_lan_advertised_host` rejected
`is_loopback()` and any `169.254.` prefix, returning `None` so the host stayed local-only. It is now
(`backend.rs:2742-2746`):

```rust
default_route_ip().filter(IpAddr::is_ipv4).map(|ip| ip.to_string())
```

`default_route_ip()` (`network_interfaces.rs:104-108`) applies **no** filtering, and the module's own
correct predicate `is_usable_unicast` (`:118-126`) is applied only inside
`enumerate_advertised_addresses`, never to the default route. `resolve_backend_exposure_with`
(`:2769-2782`) treats any `Some` as "widen": `mode = "network-accessible"`, `bind_host = 0.0.0.0`. So
an APIPA or loopback probe result now produces a wildcard bind, an opened firewall rule, and an
unroutable advertised endpoint — reported as success, because `is_verified_wide` only checks the
fields are `Some`. `git log -S '169.254.' -- backend.rs` returns exactly two commits: `bfbecf59`
(added) and `6622d9a2` (removed). The approved design says the probe "remains only a ranking hint."
No test catches it — `backend.rs:4830` is `let _ = resolve_lan_advertised_host();`.
**Fix:** `default_route_ip().filter(|ip| ip.is_ipv4() && is_usable_unicast(*ip))`.

**H2 · HIGH — the inbound disconnect survives, by two mechanisms, one of them new.**
_New:_ `a06c40b5` replaced `try_acquire` with an awaited `acquire_many_owned` on the **global**
semaphore (`e2ee.rs:1139-1144`). Per tokio 1.53's `batch_semaphore.rs:306-361`, released permits are
assigned to queued waiters first and returned to `self.permits` only when the queue empties, so once
one 65 KiB record queues, a 200-byte record behind it is starved, times out at 5 s, and **its
connection is closed** — with the bytes available throughout. This is precisely the head-of-line
pathology `89f4ec89` hand-built a fit-first allocator to avoid, on the outbound side, in the same range.
_Unfixed:_ the per-principal (`:1146`) and per-connection (`:1153`) tiers remain `try_acquire` →
`Protocol` → `break` (`:1034-1036`). And `E2EE_INBOUND_BUFFER_BUDGET_BYTES_PER_PRINCIPAL` (64 MiB,
`:56`) **equals** `MAX_E2EE_LOGICAL_MESSAGE_BYTES` (`:40`), so one legitimate maximum-size message
from one browser tab disconnects that principal's other tabs. Every unit-test call site passes `None`
for `principal_budget` — the path has no unit coverage at all.
_Amplifier:_ there is no deadline on completing a logical inbound message, so two credentials can pin
the entire 128 MiB global pool with never-completed assemblies and every other connection is then
closed 5 s after its next record.

**M17 · MEDIUM — prior M-M's root cause survives.** `disconnect` is genuinely fixed, but
`createServiceScope` still overrides its own intent: `registry.ts:272` passes `initiallyDesired:
false` and `:281` then calls `supervisor.connect` unconditionally. So `run` (`:311-320`) still dials
cold environments on check-for-updates; `state` (`:793-796`) — **not previously reported** — dials as a
side effect of a read-only status query; and on catalog drift (`:299-306`) the scope is recreated
without carrying `desired`, **silently undoing an explicit user Disconnect**.

**M18 · MEDIUM — the M-N fix introduced a correctness regression.** The `mountedRef` gate is real, but
unmount between the narrow and the re-widen now drops the re-widen: `:62` narrows → unmount → `:67`
observes `"wide"` → `:70` gate false → `return "narrowed"`. The host stays local-only with a live
off-host grant, the freshly paired device is locked out, nothing retries, and `:169` fires the "Remote
access switched off" toast anyway. The prior review certified this sequence closed the
narrow-races-a-mint window; that guarantee is now conditional on staying mounted. The second call site
(`ShareThisHostTab.tsx:212-217`) was not fixed at all, and no bridge call anywhere has a timeout.

**M19 · MEDIUM — prior M-O's message is fixed but its behaviour is not.** `shareOffer.ts:279` and
`:287` both still require `cancellationSucceeded`, so cancel-fails-plus-widened still never attempts
cleanup. The new copy is honest and the "may still be redeemed" policy is defensible, but there is no
convergence path: no grant means no authority-revision bump, and the reconciler's only trigger is
`revision`. The host stays wide until the app restarts. Two tests **assert the absence of cleanup**.

**M20 · MEDIUM — prior M-Q is fixed in presentation and newly broken in the firewall.**
`bridge.rs` now derives actual mode from `bind_host` and reports `management: "external"` — good. But
`desktop_bridge_set_wsl_only` (`:1397-1415`) restarts preserving exposure and never calls
`sync_firewall(false)`, so enabling WSL-only from a network-accessible state leaves the Windows
firewall rule **open** and the persisted mode `network-accessible`, while the UI reports local-only and
the user can no longer narrow.

**M21 · MEDIUM — the M-P firewall timeout does not cover spawn on Windows.**
`supervised.rs:130-138` awaits `spawn_blocking(spawn_wrapped)` _before_ `execute_child` starts the
clock, so an AV/EDR-stalled `CreateProcess` is an unbounded await — while `apply_exposure` holds the
coordinator mutex. The child _is_ correctly killed on timeout (`:143-146`).

**M22 · MEDIUM — the M-R deadline starts after supervisor acquisition.** `registry.ts:313`
`acquireSupervisor` runs outside the timed effect and includes the `withLeaseLock` wait plus an
`Effect.uninterruptible` `createServiceScope`. `remote.md:297-299` overstates the coverage.

**L12 · LOW — `mark_disconnected` is still a plain call, not a drop guard** (`http.rs:264`,
`e2ee.rs:1088`); `133ab5d8` did not touch this despite its subject. The range already contains the
right pattern in `MintedSessionDeliveryGuard`.

---

## 5. Performance, memory bounds, admission control, backpressure

**H1 · HIGH · CONFIRMED (verified personally). The H-G fix overshot by three orders of magnitude.**
`send_established_encrypted_message` (`e2ee.rs:904-924`) applies **one absolute deadline across every
record in the loop** (`:918`), and the call site computes it as `Instant::now() + SOCKET_WRITE_TIMEOUT`
(`:993`) — a flat 5 seconds with no reference to `plaintext.len()`. `SOCKET_WRITE_TIMEOUT` is 5 s
(`session.rs:39`); `MAX_E2EE_LOGICAL_MESSAGE_BYTES` is 64 MiB.

A 64 MiB response is ~1,025 records ≈ 67.2 MB on the wire, all of which must be accepted within 5
seconds — **13.4 MB/s ≈ 107 Mbit/s sustained to a single peer**. A 10 MiB response needs ~17 Mbit/s.
The pre-fix code required 65,535 B / 5 s ≈ **13.1 KB/s**; the floor rose by a factor of ~1,024. On
expiry the pump does not fail one response — `break` (`:998`) → `close()` → `outbound_shutdown.cancel()`
(`:1002`) — so **one large file read or git diff on a slow link tears down the whole session and every
stream on it**, nondeterministically by link speed. This is the remote-server feature; the intended
links are WAN, Tailscale, and mobile.

The new test `outbound_logical_message_uses_one_absolute_write_deadline` (`e2ee.rs:1397-1421`) pins the
flat behaviour with a 2-record message; nothing tests that a legitimately large message on a merely
slow sink completes. **Fix:** derive the deadline from payload size
(`SOCKET_WRITE_TIMEOUT + len / MIN_OUTBOUND_THROUGHPUT`), or use a stall detector that resets the
per-record deadline only on actual write completion while requiring aggregate progress — one primitive
bounding both the original slowloris and the honest slow link.

**H6 · HIGH · CONFIRMED (verified personally). H-F was fixed only at the process tier.**
`session.rs:87-101`: the connection semaphore is acquired with `acquire_many_owned(permits).await` and
**no deadline** (`:92-95`); the deadline is passed only to `self.process.acquire(bytes, deadline)`
(`:96`). The process tier did get a genuine fit-first allocator with aging — real fix for
_cross-connection_ head-of-line blocking. But on the remote path one connection carries the entire
session: every terminal stream, activity event, and unary response multiplexed over one E2EE socket.
tokio semaphores are fair, so two concurrent multi-MB responses park every later 200-byte terminal
chunk behind them — H-F's user-visible symptom, unchanged for the single-connection case, which is the
normal case. Because the deadline is captured before the connection stage, a response waiting there
finds the process deadline already expired and `run_stream` **ends the stream silently**.
`remote.md:187-189` claims both stages "share one five-second admission deadline" — false.

**M23 · MEDIUM — the aging rule becomes a total blockade.** `session.rs:268-292`: once the head has
aged 1 s and still does not fit, no waiter is granted at all, bounded only by the head's own 5 s
deadline. A peer repeatedly requesting a near-64 MiB response it never reads sustains roughly an 80%
duty cycle of global blockade. `outbound_process_budget_reserves_released_capacity_for_an_aged_waiter`
asserts this as correct.

**M24 · MEDIUM — prior M-S is unfixed, deliberately, and is now described as fixed.** Every response on
an E2EE connection is still serialized twice (`session.rs:1473` then `:1476`). The design explicitly
rejects the optimization; `remote.md:178-180` then reframes it as "counts an upper bound… encodes
once," which reads as a fix to anyone not counting traversals.

**M25 · MEDIUM — prior M-T is cosmetic.** `MAX_PLAIN_WEBSOCKET_MESSAGE_BYTES` (64 MiB) is applied to
both `.max_frame_size()` and `.max_message_size()`, but tungstenite's defaults are 64 MiB message and
**16 MiB frame** — so the message cap is a no-op and the frame cap is **relaxed 4×**, on the one path
with no byte budget. The DOM decode is unchanged. Found independently by three axes.

**M26 · MEDIUM — prior M-W is unfixed.** `makeE2eeSocket` still does not defend `binaryType`; the
invariant lives in one line of `session.ts:133` pinned by one test, while the test double defaults to
`"blob"`. Async Blob delivery with a counter-based Noise nonce permanently kills the channel and
presents as an intermittent protocol error.

**L13–L14 · LOW.** `try_acquire` now refuses whenever _any_ waiter is queued (`session.rs:214-221`),
so under pressure a client cancelling a `latest` subscription silently never receives the interrupt ·
`grant_outbound_process_waiters` is an O(n) scan under a process-global mutex on the outbound hot path.

**Genuinely fixed:** M-U (the inbound guard is released after dispatch, with a real
`std::future::pending` regression test), M-V (record-count cap with Rust/TS parity), zero-length
continuations, and the fit-first process allocator with cancellation refunds. Endpoint enumeration is
correctly bounded — `Atom.swr({staleTime: 30_000})` + `keepAlive`, not per-render, not polled.

---

## 6. Test quality, documentation accuracy, repository gates

**M27 · MEDIUM — the route-level transport caps have no asserting coverage, and this is provable.**
The deleted `scripts/remote-transport-hardening.test.ts` is still absent. Its `mark_connected` half is
now genuinely covered behaviourally (`auth_http.rs:997`). Its cap half is not: **deleting
`.max_message_size(...)` from `http.rs:285` passes every test in the tree.** Eight sites in
`e2ee_ws.rs` (534, 560, 618, 633, 654, 780, 814, 882) do `let _ = next_close_code(...)`, discarding the
assertion — those tests can only fail by panic or hang. The replacement gate
`scripts/remote-architecture-contract.test.ts` is 22 lines asserting five prose substrings against
`remote.md`, with zero source invariants.

**Two tests codify defects rather than guard against them, and were not fixed — only superseded.**
`one_connection_cannot_monopolize_the_global_budget` (`e2ee.rs:1736`) now asserts the _connection_
budget path, so its name no longer describes what it tests; `many_tiny_records_remain_within_the_byte_budget`
still uses 1-byte chunks. New tests were added alongside rather than the originals being repaired.
Add to these the pre-auth test that asserts H5's defect and the two `shareOffer` tests that assert the
absence of M-O's cleanup: **four tests now pin defective behaviour in place.**

**`133ab5d8`'s subject describes a pre-existing invariant.** `git show 133ab5d8^:apps/server/src/http.rs`
already had `mark_connected` inside `on_upgrade`, and the added test passes on the parent commit. The
commit's only real production change is the untested 64 MiB caps (M25).

**The M-P firewall bounding is not compiled on Linux or macOS.** `ProcessFirewallCommandRunner` and its
`impl` are `#[cfg(windows)]` (`firewall.rs:92,103`); the test at `:278` asserts struct fields and never
runs a process. Reverting `run()` to the unbounded command leaves the suite green on the CI platform.

**Skips are clean, with one real gap.** 29 skips decompose as 22 static-half entries of a deliberate
dual-environment pattern (the browser tests _do_ run), 3 interop + 1 Docker opt-in gates (both run
independently and passed), and 3 platform gates. **Zero hard suppressions anywhere, and none added by
the range** — better than last round's picture. But **5 tests are genuinely unreachable**:
`Sidebar.test.tsx:4081` (4) and `GitActionsControl.test.tsx:2182` (1) sit in `if (browserRuntime)`
blocks with no `.dom.test.tsx` shim, so they are never registered and invisible to every reporter.
Pre-existing (`bfbecf59`). **[Correction 2026-08-30]** The correct count is 7: six declarations plus
one `it.each` with two rows — `Sidebar.test.tsx:4081` contributes 4 and
`GitActionsControl.test.tsx:2182` contributes 3.

---

## 7. Docker and native validation evidence

Every claimed count reproduced exactly: **8,565 passed / 29 skipped** across 615 files, **333 desktop**,
**1,713 server unit** (2,810 total across 59 targets including doc-tests), **3/3 interop**, **1/1 Docker
smoke**, **1,999 formatted / 1,412 linted**, **11/11 typecheck targets**, `cargo fmt` clean. Docker is
podman-backed (CLI 29.7.2, context `pathfinder-podman`, Podman 5.8.4), matching the report's own
disclosure. Cleanup verified: three filtered listings empty, both `inspect` calls fail, zero surviving
`bibcode` binary processes.

Three gaps between the claims and what actually happens:

**The server suite is not reliably green.** `production::managed_endpoint::tests::shutting_down_one_tunnel_runtime_preserves_its_live_peer`
failed on attempt 1 of 3 (panic `A PID` at `managed_endpoint.rs:435`); 5/5 in isolation and 2/2 further
full runs pass. **PRE-EXISTING** — `git diff e3cd9d81..0e4767b5 -- apps/server/src/production/` is
empty and `git merge-base --is-ancestor af27d39e e3cd9d81` is true — but it is a **different** flake
from the one the report documents, so there are at least two load-sensitive flakes and only one is
disclosed.

**Clippy was a cache replay again.** The claimed 13.94 s combined invocation returns in **0.25 s with
zero compile units** on this tree. The conclusion holds — a forced out-of-repo lint compiled 272 and
382 units respectively and both packages are clean under `-D warnings` — but the cited number is not
evidence that a lint ran. This is the second round with the same defect shape.

**The `vp check` exclusion is load-bearing, not cosmetic.** `vp check` aborts at the format stage on
failure, so without excluding the protected untracked review the lint stage never executes at all:
the 1,412 figure is _only_ obtainable with the exclusion. The arithmetic is honest (2,000 − 1 = 1,999)
but the report does not state the dependency.

---

## 8. Field-reported fixes

**IndexedDB recovery (`1b0c68c8`) — REAL.** A `blocked` handler exists, `VersionError` maps to
`"incompatible"`, `indexedDB.deleteDatabase` is called, the destructive delete is behind a two-step
confirmation enumerating what gets deleted, the dialog mounts independent of the failing Effect, and
`startEmptyProjectData` is no longer involved. Six tests cover it. Residuals are M14–M16, plus:
`openDatabase`'s Effect still never resumes on `blocked` — the hang is surfaced, not resolved — and the
monitor wiring at `storage.ts:135` has no test (delete that line and everything still passes).

**Endpoint enumeration (`6622d9a2`) — PARTIAL.** Genuinely cross-platform via `if-addrs 0.15.0`,
ledgered for all three platforms. A real injection seam exists (`NetworkInterfaceProvider` +
`FixtureProvider`), loopback/link-local/unspecified/multicast are excluded _in the enumerator_,
interface names are retained so two tunnels stay distinguishable, CGNAT and RFC1918 classification is
correct, and the macOS Tailscale bundle path is fixed and tested for all three platforms from any
host. **But** the same commit introduced H4, the CGNAT label path has no test reaching
`advertised_endpoints_for_config`, `default_route_ip` is IPv4-only, and fixtures are platform-agnostic
rather than per-platform.

---

## 9. Recommended order

1. **H1** — size-derive the outbound deadline. This is the only finding that breaks working behaviour
   for honest users on ordinary links, and this range introduced it.
2. **H3** — normalize before rendering the pairing host. Small, and it restores a control that is
   currently decorative.
3. **H4** — reapply `is_usable_unicast` to the default route. One line; restores a deliberate
   fail-closed guard.
4. **H2** — use the fit-first allocator for the global inbound pool, and stop mapping pool pressure to
   disconnect; add an assembly-progress deadline.
5. **H6 / H5** — extend the fit-first allocator and its deadline to the per-connection tier; reserve
   global pre-auth headroom and key on /64.
6. **M5** — one commit to stop the branch reintroducing the deleted files.
7. Then the four defect-codifying tests, since they will otherwise re-approve each regression.

---

## Appendix — classification

**PRE-EXISTING (not introduced here, still live):** the inbound reassembly slowloris · a >64 MiB
response cancelling the session · the guarded-unary 4× serialization · the `/ws` DOM decode ·
`closeServiceScope`'s interrupt window · supervisor signal loss on a raced queue take ·
`generateShareOffer`'s undeadlined widen · the `managed_endpoint` flake · the 5 unreachable browser
tests · the absolute-date activity fixture class (~86 `2026-*` literals in one file; today's cutoff is
2026-07-30 and `2026-08-01` appears at ~81 sites, crossing on 2026-08-31 — the 2099 bump patched one
site, not the class).

**JUDGEMENT-CALLS (6):** M3's branch-order fragility · M11's NAT prevalence · M12's public-label impact ·
M23's duty-cycle estimate · M26's severity (needs a compromised paired host) · L7's plan-drift materiality.

**RESIDUAL PLATFORM RISK:** packaged native UI, updater, and firewall validation on Windows and macOS
remains unexecuted — and the M-P firewall bounding is `#[cfg(windows)]`, so it is not merely unvalidated
on this platform but not compiled here at all.
