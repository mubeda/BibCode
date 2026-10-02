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
