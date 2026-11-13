# #353 Follow-ups from the #349 validation rounds

Small follow-ups found while validating #349, none blocking:

- Host dashboard on Linux: a second BiBCode AppImage mount (another running instance, or a stale FUSE mount left by a killed one) is shown as a full read-only volume. The app hides only its own image.
- Packaged e2e harness: after a web process crash the dead-webview probe runs once per worker, so the remaining shared specs still fail; one relaunch then hit a script timeout.
- Terminal re-attach: a transient size change of about three rows was seen right after a re-attach (85x30 to 85x33 and back). Candidates: the attach claim measuring the mount before fonts or the Activity dock settle. Instrument the trigger, mount size, fitted size and the PTY resize.
- "Fit to this window" gives no feedback when no size request can be sent (a request in flight, declined or awaiting its acknowledgement).
- The Host dashboard sheet re-renders once a second while open; memoize the values view if it shows in a profile.
- Mixed versions: terminal resize, attach and keybindings were not run against a real older server build (covered by contract tests and test doubles only).
- Linux packaged run: main-thread stalls up to 2.7 s on the settings to thread route change and WebKitWebProcess memory growing to about 1.0 to 1.26 GiB over a full run, both present before #349 (seen with the Profiler on under software rendering).
- xterm.js 6.0.0 counts emoji as one column (Unicode 6 widths) while programs such as the Claude CLI assume modern widths; loading the unicode11 or graphemes addon is also a prerequisite for a server-side screen.


