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

## Post-change Resource Manager acceptance

The accepted artifact was `BiBCode_0.3.11_amd64.AppImage` (120,576,504 bytes),
the only AppImage in `release/desktop/linux-x64`. The package manager reported
`webkit2gtk4.1-2.52.5-1.fc44.x86_64`. The exact packaging command reached the
previously diagnosed pinned-linuxdeploy strip failure on this Fedora host. The
single permitted fallback, `NO_STRIP=1 vp run dist:desktop:linux`, completed the
same repository publisher and produced the fresh artifact without a source
change.

The acceptance launch used an isolated `BIBCODE_HOME` and isolated XDG client
state. The main WebView produced one `WebKitNetworkProcess` and one
`WebKitWebProcess`, each an immediate child of the combined host/server. Their
`/proc` parent, positive start ticks, and resolved executable basenames matched
the snapshot hints. Across three settled Resource Manager samples, Combined and
Core reconciled exactly at 806.1/805.9/804.5 MB, 3.3/7.7/5.6% CPU, and 3
processes; External remained 0 B, 0.0%, and 0 processes.

Opening Preview added one `WebKitNetworkProcess`; navigating it to the local
CUPS page added one `WebKitWebProcess`. Both were immediate host children with
stable `/proc` identities and exact executable basenames. Two settled samples
showed Combined and Core equal at 1.4 GB, 25.0% then 9.0% CPU, and 5 processes,
with External still 0 B, 0.0%, and 0 processes. Every host/helper identity
appeared once. Closing Preview retained all four helpers with unchanged parent,
start identity, and role; permitted shared-helper retention remained attributable
and produced neither duplication nor an unrelated-parent claim.

The accepted Resource Manager visual showed `core/server` and four exact
`core/ui` rows (two Web, two Network), UI coverage available, and no WebKit row
labeled `external`, `unknown`, or `fallback`. With a terminal open, the visual
and two semantic samples showed 6 Combined processes = 5 Core + 1 External;
the terminal shell remained External. The corresponding totals reconciled, with
External at 5.9 MB and 0.0% CPU in both samples. No `WebKitGPUProcess` appeared
on this X11 software-rendered host.

A provider session could not be started through this host's semantic UI because
the WebKitGTK accessibility entry exposed no editable-text interface; that
manual provider exclusion case was not run. No genuine second WebKitGTK
application was installed, so the cross-application manual exclusion case was
also not run. No process-name substitute was used. The focused observer test
command passed all eight matching tests for unknown roles, changed identities,
PID reuse, role mismatch, and process-record/executable failures, providing the
required fail-closed evidence without a production fault hook.

Normal PID-scoped window-manager close removed the host, all four recorded
WebKit helpers, and the terminal. The prescribed host/direct-child cleanup
commands and the explicit recorded-PID check printed no rows after shutdown.
No acceptance-owned process remained.

Commands used for the bounded checks were:

```text
vp run dist:desktop:linux
NO_STRIP=1 vp run dist:desktop:linux
find release/desktop/linux-x64 -maxdepth 1 -type f -name '*.AppImage' -print
rpm -qa
ps -p <host-pid> -o pid=,ppid=,lstart=,comm=,args=
ps --ppid <host-pid> -o pid=,ppid=,lstart=,comm=,args=
sed -E 's/^[0-9]+ \(.*\) //' /proc/<pid>/stat
readlink /proc/<pid>/exe
cargo test -p bibcode-desktop linux_ui_rejects -- --nocapture
```

AT-SPI was used only for semantic UI interaction and bounded Resource Manager
text capture. Linux `ps` and `/proc` remained the process-identity source of
truth. The supplemental visual was not added to source control.
