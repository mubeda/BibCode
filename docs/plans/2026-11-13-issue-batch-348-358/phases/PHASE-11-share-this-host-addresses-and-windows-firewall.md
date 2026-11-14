# Phase 11: Share this host lists its addresses, and Windows explains or obtains the firewall rule (#361)

- Goal: While remote access is local-only, the Share this host dialog lists the private addresses it can use, and on Windows a firewall rule that cannot be created without administrator permission is either obtained through an elevation prompt the person approves or explained with a message that names the missing permission, with the server always verified back to local-only on failure.
- Round: 2
- Depends on: none
- Owns: `apps/web/src/components/settings/remote-servers/shareOffer.ts`, `shareOffer.test.ts`, `ShareThisHostTab.tsx` and its tests; `apps/desktop/src-tauri/src/bridge.rs` (the advertised-endpoint functions only), `apps/desktop/src-tauri/src/firewall.rs`, `apps/desktop/src-tauri/src/server_exposure.rs` and their tests; `docs/architecture/remote.md`; `docs/testing/windows-desktop.md` (the firewall and elevation step only)
- Must not touch: `apps/server/**`, `apps/web/src/tauriDesktopBridge.ts` (Phase 4 changed it; read only), `apps/desktop/src-tauri/src/network_interfaces.rs` unless Task 11.2 proves enumeration is at fault
- Skills: mstack-diagnose (the Windows failure is unconfirmed: the error text was never seen); tdd (each change is red first); vercel-react-best-practices (required review of the dialog); better-interface (option labels, the failure message and its retry follow `UI.md`)
- Read first: `sources/issue-361.md` (two independent diagnoses, the static trace, the ranked causes and the list of error strings); `docs/architecture/remote.md` (the documented local-only behavior this phase changes on purpose); `AGENTS.md` (privileged desktop operations cross `DesktopBridge`; process supervision and profiler coverage for any child process; sensitive data: no real addresses or host names in tests); `UI.md`
- Checkpoint: from `apps/web`, `vp test run --project unit src/components/settings/remote-servers` exits 0; `cargo test -p bibcode-desktop -- firewall server_exposure advertised_endpoints` exits 0; `cargo fmt --all --check` and `cargo clippy -p bibcode-desktop --all-targets -- -D warnings` exit 0; `vp check <changed files>` and `vp run typecheck` exit 0.

## Tasks

### Task 11.1: List usable private addresses while local-only

