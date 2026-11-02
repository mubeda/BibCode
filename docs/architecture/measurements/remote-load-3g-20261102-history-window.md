## Remote load on a 3G link after #226, 2026-11-02

What issue #226 (the thread history window) changed against the
[#227 capture](remote-load-3g-20261102.md). The app now opens a thread with a window of recent
history and loads older history in pages as the reader scrolls up. Captured the same way:
Windows 11 x64, a debug `bibcode serve` built with `cargo build -p bibcode-server --bin bibcode`,
and the large-thread fixture. Raw data, including the RPC counts per method:
[remote-load-3g-20261102-history-window.json](remote-load-3g-20261102-history-window.json).

### Per-payload sizes (the CI byte budget)

`cargo test -p bibcode-server --test transfer_budget`. The "window" row is new: the big thread's
first `subscribeThread` item for a client that sends `history: {}`, as the app does. The
"thread" row is unchanged: an older client, which asks for the whole thread, still gets it.

| Payload                                          | After deflate (B) | Decoded (B) |
| ------------------------------------------------ | ----------------: | ----------: |
| Shell snapshot (`subscribeShell`)                |            37,959 |     246,121 |
| Big thread, whole (`subscribeThread`, no window) |         1,865,484 |   6,127,353 |
| Big thread, history window (#226)                |            97,077 |     342,776 |
| Big thread, resume answer (`unchanged`)          |               134 |         134 |

The window is 19 times smaller after deflate and 18 times smaller decoded. On the fixture the
10-turn limit binds before the 1 MiB byte budget: the window holds the last 10 turns and the
turn index (every checkpoint, file lists only for the window's turns). The new `window` budget
in `apps/server/tests/transfer_budget.json` is the measured size plus 3%: 100,000 bytes after
deflate and 353,000 decoded.

### Load scenarios, 3G

Received / decoded KB per run (KiB of WebSocket payload). "Before" is the #227 capture (two
runs) for the cold and cached rows and the [#225 baseline](remote-load-3g-20261101.md) for the
switch and reconnect rows, which the #227 capture did not report. "After" is three runs of this
build, run 1 / run 2 / run 3.

| Action                                                  | Before received (decoded)         | After received (decoded)                      | After time to visible |
| ------------------------------------------------------- | --------------------------------- | --------------------------------------------- | --------------------- |
| Cold connect: reload onto the big thread's route        | 1991.1 / 2038.2 (6372.1 / 6419.2) | 350.1 / 344.2 / 228.2 (809.1 / 803.2 / 687.2) | 9.0 / 5.9 / 5.5 s     |
| Open the big thread from the sidebar, no local cache    | 2119.3 / 2117.4 (6500.3 / 6498.4) | 321.2 / 347.3 / 254.0 (780.3 / 806.3 / 713.0) | 8.8 / 9.9 / 14.3 s    |
| Switch back to the big thread                           | 113.4 / 25.3                      | 115.1 / 16.0 / 136.1                          | 0.1 / 0.9 / 0.8 s     |
| Reconnect: dropped socket until the big thread resynced | 141.5 / 211.0 (361.7 / 431.2)     | 200.4 / 49.4 / 184.3 (419.5 / 268.5 / 403.4)  | 4.6 / 47.3 / 4.8 s    |
| Reload onto the big thread's route, thread cached       | 199.0 / 45.9 (418.1 / 264.9)      | 198.1 / 21.7 / 1.6 (417.2 / 21.7 / 1.6)       | 2.2 / 7.0 / 52.2 s    |

The two cold rows are where the window shows. Before, they were decided by bandwidth: about
2 MB at 50,000 bytes/s, 45–50 s to visible. They now receive 230–350 KB, 6 to 9 times less,
and the big thread paints in 5.5–9.9 s (one sidebar run 14.3 s). The rest of each cold row is the
shell and the other subscriptions: the big thread's own first item is 97 KB after deflate (see
the byte budget above). The switch row is unchanged in kind.

Two runs have a row this build does not explain. In run 2 the reconnect row took 47.3 s with 25
RPCs (55 in the other runs), and in run 3 the cached reload saw no RPC at all for 52 s. Both rows
end on the harness's own wait, with the page sending little or nothing in the window, and the
other runs of the same rows took 2.2–4.8 s. The baseline already notes the reconnect row varies
between runs. Time at 3G is reported, never gated.
