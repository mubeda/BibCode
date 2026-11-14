# #361 Remote access: Share this host hides LAN/VPN addresses while local-only, and generating a code fails on Windows

<!-- Proposed title: Remote access: Share this host hides LAN/VPN addresses while local-only, and generating a code fails on Windows -->
<!-- Alternative (both diagnoses' title): Remote access: Windows share-as-server lists no addresses and code generation fails -->
<!-- Proposed labels: bug, needs-triage, size:M -->

## Problem

(measured: owner report, 2026-11-13, BiBCode desktop v0.15.3, Windows 11) In **Settings → Remote servers → Share this host → Another device**, the **Address** combo offers only **"Automatic (LAN)"**. None of the machine's addresses (LAN, NetBird, Tailscale) are listed. Clicking **Generate pairing offer** with "Automatic (LAN)" selected fails with an error. The exact error text is not known yet; a screenshot is pending.

(measured: read-only OS probes on the reporting machine) Three IPv4 interfaces are up, each with a preferred private address: Ethernet (LAN, default route), `wt0` (WireGuard, NetBird) and `Tailscale`. The running desktop app listens on `127.0.0.1:3773` only, so native remote access is **local-only** when the dialog opens.

Two independent static diagnoses ran on the same machine, one with Codex and one with Claude Code. Neither saw the other's output, and both used the mstack-diagnose method. Their findings are merged here. Points both reached are the main explanation, and points where they differ are listed under **Open questions**.

(inferred; both agree) There are two separate defects:

1. **Empty address list: by design on every OS, and the design fails the user.** While local-only, the desktop marks every off-host address `unavailable`, and the share dialog drops `unavailable` endpoints. Only "Automatic (LAN)" survives. Addresses can appear only after remote access is on, but the user turns it on from this same dialog. Windows address enumeration is **not** at fault.
2. **Code generation fails while widening to network-accessible. The leading Windows-only candidate is the Windows Firewall step.** "Automatic (LAN)" first switches the server to network-accessible. On Windows that switch runs `netsh advfirewall firewall … add rule`, and nothing in the path requests elevation or handles a refusal. On failure, the desktop restores local-only and the dialog shows the error. This is unconfirmed until the error text is seen.

## Triage proposal (mstack-backlog-triage)

- (inferred; both agree) Type: **bug**. Priority: **P1/high**: native "Share this host → Another device" does not work on this Windows setup, and the dialog does not show which addresses it will use.
- (inferred; both agree) Size: **M**. Part 1 is a small web/bridge change plus updating the test that encodes the current behavior. Part 2 needs a firewall/elevation design decision and native Windows validation.
- (inferred; both agree) Labels: **bug, needs-triage, size:M**.
- (inferred; agent's call; the two diagnoses differ, see Open questions) Release view: **not a blocker by itself**. It is not a regression: the code is identical in v0.15.0, v0.15.2 and v0.15.3. **Re-evaluate once the screenshot is available.** If it shows that ordinary non-elevated Windows sharing always fails, treat it as a blocker for the next release.
- (inferred) Diagnosis gate: part 1's mechanism is traced end to end from source and matches the OS facts. No outcome flip has been run. Part 2's cause is unconfirmed.

## Expected vs Actual

| Surface                | Expected                                                                                                                                                                                                 | Actual                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Address combo          | (inferred) While local-only, list "Automatic (LAN)" plus each usable private IPv4 the desktop observed (LAN 192.168.x.x, NetBird 10.x.x.x, Tailscale 100.x.x.x), each marked "will enable remote access" | (measured: owner) Only "Automatic (LAN)"                                                                                             |
| Generate pairing offer | (inferred) Enable remote access, get the firewall rule (asking for elevation if needed), and show a code, or show an actionable message naming the failed prerequisite                                   | (measured: owner) An error; text pending                                                                                             |
| Safety                 | (inferred) On failure, the server is verified back to local-only, with no stray rule or wide listener                                                                                                    | (measured: source) Recovery logic exists. (measured: probe) The listener is currently loopback-only. Not exercised by this diagnosis |

## Environment and evidence (read-only OS probes)

| Observation                 | Evidence                                                                                                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version / OS                | (measured: owner) BiBCode desktop v0.15.3, Windows 11 (virtual machine, VirtIO NIC). (measured) The running binary's version was not independently inspected.                                                                                                                       |
| Adapters (`Get-NetAdapter`) | (measured; both) `Ethernet`: Red Hat VirtIO Ethernet Adapter, InterfaceType 6, Up. `wt0`: "WireGuard Tunnel", InterfaceType 53, Up. `Tailscale`: "Tailscale Tunnel", InterfaceType 53, Up.                                                                                          |
| IPv4 (`Get-NetIPAddress`)   | (measured; both) Ethernet 192.168.x.x/24 (DHCP, Preferred); Tailscale 100.x.x.101/32 (CGNAT, Manual, Preferred); wt0 10.x.x.x/24 (RFC 1918, Manual, Preferred). No APIPA. IPv6, including link-local, is present on Ethernet/Tailscale (redacted).                                  |
| Default route               | (measured: Claude) A single `0.0.0.0/0` via Ethernet. (measured: Codex) Interface metrics: Ethernet 15, Tailscale 5, wt0 5.                                                                                                                                                         |
| NetBird                     | (measured; both) `netbird status`: 0.83.0, management/signal connected, Userspace interface. (measured: Claude) The NetBird IP is in 10/8, not 100.64/10, so it is labelled "Local network".                                                                                        |
| Tailscale                   | (measured; both) `tailscale ip -4` → 100.x.x.101. Version 1.104.7.                                                                                                                                                                                                                  |
| Native enumeration          | (measured: Codex) An in-memory Python ctypes call to Windows `GetAdaptersAddresses` (family 0, flags 30, the API `if-addrs` 0.15.0 uses) returned all three IPv4 adapters as OperStatus Up / DAD Preferred. The Rust crate itself was not executed: no toolchain is on the machine. |
| BiBCode listener            | (measured; both) `Get-NetTCPConnection -State Listen`: `bibcode-desktop` on `127.0.0.1:3773` only. Never contacted.                                                                                                                                                                 |
| Not probed                  | (measured) Firewall rules and whether the running app is elevated were not inspected. The production app and its data were left untouched.                                                                                                                                          |
| Error text                  | Pending owner screenshot.                                                                                                                                                                                                                                                           |

## Static trace (v0.15.3, peeled commit `3d3a08ef`; `origin/main` `a9938193` has the same code in these paths)

### Address list

- (measured) `desktop_bridge_get_advertised_endpoints`, `apps/desktop/src-tauri/src/bridge.rs:2089-2106`, calls `enumerate_system_advertised_addresses` (`apps/desktop/src-tauri/src/network_interfaces.rs:105-107`). That calls `if_addrs::get_if_addrs()` + `is_oper_up()` (`:184-202`), with no `cfg(unix)` gate and no name/type filter. The classifier (`:113-180`) keeps usable private IPv4: 10/8 and 192.168/16 → `lan`, 100.64/10 → `private-network`. The default route is found by a UDP-socket probe (`:204-208`).
- (measured) `advertised_endpoints_for_config`, `bridge.rs:607-678`: `status = "available"` only when `server_exposure_mode == "network-accessible"`. Otherwise every address is `unavailable` (`bridge.rs:621-625`).
- (measured: Claude) `tailscale_advertised_endpoints_for_config`, `bridge.rs:741-746`, returns empty while not network-accessible and with Serve off. Tailscale is not even queried in local-only mode.
- (measured) `resolveShareAddressOptions`, `apps/web/src/components/settings/remote-servers/shareOffer.ts:31-106`, keeps only `status === "available"` endpoints as per-address options (`:64-66`, `:92-104`). It still offers "Automatic (LAN)" when native exposure is local-only and a private default-route observation exists (`:73-88`).
- (measured) The behavior is intentional and covered by tests: `docs/architecture/remote.md:96-100` (Claude) and `shareOffer.test.ts:811-832`, which expects only Automatic for this input (Codex). The fix therefore changes documented, tested behavior on purpose.
- (measured) The combo is rendered at `ShareThisHostTab.tsx:359-387`.

### Code generation

- (measured) `handleGenerate` → `generateShareOffer`, `ShareThisHostTab.tsx:195-266` → `shareOffer.ts:193-352`. For Another device with native local-only exposure, it calls `applyServerExposure("network-accessible")` (`shareOffer.ts:228-247`). A thrown error is shown verbatim (`ShareThisHostTab.tsx:279-283`). After success, `endpoint = state.endpointUrl` (`shareOffer.ts:238`). The mint is an HTTP `POST /api/auth/pairing-offer` (`apps/web/src/environments/primary/auth.ts:448`; server `apps/server/src/auth/http.rs:322`, `pairing_offer.rs:36`, `pairing_code.rs:41`).
- (measured) Desktop: `desktop_bridge_apply_server_exposure`, `bridge.rs:1415-1432` → `apply_exposure_locked`, `apps/desktop/src-tauri/src/server_exposure.rs:37-112`, in this order:
  1. Restart the backend network-accessible (`:83-89`). The host comes from the default-route private IPv4 (`backend.rs:3109-3155`), not the first enumerated interface.
  2. Verify a wide endpoint (`:90-92`).
  3. **Firewall** `sync_firewall(true)` (`:93-97`) → `firewall::sync_remote_access_rule`. On Windows: `netsh advfirewall firewall show/delete/add rule name="BiBCode Remote Access" … profile=domain,private` (`firewall.rs:40-55`, `:385-404`, `:426-441`) through the ordinary process runner (`:283`), with a 5 s deadline (`:23`, `:200-202`). On macOS/Linux it is a no-op (`firewall.rs:443-446`).
  4. Persist the mode (`:98-102`). Any failure triggers local-only recovery and `format_exposure_error` (`:110-111`, `:195-215`).
- (measured: Claude) `git grep -i "elevat\|UAC\|administrator"` over `apps/desktop/src-tauri`, `docs/architecture` and `docs/testing` finds no elevation handling. Firewall tests stub `"Access is denied."` (`firewall.rs:593-596`, `:706-717`), but no test or runbook step covers a non-elevated `add rule`.

## Ranked causes

### Empty address list

| Rank | Hypothesis                                                                                                                                                                                 | Level                                                                                                                                                                                                     | Codex     | Claude                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------- |
| 1    | Local-only marks every off-host address `unavailable` (`bridge.rs:621-625`) and the web drops them (`shareOffer.ts:64-66`). Tailscale is also skipped in local-only (`bridge.rs:741-746`). | (inferred) traced in source. Consistent with the measured loopback listener, and with Automatic being visible, which needs a private default-route observation, so enumeration did return the LAN address | Rank 1    | Rank 1                                                              |
| —    | Windows enumeration misses the TUN adapters                                                                                                                                                | (measured: Codex) Ruled out at the OS API level: GetAdaptersAddresses returns all three Up. Rust crate not executed                                                                                       | Ruled out | Not testable there; moot, because addresses would still be filtered |
| —    | Name, type or CGNAT filter drops NetBird or Tailscale                                                                                                                                      | (measured) Ruled out by source (`network_interfaces.rs:113-180`)                                                                                                                                          | Ruled out | Ruled out                                                           |

### Generation error (pending the screenshot)

| Rank | Hypothesis                                                                                                                                                                                                                                                                                                                                                                                         | Level                                                                                                                                                                  | Predicted text                                                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | **Windows Firewall `add rule` fails, most likely because the desktop runs unelevated** (`server_exposure.rs:93-97` → `firewall.rs:385-404`, `:426-441`). Local-only is restored.                                                                                                                                                                                                                   | Claude: (inferred), rank 1. Codex: (guess), rank 2, as "firewall mutation fails" without asserting elevation. **Both rank it the leading Windows-specific candidate.** | `Could not apply server exposure network-accessible: open remote-access firewall rule: failed to add the remote access firewall rule: <netsh output>. Restored local-only safeguards.` (Claude guesses the netsh output is `The requested operation requires elevation (Run as administrator).`) |
| 2    | Firewall worker timeout (5 s deadline, `firewall.rs:23`, `:200-202`)                                                                                                                                                                                                                                                                                                                               | (guess; Claude only)                                                                                                                                                   | `… open remote-access firewall rule: firewall operation timed out after 5 seconds; fail-closed cleanup is queued. Restored local-only safeguards.`                                                                                                                                               |
| 3    | Wide restart fails or returns no wide endpoint (#302 class), or the default-route probe yields no qualifying host and the backend falls back to local-only (`backend.rs:3113-3117`, `:3148`)                                                                                                                                                                                                       | (guess; both). Claude expects restart to pass on this topology (one private default route). Codex notes the route probe was not run                                    | `… restart network-accessible backend: …` or `… restart did not produce a network-accessible endpoint …`; a mint timeout `Pairing-offer creation timed out after 5000ms.`                                                                                                                        |
| 4    | Missing, loading or failed desktop snapshot: `ShareThisHostTab.tsx:111-112` substitutes null, `shareOffer.ts:55-77` can keep the primary loopback URL under Automatic, and loopback is rejected server-side (`auth/pairing_offer.rs:55-62`). Bridge read failures are swallowed (`tauriDesktopBridge.ts:124-132`, `:583-600`). Non-Error rejections become a generic message (`shareOffer.ts:244`) | (guess; Codex only). Claude treated the null-address route as refuted for the normal path (`shareOffer.ts:238`)                                                        | `Could not enable remote access.` / `No reachable network address is available.` (`shareOffer.ts:250-255`) or a server-side loopback rejection                                                                                                                                                   |

### Error strings on the generate path (v0.15.3), for matching the screenshot

- `shareOffer.ts:244`: `Could not enable remote access.` (non-Error fallback)
- `shareOffer.ts:254`: `No reachable network address is available.`
- `shareOffer.ts:222`: `This address is not reachable as entered. Check the host and port.`; `:183,187`: `Enter a valid http(s) address.` (custom only)
- `shareOffer.ts:163`: `<operation> timed out after <ms>ms.` (for example `Pairing-offer creation timed out after 5000ms.`, timeout at `auth.ts:51`)
- `shareOffer.ts:297,319,336,340`: `Could not create the pairing offer.` / `… Pairing-offer cancellation failed: …` / `… Remote-access cleanup failed: …` / `… Remote-access cleanup could not be verified.`
- `ShareThisHostTab.tsx:285-290`: `The offer was not created. Remote access is confirmed local-only.` and variants
- `server_exposure.rs:72`: `Native server exposure is unavailable while WSL-only primary mode is active.`
- `server_exposure.rs:86,91,96,101` wrapped at `:206-213`: `Could not apply server exposure network-accessible: {restart network-accessible backend: … | restart did not produce a network-accessible endpoint | open remote-access firewall rule: … | persist network-accessible mode: …}. Restored local-only safeguards.` (or `… Local-only recovery also reported: …`)
- `firewall.rs:189,194,199,201,423,316,378,433`: `firewall worker is saturated; …`, `firewall worker is unavailable`, `firewall worker stopped before reporting completion`, `firewall operation timed out after 5 seconds; fail-closed cleanup is queued`, `failed to add the remote access firewall rule: <netsh output>`, `failed to delete and verify the remote access firewall rule: <netsh output>`, `failed to resolve desktop executable: …`

## Regression and platform

- (measured; both) **Not a v0.15.x regression.** The availability filter, the local-only `unavailable` marking, the Tailscale skip and the firewall step are identical at v0.15.0, v0.15.2 and v0.15.3. The same code is on `origin/main`.
- (measured: Claude) They were introduced in `c8fdcde6a` (2026-08-27, Windows firewall rule), `081bc1512` (exposure apply with rollback and firewall sync) and `5968d21e1` (2026-08-29, added the `status === "available"` filter).
- (inferred; both) Part 1 affects macOS and Linux the same way. Part 2's firewall cause can only occur on Windows.

## Requirements (EARS) and scenarios

### R1. Show the addresses sharing will use [Must]

(inferred) WHILE native remote access is local-only, the Address combo SHALL list each usable private IPv4 the desktop observed (LAN, VPN/overlay such as NetBird, Tailscale) as a selectable option that says selecting it will enable remote access. It SHALL keep public addresses non-actionable.

- **Given** a local-only native host with LAN 192.168.x.x (default route), NetBird 10.x.x.x and Tailscale 100.x.x.x, **when** the user opens Share this host → Another device, **then** the combo lists "Automatic (LAN)" plus those three addresses.
- **Given** Tailscale Serve is off, **when** endpoints are read in local-only mode, **then** Tailscale IPs are still observed.
- **Given** a public-only host, **then** behavior is unchanged (`no-private-address` copy, no public option preselected).
- Update `shareOffer.test.ts:811-832` and `docs/architecture/remote.md:96-100` deliberately.

### R2. Widening works, or explains itself, on non-elevated Windows [Must]

(inferred) WHEN a user generates an Another-device code on Windows and the firewall rule cannot be created, BiBCode SHALL either obtain it through an explicit elevation step the user can approve, or SHALL show an actionable message naming the missing permission and the failing step. It SHALL NOT show a raw netsh chain or a generic message that hides the reason.

- **Given** a non-elevated Windows desktop, **when** the user clicks generate with "Automatic (LAN)", **then** either a UAC prompt appears and, once approved, a code for `http://192.168.x.x:<port>` is shown, or the dialog says administrator permission is needed for the firewall rule and offers retry.
- **Given** the user declines elevation, **then** the server is verified local-only, with no stray rule or wide listener.
- **Given** the LAN adapter's network profile is Public, **then** the dialog warns that the `profile=domain,private` rule may not admit other devices.

### R3. Keep the safety guarantees [Must]

(inferred) Keep rollback to local-only on any failed switch, fail-closed firewall cleanup, no automatic selection of public addresses, and the WSL-only exclusion. String rejections from the bridge SHALL keep a sanitized reason instead of falling back to `Could not enable remote access.`

## Open questions (including where the two diagnoses disagree)

- (measured) **Exact error text.** The screenshot decides between generation causes 1–4. Match it against the strings above.
- **Confidence in the firewall cause.** Claude rates it (inferred) and names elevation specifically. Codex rates it (guess) and leaves the reason open: privilege, policy, command failure or deadline. Neither inspected the app's elevation or the firewall rules. Is the installed app running non-elevated? Was the native widen path ever validated on a non-elevated Windows install?
- **Snapshot/loopback fallback (Codex only).** Can a missing or failed desktop snapshot make Automatic carry the loopback URL, so the server rejects the offer? Claude considered the null-address path refuted for the normal flow (`shareOffer.ts:238`). Needs an isolated caller test with delayed or failed bridge reads.
- **Default-route probe.** It was not executed (Codex). Claude's route-table reading says the backend should resolve 192.168.x.x. Confirm in isolation.
- **Release view.** Claude: not a blocker (pre-existing; a custom address with an externally managed server still works). Codex: block the next release on this flow if isolated confirmation shows ordinary Windows sharing fails. The agent's call is in the triage section above.
- **Firewall design (implementer/design).** Choose between a UAC-elevated netsh helper per operation, an install-time rule created by the already-elevated NSIS installer, and an optional rule with a warning. The installer route needs a design note.
- **if-addrs 0.15 on Windows.** Does the crate itself report `wt0` and the Tailscale adapter as oper-up? The OS API does (measured: Codex), but the crate was not executed.
- **Network profile.** Is the LAN adapter's profile Private or Public?

## Suggested reproduction (isolated; not run)

1. (inferred) On a disposable Windows 11 machine with UAC on and LAN, NetBird and Tailscale up, install v0.15.3 with fresh data and start it normally (not "Run as administrator"). Keep remote access local-only.
2. (inferred) Open Settings → Remote servers → Share this host → Another device. Expect only "Automatic (LAN)".
3. (inferred) Click Generate pairing offer and record the exact error. Do not record any code.
4. (inferred) Control: start the app via "Run as administrator" and repeat. Firewall-cause prediction: the code is generated and the combo then lists per-address options.
5. (inferred) After each run, check `netsh advfirewall firewall show rule name="BiBCode Remote Access"` and the listener address with `Get-NetTCPConnection -State Listen`.
6. (inferred) Automated seams: a `shareOffer.test.ts` case for R1 (local-only, three `unavailable` private endpoints → per-address options), and a `server_exposure.rs`/`firewall.rs` test whose runner returns an elevation-required output, asserting the message and local-only recovery for R2.

## Related and duplicate check

(measured) Both diagnoses ran unauthenticated GitHub REST searches of `repo:mubeda/BibCode`, all states, for share, server, "IP address", Tailscale, NetBird, LAN, pairing, code and Windows. Claude also searched firewall. Codex paginated fully (213 unique issues). Claude reviewed the first 30 per term. **Neither found a duplicate.** Related:

- #28 (closed): "Share This Host's no-private-default-route copy has never been verified live on a real host". Same dialog, different state.
- #302 (closed): "Desktop loses its local server at launch with an Another device pairing (v0.15.0)". Same widen/restart path; relevant to generation cause 3.
- #76 (closed PR): "fix(desktop): accept localized Windows firewall misses". Same firewall module, but about localized output.
- #233 (closed, seeded-upgrade token fallback) and #89 (closed, Tailscale latency): keyword overlap only.

## Evidence and decision record

- (measured) Two independent diagnoses ran: Codex (gpt-6-astra, high) and Claude Code (claude-opus-5-5, medium). Both followed mstack-diagnose claim tiers, mstack-write-specs (EARS) and mstack-backlog-triage, adapted to this repository's issue format. Neither saw the other's output. The merge keeps agreed points in the main text and moves disagreements to Open questions.
- (measured) The work was diagnosis only: no code edits, commits, branches, PRs, tests, builds or app runs. Source was read with `git show`/`git grep`/`git log`/`git diff` at v0.15.3 and origin/main. No scratch worktree was created. The working tree was clean and HEAD/branch were unchanged before and after.
- (measured) OS probes were read-only (Get-NetAdapter, Get-NetIPAddress, Get-NetIPInterface, Get-NetRoute, Get-NetTCPConnection -State Listen, netbird status, tailscale version/ip), plus an in-memory GetAdaptersAddresses call. The BiBCode app was not stopped, signalled or contacted, and none of its userdata, config, logs, databases or profiler data was opened.
- (inferred; agent's call) bug, P1, size:M, labels **bug, needs-triage, size:M**. Not a release blocker by itself; re-evaluate after the screenshot.
- (measured) Privacy check done: no machine names, usernames, user-profile paths, MAC addresses, public IPs or tokens. Private and CGNAT addresses are partially masked.
