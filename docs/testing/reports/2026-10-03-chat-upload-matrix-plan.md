# First staged chat upload browser matrix

Prepared implementation, not native execution evidence. This checkout started at
c56ce300a704054f86da194fd14c13be7217e971; parent observed its512KiB smoke at
37100448442 with exact provider bytes/digest, maximum two outstanding appends and
joined cleanup. That result does not qualify the new cases.

The fixed covering set is in
`apps/desktop/e2e/support/chat-upload-matrix-cases.json`. It intentionally avoids
a full Cartesian product. One case runs in each private namespace/browser owner.
The four delivery cases cover both transports at64/16KiB/s, with light/dark
represented for each transport. Each transport additionally has freeze/resume,
pointer/Tab+Enter/Tab+Space Cancel, and concurrent streaming/Stop coverage.

| Case                          | Transport    | Upstream | Theme | Behavior                  |
| ----------------------------- | ------------ | -------- | ----- | ------------------------- |
| plain-64-light-delivery       | plain        | 64KiB/s  | light | 10MiB exact delivery      |
| plain-16-dark-delivery        | plain        | 16KiB/s  | dark  | 10MiB exact delivery      |
| noise-64-dark-delivery        | pinned Noise | 64KiB/s  | dark  | 10MiB exact delivery      |
| noise-16-light-delivery       | pinned Noise | 16KiB/s  | light | 10MiB exact delivery      |
| plain-64-dark-freeze          | plain        | 64KiB/s  | dark  | 4408/reconnect/thaw       |
| noise-64-light-freeze         | pinned Noise | 64KiB/s  | light | 4408/reconnect/thaw       |
| plain-16-light-cancel-pointer | plain        | 16KiB/s  | light | pointer Cancel            |
| plain-16-dark-cancel-enter    | plain        | 16KiB/s  | dark  | Tab+Enter Cancel          |
| plain-64-light-cancel-space   | plain        | 64KiB/s  | light | Tab+Space Cancel          |
| noise-16-dark-cancel-pointer  | pinned Noise | 16KiB/s  | dark  | pointer Cancel            |
| noise-16-light-cancel-enter   | pinned Noise | 16KiB/s  | light | Tab+Enter Cancel          |
| noise-64-dark-cancel-space    | pinned Noise | 64KiB/s  | dark  | Tab+Space Cancel          |
| plain-64-dark-stop            | plain        | 64KiB/s  | dark  | stream/Stop/queued upload |
| noise-64-light-stop           | pinned Noise | 64KiB/s  | light | stream/Stop/queued upload |

Python and TypeScript consume this same manifest. `upload-matrix` is explicit;
invalid cases refuse before program/namespace admission. Default smoke/startup
remain600/660seconds. Selected cases use fixed1800/1860seconds because10MiB
base64 alone takes about853seconds at16KiB/s. The original PID1 argument vector,
network-before-browser topology, private HOME, guarded fake providers and joined
cleanup remain authoritative.

The short private root pattern is adapted from approved UI325500ea: UUID only
under `/tmp/bibcode-upload-`, exclusive0700creation, with run ID kept in evidence.
No UI controller, selector, shared browser owner or updater source was copied.
The source adaptation receipt and before/after ledger remain with the review
packet outside the checkout.

The browser uses public General theme controls, genuine Add Server pairing,
actual verified host-key-bearing Noise offer and the owned bidirectional TCP
forwarder. It imports the owned project through the public folder UI. A real
valid10MiB PNG goes through the actual file input; no profile, outbox, registry or
capability is injected into the renderer. Captures use real pointer/keyboard
commands. Read-only DOM observations retain booleans and displayed tenths ofMiB,
not raw text, URLs or identifiers. Those display values are rounded UI evidence,
not exact acknowledged byte measurements. Exact bytes/digest come independently
from the target protocol fake provider.

Freeze records the actual native client close call4408 in the document clock,
requires elapsed≤33seconds and visible Reconnecting, then thaws and verifies
monotonic progress and exact delivery. It does not claim the frozen server
received that close frame. The passive observer adds only transport close
metadata/timestamps for Noise; no encrypted application records are parsed.
Noise append/window/capability/Pong counters remain unavailable. Proxy metadata
retains its complete/null semantics; nativeWS/RPC control attribution remains
not-observed.

Cancel is one actual pointer/Enter/Space activation. It requires outgoing plus
newer composer work and usable image preview to return without an error; no
provider input may be admitted. Plain RPC cancel count is independently checked;
Noise RPC count stays unavailable. Stream/Stop uses the actual generated Codex
fixture's explicit `chat-matrix` drip opt-in and prompt marker. A one-second
interval emits at most900deltas and clears on completion, interruption, shutdown
and stdin close. Defaults remain one delta. Stop is the public generation button
while the queued attachment upload continues advancing.

The workflow targets only `codex/qualify-chat-matrix`, one case per job with at
most two jobs concurrently. Exact JSON/PNG names are allowlisted; no raw logs,
credentials, offers, payloads, profiles, IDs or wildcard captures are uploaded.
Noise pairing controls make screenshots ineligible until the dialog closes.
OriginalPNG state captures and closed receipts require independent review and
actual native activation; inert tests are not visual or native proof.

Every result keeps `fullMatrixComplete:false`. Real completed-stage retention
beyond600seconds, genuine pre-staging server fallback,8×10MiBbatch, remaining
admission/remount/ambiguous-replay cases and native heartbeat header attribution
remain separate next cases. WebKitGTK is not measured, and Chromium does not
qualify Tauri/WebKitGTK, Windows/macOS input behavior or final integrated release
source.
