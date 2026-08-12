## Desktop Runtime Measurement: linux-webkitgtk-resource-attribution

| Metric                                  | Value                                |
| --------------------------------------- | ------------------------------------ |
| Label                                   | linux-webkitgtk-resource-attribution |
| Sampled at                              | 2026-08-12T13:57:51.725Z             |
| Root PID                                | 69860                                |
| Startup readiness                       | 0.00 s                               |
| Window readiness                        | not captured                         |
| Idle delay                              | 30.00 s                              |
| Process count                           | 3                                    |
| Total private bytes (RSS approximation) | 714.6 MiB                            |
| Total working set                       | 714.6 MiB                            |

### Top Processes

| PID   | Name            | RSS (approx.) | Working Set | Command                                                 |
| ----- | --------------- | ------------- | ----------- | ------------------------------------------------------- |
| 69970 | WebKitWebProces | 457.4 MiB     | 457.4 MiB   | `././/libexec/webkit2gtk-4.1/WebKitWebProcess 4 21`     |
| 69860 | bibcode-desktop | 196.8 MiB     | 196.8 MiB   | `bibcode-desktop`                                       |
| 69945 | WebKitNetworkPr | 60.3 MiB      | 60.3 MiB    | `././/libexec/webkit2gtk-4.1/WebKitNetworkProcess 1 16` |

## WebKitGTK ownership topology

The packaged artifact was `BiBCode_0.3.11_amd64.AppImage`. The supported publisher
completed with `NO_STRIP=1` because the pinned linuxdeploy `strip` rejects Fedora
`.relr.dyn` sections; this packaging environment workaround required no source edit.
Accessibility was enabled only to control the UI and was not used to infer process
ownership. Every topology result below came from Linux `ps` and `/proc`.

| Observation                             |   PID |  PPID | Start ticks | Executable basename    |
| --------------------------------------- | ----: | ----: | ----------: | ---------------------- |
| Main WebView network helper             | 69945 | 69860 |      514327 | `WebKitNetworkProcess` |
| Main WebView content helper             | 69970 | 69860 |      514337 | `WebKitWebProcess`     |
| Preview network helper                  | 70802 | 69860 |      522254 | `WebKitNetworkProcess` |
| Preview content helper after navigation | 71587 | 69860 |      537187 | `WebKitWebProcess`     |

Host PID 69860 was the combined BiBCode desktop host/server. The native right-panel
Browser created its own network helper, and navigating it to the local CUPS page at
`127.0.0.1:631` created its own content helper. All four helpers were immediate
children of PID 69860. For each helper, the parent from `/proc/<pid>/stat` matched
the host PID, the start ticks were positive, and `/proc/<pid>/exe` resolved to an
executable whose basename exactly matched the command role shown above.

No `WebKitGPUProcess` was instantiated during this X11 software-rendered capture.
No WebKit helper role outside the approved `WebKitWebProcess`,
`WebKitNetworkProcess`, and `WebKitGPUProcess` allowlist appeared.

After closing the Preview tab, all four helpers remained alive with the same PID,
PPID, start ticks, and executable basename. Retention is permitted by the design;
none moved under an unrelated parent. Closing BiBCode normally through the window
manager then removed host PID 69860, AppImage launcher PID 69864, and helper PIDs
69945, 69970, 70802, and 71587; the cleanup `ps` command printed no rows.

The approved direct-parent design is confirmed for both the main and Preview
WebViews in this packaged Linux run.
