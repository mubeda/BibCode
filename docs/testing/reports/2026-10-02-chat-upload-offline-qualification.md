# Disposable issue17 Chromium offline diagnosis

This temporary QA branch adds an observation and contained fixture repair to the
existing browser smoke. It changes no production connectivity policy. The
reported paired HTTP/HMR-only run is consistent with the actual
`navigator.onLine` gate, but has not established that browser value.

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
the same-namespace peer. Postconditions require reciprocal veth indices,
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
containment fields. No raw command output, MAC/IP/route table, URLs, credentials,
environment values or private logs are added to artifacts. The artifact path
allowlist is unchanged. Workflow tests now include the fake network guard and
browser boolean tests.

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
