# Disposable issue17 Chromium offline diagnosis

This temporary QA branch adds an observation and contained fixture repair to the
existing browser smoke. It changes no production connectivity policy. The
earlier paired HTTP/HMR-only run suggested the actual `navigator.onLine` gate.
Later native runs observed the browser offline. After the local-peer JSON repair,
run `37064845388` observed the real browser transition from offline to online,
verified the contained topology, and then timed out during pairing. That run
closed all owned processes and retained an unchanged host-network namespace
identity; it did not complete the upload smoke.

Before navigation or pairing, the controller reads the real strict boolean from
Chromium. Already online skips the helper and adds no network mutation. Only an
actual false calls the helper once. After successful topology verification the
controller waits at most ten seconds, with bounded browser reads, for actual
`navigator.onLine === true`. No spoofed navigator, synthetic online event or
forced supervisor state is used. Real RPC connection and provider byte/digest
assertions remain required by the existing smoke.

The checked private PID1 hands down resolved Python/ip/helper paths and original
host/private net, PID and user namespace identities. The helper additionally
anchors those values to visible PID1's exact `inner` argv. A host PID1, mismatched
identity, foreign link/route, reserved name or unknown baseline refuses before
mutation. Read-only baseline inspections require lo alone and no foreign IPv4
or IPv6 main route. Six literal add-only commands create `bcup-in`/`bcup-peer`,
assign `10.254.231.1/30` and `.2/30`, bring both up and add the sole default through
the same-namespace peer. Postconditions require reciprocal local peer names and unique indices,
unchanged loopback identity, both carrier flags, only expected addresses plus
kernel IPv6 link-local addresses/routes, and the contained default. No host
bridge, namespace transfer, NAT, forwarding, replace, flush or delete operation
exists. Every ip invocation uses the existing joined process-group helper, a
two-second command bound and a twenty-second overall setup deadline.

Partial setup remains owned by existing PID1 namespace teardown. No rollback is
claimed after a timed-out kernel operation. The Node helper call joins its short
Python child, bounded by thirty seconds, and existing namespace cleanup retains
ownership of any descendants during controller shutdown. Host-net inode equality
is a namespace comparison, not a byte-for-byte host routing proof.

Only `networkProof` and `onlineAfterPairFailure` are added to current allowlisted
result/failure JSON: booleans/null, bounded numeric measurements and closed
containment fields. A helper refusal now also records a closed failure-stage enum,
attempted/completed mutation counts, bounded last-command exit/status booleans
and effective CAP_NET_ADMIN as boolean/null. Typed child refusals survive a
nonzero exit; an invalid or missing receipt retains unknown counts rather than
guessing that no mutation occurred. Capability observation grants no capability
and changes no guard or command. No raw command output, MAC/IP/route table, URLs, credentials,
environment values or private logs are added to artifacts. The artifact path
allowlist is unchanged. Workflow tests now include the fake network guard and
browser boolean tests.