- Satisfies: R52
- Depends on: none
- Files: modify `apps/web/src/components/settings/remote-servers/shareOffer.ts`, `ShareThisHostTab.tsx`, `apps/desktop/src-tauri/src/bridge.rs`; test `shareOffer.test.ts`, the tab's test, and the bridge's endpoint tests; modify `docs/architecture/remote.md`
- Interfaces: consumes `advertised_endpoints_for_config` and `tailscale_advertised_endpoints_for_config` (which return nothing for Tailscale while local-only) and `resolveShareAddressOptions`; produces per-address options for endpoints whose status is `unavailable` only because native exposure is local-only, each labelled as enabling remote access when chosen, and a generate path that widens exposure first for such an option exactly as "Automatic (LAN)" does today
- Skills: tdd (the existing test that expects only Automatic is rewritten on purpose, red first); better-interface (the option text says what choosing it will do)
- Read first: `shareOffer.test.ts` (the case that pins today's behavior); `docs/architecture/remote.md` (the passage that documents it)
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `vp test run --project unit src/components/settings/remote-servers` exits 0, and `cargo test -p bibcode-desktop -- advertised_endpoints` exits 0

Steps

1. [ ] Rewrite the existing case and add new ones in `shareOffer.test.ts`: a local-only native host with a LAN address on the default route (192.168.0.10), an overlay address (10.20.0.5) and a Tailscale address (100.64.0.7), all reported `unavailable`, yields "Automatic (LAN)" plus those three options, each marked as enabling remote access; a public-only host is unchanged (no public option, the existing no-private-address text); an address unavailable for another reason is still left out. Expected: the cases compile and are the ones the next step runs.
2. [ ] Run `vp test run --project unit src/components/settings/remote-servers/shareOffer.test.ts` from `apps/web`. Expected: FAIL, only "Automatic (LAN)" is returned.
3. [ ] Make the desktop report why an address is unavailable (local-only versus another reason) in the smallest way the existing endpoint shape allows, and query Tailscale addresses in local-only mode too; add a failing Rust test first for both. Expected: the Rust tests FAIL before the change and PASS after.
4. [ ] Change `resolveShareAddressOptions` and the generate path: a chosen local-only address widens exposure first, then uses that address; Automatic is unchanged. Expected: the web tests PASS.
5. [ ] Prove the tests can fail: undo this task's change to `shareOffer.ts` by hand and rerun. Expected: FAIL. Restore it. Expected: PASS.
6. [ ] Update the passage in `docs/architecture/remote.md` to the new behavior and run `vp run check:markdown-links`. Expected: exit 0.

### Task 11.2: Find out why generating a code fails on Windows

- Satisfies: R53 (diagnosis)
- Depends on: none
- Files: none in the repository (probe scripts and logs stay in the lab folder)
- Interfaces: consumes the Windows 11 VM and the firewall commands `firewall.rs` runs (`netsh advfirewall firewall show/delete/add rule name="BiBCode Remote Access" … profile=domain,private`); produces a logged verdict with the exact command output, the tier of the cause, and the rule's state afterwards
- Skills: mstack-diagnose (one-variable probe: the same command with and without elevation)
- Read first: `apps/desktop/src-tauri/src/firewall.rs` (the exact arguments, the 5-second deadline and how output becomes the error text); `apps/desktop/src-tauri/src/server_exposure.rs` (the order restart, verify, firewall, persist and the recovery)
- Tier: most capable
- TDD: exempt (a diagnosis whose result is recorded)
- Done when: the plan log holds the verbatim output of the non-elevated `add rule`, whether the same command succeeds elevated, how long it took against the 5-second deadline, the network profile of the default-route adapter, and the confidence tier

Steps

1. [ ] In the VM's interactive session, without elevation, run the same `netsh advfirewall firewall add rule` the app would run, with a probe rule name that the task deletes afterwards. Expected: a refusal whose text names elevation; record it verbatim and the time it took.
2. [ ] Run the same command elevated, if the lab can do so without a person at the screen; otherwise record that the elevated half could not be run. Expected: success, then delete the probe rule and confirm with `show rule` that none is left.
3. [ ] Read the default-route adapter's network profile (`Get-NetConnectionProfile`). Expected: Private, Domain or Public, recorded.
4. [ ] If the packaged app from the current branch is available in the VM, drive Settings, Remote servers, Share this host, Another device, Generate pairing offer through the packaged e2e harness and record the dialog's error text and the listener address afterwards (`Get-NetTCPConnection -State Listen`), never the code. Expected: the text matches one of the strings the issue lists; the listener is loopback-only again.
5. [ ] Log the verdict: which ranked cause the evidence supports, and its tier (Confirmed only if the with-and-without-elevation probe flipped the outcome).

### Task 11.3: On Windows, obtain the firewall rule with an elevation prompt, or say exactly what is missing

- Satisfies: R53, R54
- Depends on: 11.2
- Files: modify `apps/desktop/src-tauri/src/firewall.rs`, `apps/desktop/src-tauri/src/server_exposure.rs`, `apps/web/src/components/settings/remote-servers/shareOffer.ts`, `ShareThisHostTab.tsx`; test their test modules; modify `docs/architecture/remote.md` and `docs/testing/windows-desktop.md`
- Interfaces: consumes the firewall runner and its test stub (which already stubs "Access is denied."); produces a classified firewall failure `ElevationRequired` distinct from other failures, an elevated retry of the same rule change that Windows asks the person to approve, and a dialog message that names administrator permission and the firewall step and offers Retry
- Skills: tdd (red first with a runner that returns the output recorded in Task 11.2); better-interface (the message says what failed, why, and what to do next); bibcode-profiler (a child process started for elevation is reported and attributed as AGENTS.md requires)
- Read first: the verdict of Task 11.2 in the plan log; `AGENTS.md` sections on trust boundaries and on child processes
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-desktop -- firewall server_exposure` exits 0 and, from `apps/web`, `vp test run --project unit src/components/settings/remote-servers` exits 0

Steps

1. [ ] If Task 11.2 did not confirm the elevation cause, stop: log the actual cause and write the fix for that cause as a new task; do not build the elevation path on an unconfirmed premise. Expected: either the cause is confirmed and the task goes on, or a Ruling is logged.
2. [ ] Write failing Rust tests with a runner that returns the recorded elevation-required output: the failure is classified `ElevationRequired`; the exposure switch then tries the elevated path once; when that path reports a refusal (the person declined), the server is verified local-only, no rule is left, and the error carries a fixed reason token, not the raw command output. Expected: FAIL.
3. [ ] Implement the classification and the elevated retry: the same rule change run through Windows' own elevation prompt for that one command, bounded by a deadline long enough for a person to answer, started through the supervised process path. Nothing runs elevated except that one firewall command. Expected: the Rust tests PASS.
4. [ ] Write the failing web test and then the message: when the reason is the missing permission, the dialog says that Windows needs administrator permission to open the firewall for BiBCode, that nothing was changed, and offers Retry; a string rejection from the bridge keeps a sanitized reason instead of the generic "Could not enable remote access."; when the adapter's network profile is Public, a warning says other devices may still be blocked. Expected: FAIL, then PASS.
5. [ ] Prove the tests can fail: undo the classification by hand and rerun. Expected: FAIL. Restore it. Expected: PASS.
6. [ ] Update `docs/architecture/remote.md` and the firewall step of `docs/testing/windows-desktop.md`; run the phase Checkpoint. Expected: exit 0.

### Task 11.4: BiBCode no longer manages Tailscale Serve

- Satisfies: R55
- Depends on: 11.3
- Files: modify `apps/web/src/components/settings/remote-servers/ShareTab.tsx` and its tests; modify the desktop bridge and `apps/desktop/src-tauri/src/tailscale.rs` where they configure Tailscale Serve, with their tests; modify the contracts that carry those commands; modify `docs/user/remote-access.md` and `docs/architecture/remote.md`
- Interfaces: consumes the read-only Tailscale address read built in Task 11.1; produces a Share this host section with no "Tailscale HTTPS" row and no code path that runs a `tailscale serve` change
- Skills: tdd (a test that the command runner never receives a Tailscale Serve change); better-interface (the section reads well without the row)
- Read first: `docs/user/remote-access.md` (what it tells people about Tailscale today); the bridge commands that set up and disable Serve and every caller of them
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `vp test run --project unit src/components/settings/remote-servers` exits 0, `cargo test -p bibcode-desktop` exits 0, and `rg -n "Tailscale HTTPS" apps/web/src/components/settings/remote-servers/ShareTab.tsx` prints nothing

Steps

1. [ ] List every caller of the Serve setup and disable commands and every stored setting that remembers BiBCode enabled Serve. Expected: the list is in the task's first commit message.
2. [ ] Write the failing tests: the section renders no "Tailscale HTTPS" row and no Serve switch; the runner never receives a `tailscale serve` change; an HTTPS address that a person set up in Tailscale themselves and that answers BiBCode's well-known endpoint is still listed. Expected: the first two FAIL on current code.
3. [ ] Remove the row, its actions, the bridge commands and the Rust code that change Tailscale Serve; keep the read-only reads. A stored preference from an earlier version is ignored without failing to load settings, and Tailscale's own state is left untouched on upgrade. Expected: the tests PASS.
4. [ ] Prove the tests can fail: restore the row by hand and rerun. Expected: FAIL. Remove it again. Expected: PASS.
5. [ ] Update the two docs so they say that BiBCode reads Tailscale's addresses and does not manage Tailscale; run `vp run check:markdown-links`. Expected: exit 0.
6. [ ] Run the phase Checkpoint. Expected: exit 0.
