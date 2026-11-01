## Remote load on a 3G link, 2026-11-01

The baseline that the shell cap (#223), the thread history window (#226) and the small load
fixes (#227) measure their gain against. Captured with `scripts/measure-remote-latency.ts
--link 3g` on Windows 11 x64: a debug `bibcode serve` started on the large-thread fixture, the
web build served locally, headless Microsoft Edge 156, and only server traffic through
`scripts/throttle-proxy.ts` with the `3g` preset (50,000 bytes/s each way, a 400 ms round trip)
and its new-connection option. The code is v0.14.0 (`9c8799b80`) plus the measurement tooling of
issue #225; no payload was changed. Raw data, including the RPC counts per method:
[remote-load-3g-20261101.json](remote-load-3g-20261101.json).

The fixture is `apps/server/tests/support/load_fixture.rs`, written into the store before the
link slows down: one thread of 200 turns (400 messages, about 2,200 tool activities with details
up to 16 KiB, 10 proposed plans, a checkpoint that touches 2,400 files) and a shell of 160
non-archived threads in six projects, most of them finished, with chat panels. Every row is the
page's WebSocket traffic from the action until the link has been quiet for two seconds. "Received"
is the WebSocket payload after the transport's deflate; "decoded" is the JSON it inflates to.
TCP, TLS and WebSocket framing are not counted, and the web bundle is served locally, so these
rows count RPC bytes, not bundle bytes. Two runs, one row each; sizes of the two cold rows agree
within 0.5%.

### Load scenarios, 3G

| Action                                                |  RPCs | Sequential | Sent (KB) |   Received (KB) |    Decoded (KB) | Time to visible |
| ----------------------------------------------------- | ----: | ---------: | --------: | --------------: | --------------: | --------------: |
| Cold connect: reload onto the big thread's route      |    58 |        1–2 |      36.6 | 2127.8 / 2128.2 | 6655.2 / 6655.6 |   46.9 / 46.4 s |
| Open the big thread from the sidebar, no local cache  |    58 |          3 |      37.4 | 2137.7 / 2137.1 | 6665.1 / 6664.5 |   48.7 / 48.7 s |
| Switch back to the big thread (page already holds it) | 11–13 |        0–1 |  5.8–19.0 |    25.0 / 117.5 |    25.0 / 117.5 |     3.1 / 0.9 s |
| Reconnect: dropped socket until the thread resynced   |    55 |          1 |      31.7 |   195.5 / 187.6 |   415.7 / 407.8 |     6.6 / 4.5 s |

Run 1 / run 2 where two numbers are shown. "Sequential" is the longest chain of requests each sent
right after a reply to the previous one, inferred from timing. The two cold rows are decided by
bandwidth: 2.1 MB at 50,000 bytes/s is 43 s before any round trip. The switch and reconnect rows
vary between runs (the switch row by 5x in bytes, not explained here); compare them as ranges.

### Per-payload sizes (the CI byte budget)

`cargo test -p bibcode-server --test transfer_budget` serves the same fixture over a real `/ws` to
a client that offers compression and measures the first item of each stream:

| Payload                                  | After deflate (B) | Decoded (B) |
| ---------------------------------------- | ----------------: | ----------: |
| Shell snapshot (`subscribeShell`)        |            37,959 |     246,121 |
| Big thread, first `subscribeThread` item |         1,893,549 |   6,304,157 |
| Big thread, resume answer (`unchanged`)  |               134 |         134 |

The budgets in `apps/server/tests/transfer_budget.json` are these sizes plus about 3–5%
(40,000 / 255,000, 1,950,000 / 6,500,000 and 256 / 256 bytes). The thread snapshot is 89% of the
cold open: the rest of the 2.1 MB is the shell, the archived-shell snapshot and the other 50-odd requests
(58 in all). The synthetic text deflates 3.3 times; real threads may compress differently, so
compare builds against each other, not against T3 Code's figures.