The peer verifier uses the documented [upstream same-namespace JSON printer](https://github.com/iproute2/iproute2/blob/v5.15.0/lib/utils.c#L1246):
reciprocal local `link` names must match the two fixed owned peers. Numeric
`link_index` and either foreign-namespace marker are refused. This replaces one
assumed numeric-reference predicate and adds one contradictory-format refusal;
it is not the earlier diagnostic-only claim that all predicates were unchanged.
Positive unique indices, original loopback identity, veth kind, carrier,
addresses/routes, namespace ownership, literal commands and deadlines stay
required. Closed failure stages distinguish index, relation, format, namespace
marker and uniqueness without retaining raw shape values.

The failed run's provenance omitted actual ip/package/image versions. The
maintained Ubuntu 22.04 inventory and Ubuntu source package support the corrected
publisher shape, but do not establish that exact runtime version. The observed
prior receipt completed six commands; it was not a zero-mutation attempt. This
repair subsequently passed the actual online/topology observations described
above. Paired RPC, upload and the remaining live matrix still need verification.

Pairing now records separate credential-issuance, navigation, token-control,
submission and sidebar-wait phases. A failed pairing may retain only a closed
route/readiness category, control-presence/disabled/error booleans and bounded
counts of the existing passive primary-socket observations. It never copies
input values, page/error text, URLs, credentials or cookies, and does not capture
the credential form. Missing diagnostic reads remain unknown; they cannot skip
the existing owned cleanup. The run below supplies native evidence for these observations.

Run `37067543180` then located the timeout at `pair-wait-token`, before any
credential was entered. The document was complete on `/pair`, but the token
control, submit control, pending heading and sidebar were absent. This does not
identify the displayed page or the failure cause. The next diagnostic permits
an original `failure-before-credential.png` only at that exact pre-entry wait,
before any attempted credential entry, and after confirming the owned origin,
empty query/fragment, and absence of token/password/one-time-code inputs. A
failed or partial entry cannot use this exception. The same location/input
guard also applies to the existing post-pair capture. Other pre-pair stages
remain ineligible; no credential-form capture or page-state mutation is added.

Run `37070417123` progressed through pairing, the real connected local rail and
project import, then failed in the first image-attachment scenario. The original
post-pair screenshot shows the connected project and an empty composer. The
earlier missing-pairing-controls condition did not recur; its cause remains
unresolved. The retained error did not yet identify a precise WebDriver code.

The pinned WebdriverIO 9.29.1 source confirms that `setValue` first invokes
`elementClear`. The actual composer file input is intentionally hidden, while
[WebDriver clear requires interactability](https://w3c.github.io/webdriver/#element-clear).
The test now waits for the real enabled state and uses
[the native file Send Keys command](https://w3c.github.io/webdriver/#element-send-keys),
which selects files and fires the ordinary input/change events. The test leaves
the control hidden and respects its disabled state.
Separate upload phases and three closed WebDriver response codes improve any
next failure report without retaining raw paths/messages. Actual image selection
and provider bytes remain to be verified in the next native run.

Local validation uses fake namespace/ip/browser ports, plus the existing owned
supervisor tests. No real namespace, link, route, browser/native UI, installer,
provider or CI run is performed by these new tests. Run:

```sh
python3 -B scripts/qualify-chat-network.test.py
python3 -B scripts/qualify-chat-uploads.test.py
vp test run apps/desktop/e2e/support/browser-network.test.ts apps/desktop/e2e/support/chat-upload-fixture.test.ts apps/desktop/e2e/support/chat-upload-evidence.test.ts
vp exec tsc --noEmit -p apps/desktop/e2e/tsconfig.json
vp check
```

Independent source review is required before dispatch. Actual CI evidence must
record before/after online observations, connected backend RPC, original upload
assertions, safe screenshots and joined namespace cleanup. False staying false
is a bounded diagnostic failure. No actual online transition, native success or
upload qualification is claimed by hermetic tests.

Run `37075649092` at `7a03` stopped before credential entry with the original
startup logo visible. Its document was complete and the contained browser had
become online, but no pairing controls were present. This does not establish
whether application imports were pending, rejected, or followed by a first
render that never committed. A successful HTML response from Vite is not proof
that its dynamic application graph has finished loading.

The QA pre-document observer now retains only fixed boot/load flags, capped
standard-error counts, a fixed dynamic-import failure marker, and completed
resource counts/status classes/bounded durations for predefined module buckets.
It neither requests modules nor modifies the DOM or application state. Resource
completion does not prove evaluation; absent observations remain unknown, and
unsupported or truncated observation is explicit. Raw URLs, error strings,
console data, input values, query fields and credentials are not retained.
Counters describe the current document; a navigation replaces its observer,
so no absence claim about an earlier document follows from a zero count.

The new projection is collected only on the existing `pair-wait-token` failure
before any attempted credential entry, inside the existing two-second read.
Pairing/upload waits, credential ordering, screenshot eligibility, provider
byte/digest assertions and owned cleanup stay unchanged. No warmup, preload,
reload, timeout increase or product startup change is part of this diagnostic.
Run the additional inert callback/projection tests with:

```sh
vp test run apps/desktop/e2e/support/browser-startup.test.ts
```

These observations are prepared for independent review; no new native result or
startup cause is claimed. The next ordinary smoke must still reach an actual
successful upload before the slow-link matrix is expanded.

Run `37080390542` at `913b` reached genuine pairing, project import, real file
selection/preview and provider delivery. The owned provider received exactly
one attachment with matching bytes and digest. Its final staged-path assertion
failed: the 1 KiB fixture has only 1,390 encoded data-URL characters and therefore
stays inline under the product's at-most-256-KiB policy, even on a capable host.
This delivery is not staged-upload qualification, and the absence of a startup
failure in this run does not establish the earlier splash cause.

The plain smoke now generates a real 512 KiB one-pixel PNG (699,074 encoded
characters), named `plain-staged-image-512kib` in its result. It still requires
exact provider bytes/digest and an observed outbound `uploads.begin`; product
thresholds, capability policy, timeout, pairing and cleanup are unchanged. The
fixture test derives actual encoded length and calls the real staging policy,
with a 1 KiB inline control. No new native result is claimed before activation.

The current outbound plain serializer sends one JSON Request string, which the
observer recognizes. Incoming negotiated plain records are binary, which this
observer does not decode; its capability matcher also does not follow the config
snapshot's nested `config.environment` shape. Capability and outstanding-append
observations remain unqualified and cannot prove native concurrency or
backpressure. A separate reviewed decoder slice is needed for that matrix.

Run `37082615063` at `94b9` again stopped at the static splash before credential
entry. It observed one combined script/link resource error, successful entry
transfer, no completed bootstrap/bridge/router/AppRoot resources, and no recorded
JavaScript/rejection/HTTP error. That does not identify the resource or dependency
that failed, establish pending graph work, or diagnose a network transition.

The passive DOM snapshot now associates a failed element with closed resource
kind/type and reads actual `onLine` at capture. A separate explicitly selected
`startup-only` mode uses the pinned classic ChromeDriver performance-log command
to classify bounded `Network.loadingFailed` type/error counts. Raw records,
messages, URLs, headers, IDs and payloads are transient and never artifacts;
unknown/missing/oversized/partial capture remains explicit. The collected network
categories do not identify a dependency by URL or prove that unobserved requests
are pending. No fetch, retry, warmup, timeout or product policy changes are made.

The startup-only workflow is restricted to its separate QA branch/manual trigger.
Its controller never issues a pairing grant, enters a credential, imports a
project or uploads. Both successful and failed probe paths join the same owned
cleanup. Its result says `startup-only`, records separate startup readiness, and
keeps upload `success` false. The existing upload workflow/default capabilities
do not enable performance logging, and its required upload assertions remain.
Classic log retrieval resets the buffer before navigation; this mode ends after
the unauthenticated page observation, so there is no capture-to-login boundary.

Prepared inert validation does not qualify startup or upload natively. Parent
review/activation and the next actual closed evidence are still required.

Startup-only run `37089272748` at `9a3a` retained seven actual
`Network.loadingFailed` events, all classified network-changed (six scripts and
one other), with available/nontruncated/nonmalformed capture. The browser remained
actually online; a TypeError rejection carried the fixed dynamic-import failure
marker and the original boot shell persisted. Ownership/guard/cleanup proofs
passed. This supports changing when the fixture topology is prepared; it does
not justify a wait increase, IPv6/address adjustment or product startup change.

The same contained helper now runs before any owned server, proxy, browser driver
or Chrome is created. Its ownership, baseline, capability, reciprocal link,
address/route predicates and exact ip commands are unchanged. After Chrome
starts, one actual read must return online; no helper, mutation, repair fallback,
sleep or retry runs at that boundary. Both qualification modes use this order.

The existing closed `networkProof` fields remain compatible, but `before` is now
null: browser online state was unobserved before setup because no browser existed.
Preparation has `after:null`; successful browser verification sets actual
`after:true`, while offline/invalid observations retain false/null and fail.
It must not be presented as an observed false-to-true browser transition. The
elapsed proof interval includes preparation and intervening service/browser
startup through that single verification. Setup refusal prevents service/browser
admission, and the existing PID1 owner still tears down the private namespace.

Actual-controller ordering and honest proof controls are inert validation only.
No new native success/cause completion or upload qualification is claimed before
the reviewed next run.

Normal smoke run `37092557926` at `71b7fefd` passed: actual `uploads.begin`,
`append` and `get`, exact 524,288 provider bytes/SHA and original inspected PNG,
with all cleanup/namespace/guard checks passing. The former `maximumAppend:2`
remains unqualified because its inbound decoder missed binary replies. Startup
run `37092190298` reached actual pairing readiness with the boot shell gone,
actual `before:null`/`after:true` and owned cleanup passing. Its network log
reached the 4,096-entry cap: zero classified network failures is partial, not
complete-zero. Neither run establishes the full slow-link matrix.

The next prepared slice replaces the passive text-only observer with a bounded
self-contained installer and strict metadata projection. Plain text and actual
negotiated binary final/continuation/control framing now correlate appends with
same-socket terminal replies. Configuration capability is taken only from the
actual requested config stream's nested snapshot. Transient request IDs are
bounded to 128 characters, maps to 64 entries per socket and lifetimes to 16
sockets; IDs and bodies never enter artifacts. Outgoing inspection permits the
maximum legal 1 MiB raw/1,398,104-character append plus 64 KiB envelope allowance;
incoming assembly caps at 256 KiB/2,048 records. Oversized incoming data is
discarded through final while independent controls remain observable.

Malformed, unsupported, overflow, unknown and partial observations are explicit;
none become a complete measured zero. Reply counts, raw chunk size ranges,
acknowledged offset and reply timing are closed numeric fields. Outstanding
high-water is reported both aggregate and per socket; it is not automatically a
per-file window. Close abandons unanswered appends instead of acknowledging them.
Buffered browser bytes are sampled only at explicit close calls. Noise records
stay opaque and application metrics are unavailable; no key/state injection,
proxy accounting, native Ping/Pong, drip fixture, fault or deadline extension
lands here. Existing smoke/provider requirements and capture eligibility remain.

Actual installer/installed serializer/production codec/privacy tests are inert
proof only. A new reviewed native run is required before these observer values
qualify measurements. Full plain/Noise slow-link, Cancel, retention, remount,
ambiguous admission and fallback scenarios and WebKitGTK remain pending.

Matrix run `37113729253` at `a75b195d` passed the plain 64 KiB/s light delivery:
exact 10 MiB provider bytes/SHA, 423 successful appends, maximum outstanding two,
complete plain/proxy measurements and clean ownership. The Noise 64 KiB/s dark
case failed at the former `matrix-noise-offer` phase before any observed Noise
socket or upload. That phase covered CLI issuance through environment selection;
the closed failure therefore does not identify issuance as its cause.

Diagnostic-only fixed phases now precede the existing CLI, JSON, link, payload,
identity, settings, trigger readiness/click, alias/code fields, acknowledgement,
connect, dialog disappearance and environment selection operations. They retain
only literal operation names, never offer output, credentials, IDs or error text.
The CLI arguments, validation, selectors/actions/order, deadlines and cleanup
are unchanged; no new browser read, grant, retry, screenshot or timing repair is
introduced. Inert actual-controller tests establish failure attribution and the
unchanged successful action trace. Another reviewed native run must supply the
actual failing boundary; a missing dialog-readiness wait remains an unproven
timing hypothesis, not a product or fixture fix.

Run `37123144294` at `a807db33` retained an unsuccessful Noise 64 KiB/s dark
case at `matrix-noise-connect`, before a Noise socket or upload. This narrows the
earlier setup checkpoint to the public submit lookup/click. The safe failure
classification remains unclassified with a null error class; the completed job
log does not expose the private controller exception.

Read-only diagnosis found a deterministic controller defect: the compound
`[role="dialog"] button=Add Server` selector is forwarded unchanged as CSS by
the installed WebdriverIO parser. CSS cannot combine that ancestor with
WebdriverIO's text-selector shorthand. The controller now uses one exact
dialog-scoped XPath for the same public Add Server submit. Other selectors,
actions, order, acknowledgement, payload/host pinning, original budgets,
ownership, capture fences and cleanup remain unchanged.

The regression runs the actual controller setup fragment and installed
WebdriverIO selector parser against the actual ConnectTab pairing-body rendering
with its real Button/Checkbox primitives and inert surrounding ports. It failed
with the former CSS selector and passes with the scoped XPath, one enabled
submit and one activation. Separate rendered controls retain the disabled
pre-acknowledgement and busy states. This is inert compatibility evidence; it
does not execute a native pointer action, XPath engine, handshake or upload.
Native causality remains consistent with the observed boundary, and a reviewed
new native run must establish the repaired Noise outcome before a Noise pass is
claimed. The living test runbooks were reviewed and remain accurate.
