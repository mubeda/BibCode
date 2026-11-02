## Remote load on a 3G link after #227, 2026-11-02

What issue #227 changed against the [2026-11-01 baseline](remote-load-3g-20261101.md). The
change has three parts. The thread cache keeps the server's revision, so a reload resumes a
cached thread. The thread stream sends only the first 200 files of each checkpoint, plus
`filesTotal`. Static files are gzip-compressed. Captured the same way as the baseline:
`scripts/measure-remote-latency.ts --link 3g` on Windows 11 x64, a debug `bibcode serve` built
with `cargo build -p bibcode-server --bin bibcode`, headless Microsoft Edge 156, and the
large-thread fixture. The code is #227 on #225's branch (`a17705cc6`). Raw data:
[remote-load-3g-20261102.json](remote-load-3g-20261102.json).

The harness gained a fifth row. It reloads onto the big thread's route while the page's cache
still holds the thread, 2 s after the reconnect row. Before #227 that reload received the whole
thread again. Its "before" column comes from the same server with a web build of the client
from before #227, so only the client's cache differs.

### Load scenarios, 3G

Received / decoded KB per run (KiB of WebSocket payload, as in the baseline). Before is the
baseline's two runs; after is two runs of this build.

| Action                                               | Before received (decoded)         | After received (decoded)          | After RPCs | After time to visible |
| ---------------------------------------------------- | --------------------------------- | --------------------------------- | ---------: | --------------------: |
| Cold connect: reload onto the big thread's route     | 2110.4 / 2120.1 (6637.9 / 6647.5) | 1991.1 / 2038.2 (6372.1 / 6419.2) |    53 / 56 |         46.2 / 45.5 s |
| Open the big thread from the sidebar, no local cache | 2127.4 / 2142.6 (6654.8 / 6670.0) | 2119.3 / 2117.4 (6500.3 / 6498.4) |    58 / 58 |         49.7 / 48.0 s |
| Reload onto the big thread's route, thread cached    | 1982.0 (6381.3), one run, 57 RPCs | 199.0 / 45.9 (418.1 / 264.9)      |    60 / 23 |           7.9 / 9.1 s |

The two cold rows still clear the page's cache first, so the resume cannot help them. They
gain only from the checkpoint cap: decoded bytes fall by about 160–260 KB (2–4%). The received
bytes fall by up to 6% on the cold row and about 1% on the sidebar row, which is within the
spread between runs. The cached reload is where the resume shows. Instead of about 2 MB it
receives 46–199 KB, and the big thread's own subscription is answered `unchanged`. The rest is
the shell and the other subscriptions. The two after runs differ by the requests still in
flight from the reconnect row. Its time to visible was 5.4 s before and 7.9 / 9.1 s after. The
page paints from its cache in both cases, so the time is not a gain, and the difference is not
explained by these runs (one before run, two after). Time at 3G is reported, never gated.

### Per-payload sizes (the CI byte budget)

`cargo test -p bibcode-server --test transfer_budget`:

| Payload                                  | Before after deflate (B) | After after deflate (B) | Before decoded (B) | After decoded (B) |
| ---------------------------------------- | -----------------------: | ----------------------: | -----------------: | ----------------: |
| Shell snapshot (`subscribeShell`)        |                   37,959 |                  37,962 |            246,121 |           246,121 |
| Big thread, first `subscribeThread` item |                1,893,549 |               1,865,481 |          6,304,157 |         6,127,353 |
| Big thread, resume answer (`unchanged`)  |                      134 |                     134 |                134 |               134 |

The thread budget in `apps/server/tests/transfer_budget.json` is lowered to the new size plus
3%: 1,920,000 bytes after deflate and 6,310,000 decoded. The shell and resume budgets are
unchanged.

### Web build over HTTP

The harness serves the web build locally, so none of the rows above count it. Measured
separately with `gzip -6` on `apps/web/dist`, which is what the server now sends to a browser
that accepts gzip: the entry document and the scripts and styles it loads shrink from 1,208,594
to 329,256 bytes (3.7 times smaller, about 24 s to 7 s at 50,000 bytes/s). The whole build,
lazy chunks included, shrinks from 19.9 MB to 5.0 MB. Content-hashed files stay cached as
immutable, so a browser pays this once per update.
