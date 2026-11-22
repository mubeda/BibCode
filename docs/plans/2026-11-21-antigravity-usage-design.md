# Antigravity in the agent usage status bar: design (task 3.11, requirement R18)

Status: round 1 of the Codex review (13 findings) processed on 2026-11-21 under the coordinator's rulings; see "Review record". The revision is not reviewed again.

Scope. The status bar shows account usage for Claude and Codex only. This note
decides how Antigravity (CLI `agy`) joins them, and which hardcoded two-provider
spots the change touches. Task 3.12 implements it.

Sources. The living code at the lines cited below; the CLI changelog read with
`agy changelog` (1.5.14); and two live read-only runs on 2026-11-21
(`agy -p "/usage"` and `-p "/credits"`, each with `--output-format json`, from a
scratch folder). Both exited 0 with `num_turns` 0 and zero tokens. The run took
3.7 s wall time. No prompt was sent. Raw output is not kept anywhere.

## Measured facts

- `command.name` is `usage`. `command.data.groups[]` has two entries, "Gemini
  Models" and "Claude and GPT models". Each has `buckets[]` with `id`
  (`gemini-weekly`, `gemini-5h`, `3p-weekly`, `3p-5h`), `window` (`weekly` or
  `5h`), `remaining_fraction` (a float, 0 to 1) and `reset_time` (an RFC 3339
  UTC string, for example `2026-11-28T21:28:19Z`). The text form prints
  percentages that are rounded `remaining_fraction`.
- The `response` and `command.data.description` strings are free text that may
  carry the account's plan name. The parser must not read them, and nothing may
  log stdout.
- `/credits` returns `command.data.remaining_credits` (an integer). It is not
  part of this change: no status bar surface exists for AI credits, and a second
  spawn doubles the cost.
- Changelog: `-p "/usage"`, `/quota` and `/credits` were added in 1.1.11
  ("without starting an agent turn, spending quota"). Before 1.1.11 the text is
  sent to the model as a prompt. In a later release, with `GEMINI_API_KEY`
  sign-in these commands "exit with code 2" in `-p` runs because the key has no
  account quota. `--output-format json` exists since 1.1.8.
- Not measured: the output of a signed-out CLI, and the JSON shape of versions
  between 1.1.11 and 1.5.14. Signing out would touch the account, and a
  relocated `HOME` was not allowed in this session. The design treats both as
  "unavailable, not an error" (below) and the fetcher never trusts a shape it
  does not recognize.

## Current behavior (evidence)

- Contract: `ServerProviderUsageProvider = Literals(["claude","codex"])`
  (`packages/contracts/src/providerUsage.ts:6`). A snapshot has one `session`,
  one `weekly`, and one extra `fableWeekly` slot (`:36-40`). A window stores the
  USED percent, the window length in minutes, `resetsAt` and a free
  `resetDescription` (`:18-23`).
- Server: `enum ProviderUsageProvider { Claude, Codex }`
  (`apps/server/src/provider_usage/mod.rs:48-51`); `providers()` lists both
  (`:1130-1132`); `production_fetchers()` returns the two fetchers (`:493-495`).
  `ProviderUsageFetcher` is `{provider, fetch: Fn() -> Future}` with no inputs
  (`:205-209`). Each fetch runs under a 10 s `USAGE_TIMEOUT` (`:32`, `:413`),
  one after another (`:405-432`).
- Polling: the status bar refreshes every 30 s while the window is focused
  (`AppStatusBar.tsx:46`, `:182-203`). The server throttles a non-forced
  refresh to one per 30 s for all providers together, not per provider
  (`mod.rs:30`, `:345-356`). The Refresh button sends `force: true`.
- The Codex fetcher spawns `codex app-server` with `kill_on_drop` and its own
  timeout, not through `process::supervised` (`mod.rs:824-914`; it resolves and prepares its executable at `:824-831`). That path is
  the older one; AGENTS.md asks new child processes to use
  `process::supervised`. OpenCode's probe is the pattern to copy
  (`provider_terminal/opencode.rs:2353-2365`: `run_supervised` with
  `SupervisedRunRequest`, a byte cap and `StopPolicy::Force`).
- Last good data survives a failed fetch (`retain_last_good_usage`,
  `mod.rs:1187-1203`); a successful snapshot older than 30 min reads as
  unavailable (`:1172-1185`, `STALE_THRESHOLD_MS`).
- The profiler already treats `server.refreshProviderUsage` as long-running
  (`diagnostics/profiler/latency.rs:168`).
- Settings: `providers.antigravity` exists with `enabled: false` and
  `binaryPath: "agy"` (`server_settings/mod.rs:21`, `:63`); custom instances live
  in `provider_instances` with `driver` and `enabled`. The usage service is built
  in `production/runtime.rs:690`, after the `ProviderSettingsStore` exists
  (`:480`).

## Decisions

### A. Wire shape (several quota groups)

Options: one group only (hides measured data); flat `fableWeekly`-style slots
(names one vendor's split in the shared contract); two pseudo-providers (two
spawns, items that no longer map to drivers); an optional `windowGroups` array.
Recommendation: `windowGroups`, default `[]` (Effect's decoding default makes it
compatible with old servers; old clients ignore the extra field). Each group is
`{id, label, session, weekly}` over the existing window type; `session` and
`weekly` stay null for Antigravity.

Privacy (finding 4). The CLI's group `name`, `description`, `response` and every
other free-text field are never read, stored, sent or logged. The group id and
label come from the bucket id prefix only: `gemini-` gives "Gemini models",
`3p-` gives "Claude and GPT models", anything else gives "Other models". The
parser decodes only `command.name`, `num_turns`, `status`, and per bucket `id`,
`window`, `remaining_fraction`, `reset_time`. `plan_type` stays `None`.

Conversion. `usedPercent = round((1 - remaining_fraction) * 100)` clamped to
0..100 after dropping non-finite values. `windowMinutes` is 300 for `5h` and
10080 for `weekly`; another `window` drops the bucket. `reset_time` is parsed
strictly as RFC 3339 (the existing `parse_reset`, `mod.rs:1103`, also accepts
numeric epochs and is not used); an invalid time becomes null. A group with no
usable bucket is dropped; no group gives `unavailable`. Boundary cases
(fraction 0, 1, 0.004, 0.996, 0.5, negative, above 1, NaN, a numeric reset) are
tests.

### B. Item and detail

- The item shows the tightest window across groups (compact and summary; the
  icon-only badge shows a dot when any window exists, as for the others,
  `ProviderUsageControl.tsx:22-40`). The popover shows one section per group
  with its 5-hour and weekly meter and reset time; no plan, no credits.
- Opt-in (finding 5). A new optional client setting `showAntigravityUsage`,
  default false. The `StatusBarItem` array is NOT extended: an older client
  decodes the whole array to the defaults when it meets an unknown literal
  (`settings.ts:217-220`) and writes the whole document back
  (`useSettings.ts:347`), which would lose the user's other choices. A separate
  boolean an old client does not know is ignored by it.
- The item is built from the settings flag and the query state, not from the
  presence of a snapshot, so it renders before the first answer and keeps the
  manual refresh control reachable when it is the only usage item (the filter
  `visible && viewModel !== undefined` at `AppStatusBar.tsx:126-129` is replaced
  for it by a placeholder view model). Provider labels and icons become lookup
  tables with no default branch; an unknown provider renders nothing.
- Visibility selector, equality check and presentation cache
  (`AppStatusBar.tsx:84-91`, `:314`) include the new flag, and
  `providerUsageRelativeLabelKey` (`providerUsagePresentation.ts:180`) includes
  group windows, so a countdown cannot stay stale when only group windows exist
  (finding 10).
- For a non-ok state with no usable data the popover shows only the sentence;
  retained last-good meters plus "Showing last available usage" appear only for
  an `error` snapshot that still has data.

No-data states (finding 8), one sentence each, no sign-in instruction without
evidence of sign-out:

| State                                                                                                                    | Sentence                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Before the first answer                                                                                                  | "Reading Antigravity usage..."                                                              |
| Server cannot serve it (refresh rejected, or the answer has no Antigravity entry)                                        | "This BiBCode server is too old to show Antigravity usage."                                 |
| Provider turned off                                                                                                      | "Antigravity is turned off. Turn it on in Settings, Providers."                             |
| CLI missing or cannot start                                                                                              | "The Antigravity CLI could not be started."                                                 |
| Version probe failed, truncated or unparsable; or below 1.1.11                                                           | "Antigravity usage needs CLI 1.1.11 or newer, and its version could not be confirmed."      |
| Exit code 2 (documented in the changelog for the versions that print it; older versions are already refused by the gate) | "This Antigravity sign-in uses an API key, which has no account quota."                     |
| Signed out                                                                                                               | Not shown: no output of a signed-out CLI was measured, so it falls under transient failure. |
| Timeout, other non-zero exit, spawn failure                                                                              | "Antigravity usage could not be read. It will be tried again."                              |
| Guard fails, bad JSON, truncated stdout, empty groups                                                                    | "Antigravity reported usage in a format this version of BiBCode does not read."             |
| Snapshot older than 30 minutes                                                                                           | "Antigravity usage is out of date. It will be tried again."                                 |

Out-of-usage hint (finding 9, coordinator ruling overriding the plan).
Antigravity gets no hint in this pull request: several groups make "out of
usage" ambiguous (display rounding versus exact exhaustion, a dropped group, a
custom instance sharing the driver, different reset times). `usageProviderOf`
stays `null` for it and a test pins that. Claude and Codex background refresh is
unchanged when their items are hidden (Send to Agent reads those snapshots,
`ChatSendToAgentControl.tsx:41`).

### C. Fetch

Command: `<absolute executable> -p "/usage" --output-format json`, never
`--dangerously-skip-permissions`, stdin closed,
`sanitize_provider_subprocess_environment`, the instance's environment applied.

Instance (finding 3). The effective default instance is resolved as the
inventory does: the explicit `providerInstances.antigravity` first, the legacy
`providers.antigravity` entry as fallback, through the existing
`maintenance_target(settings, "antigravity", Some("antigravity"))`
(`provider_inventory.rs:452`), which returns the binary path and environment.
That helper does not return `enabled`, so the fetcher reads it from the same
document with the same precedence (explicit instance, else legacy, default
false). A disabled instance spawns nothing. Saving the default card writes the
explicit instance and resets the legacy entry (`SettingsPanels.logic.ts:185`);
the test goes through that saved shape. Custom Antigravity instances are not
covered.

Trust (finding 1). The configured binary path is trusted the way the chat
provider trusts it; a hostile same-name binary is out of scope. What is guarded
is accidental quota spend: `agy --version` runs first under the same supervisor
and the fetch proceeds only when it exits 0, its stdout is complete (not
truncated) and is exactly one `major.minor.patch` token, at least 1.1.11. The
result is cached keyed by (resolved absolute path, modified time, size) and the
probe re-runs when any of them changes, so a replaced or retargeted executable
is re-checked. A failed probe is not cached. Known limit (reviewed twice, kept): an executable replaced at its resolved path between the version probe and the usage run is not detected; the configured binary is trusted as the chat provider trusts it.

Deadline and spawn (findings 7, 12). One combined deadline of 20 s covers the
probe (at most 5 s) and the fetch; the service's timeout for this provider is
25 s, above the inner deadline plus both cleanup windows, so the outer timeout
never drops a supervised future before its cleanup runs. `run_supervised` with a
64 KiB cap and `StopPolicy::Force`; a truncated stdout (observed bytes above kept
bytes) is "format not read". The working directory is a fresh temporary
directory removed afterwards (not the data root, which may sit inside a
checkout). Both children are registered with the `ProcessAttributionRegistry`
(`AttributionKind::Helper`, `AttributionScope::External`, the pattern at
`tool_maintenance.rs:946`), passed into `production_fetchers`. An unrequested
signal death is already reported as `subprocess.crash` by the supervisor's
signal watch; no new event.

Admission (finding 6). Each fetcher may carry a minimum interval (Antigravity: 5
minutes), measured on a monotonic clock per provider and guarded by an async
lock per provider: no second CLI process runs at once. A throttled refresh
inside the interval serves the cache. A forced refresh bypasses the cooldown but,
if an attempt finished after it arrived, joins that attempt's result instead of
spawning. The global 30 s throttle applies only to providers without an
interval, so a Claude/Codex poll cannot starve Antigravity, and an
Antigravity-only request does not consume the global slot. The "12 an hour"
figure counts automatic usage attempts only. Tests: staggered polls,
simultaneous forced refreshes, caller cancellation.

Isolation (findings 2, 7). The web sends Antigravity in its own request
(`providers: ["antigravity"]`) and its own read, so it can never delay or fail
the Claude and Codex request. Server rule: Antigravity appears in a response only
when the request names it. `server.getProviderUsage` gains an optional
`providers` input; the two refresh RPCs already have one; the nested usage in the
Codex reset response and any request that omits `providers` keep the legacy list
(Claude, Codex). Support detection: capability flags are advertised from
`production/control.rs`, which this lane may not edit, so support is detected
from the exchange itself: an old server rejects the literal (invalid request) or
answers without an Antigravity entry, and the web shows the "too old" sentence
for that environment. A capability flag is a recorded follow-up. Tests cover
both directions across the read, refresh and reset RPCs.

### D. Spots to change

As in the first draft, with these corrections: `settings.ts` gets the optional
`showAntigravityUsage` boolean and the `StatusBarItem` literal is left alone;
`rpc.ts:1013` (read payload) and `client-runtime/state/server.ts:210` follow;
`outOfTokens.logic.ts` is not changed apart from a pinning test;
`providerUsagePresentation.ts` flattens groups and its cache key covers them;
`production/server_terminal.rs` (request match at `:781-783`, wire at `:1849`,
read input) and `runtime.rs:690` (settings store and attribution registry into
`production_fetchers`). Also `ProviderModelsSection.tsx:33-38` (custom-model
placeholder) and `activityPresentation.ts:245-251` (label) with tests.

R18's last bullet (provider pickers): review terminals
(`providerTerminalActions.ts:252`), MCP client registration
(`mcp_client_registration/mod.rs:34`), session import
(`agent_sessions_rpc.rs:44`) and native skill discovery
(`provider_inventory/capabilities.rs:134`) do not offer Antigravity. Each is
outside this lane's files; the disposition for the pull request text is "not
offered here" and is recorded for the coordinator, not changed.

### E. Profiler

Both children are attributed (above); signal deaths already become
`subprocess.crash` through the supervisor; `server.refreshProviderUsage` is
already long-running (`latency.rs:168`) and `getProviderUsage` is state-only.
Failures log a failure class with `tracing::warn!`, never CLI text. No new
service, so shutdown ordering is unchanged. Documentation:
`docs/providers/antigravity.md` and the RPC documentation
(`docs/architecture/rpc-and-orchestration.md:5537`) get the changes.

## Review record

| #   | Finding                                     | Disposition                                                                                                                                   |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Version gate, same-path downgrade, impostor | Downgrade accepted (cache key path, mtime, size; untruncated output). Impostor rejected: configured paths are trusted like the chat provider. |
| 2   | Version skew both directions                | Accepted: named-only responses, separate request. Capability flag deferred (control.rs is another lane's); support read from the exchange.    |
| 3   | Wrong instance, legacy entry                | Accepted: effective default instance via the inventory helper, explicit first.                                                                |
| 4   | Group name leak                             | Accepted: fixed labels from the bucket prefix; marker test.                                                                                   |
| 5   | Settings downgrade                          | Accepted: separate boolean, array untouched.                                                                                                  |
| 6   | Admission                                   | Accepted: per-provider monotonic interval, join in-flight.                                                                                    |
| 7   | Timeouts, batching, truncation, cwd         | Accepted: combined deadline, own request, truncation rejected, temp directory.                                                                |
| 8   | No-data states                              | Accepted: one table.                                                                                                                          |
| 9   | Out-of-usage hint                           | Overridden by the coordinator: no hint, pinned by a test.                                                                                     |
| 10  | Reset and visibility paths                  | Accepted: cache key, selector, strict RFC 3339.                                                                                               |
| 11  | Provider-picker audit                       | Dispositions recorded for the PR; placeholder and label tests kept.                                                                           |
| 12  | Profiler                                    | Accepted: attribution registered, signal reporting stated.                                                                                    |
| 13  | Citations                                   | Fixed.                                                                                                                                        |

## Verification plan for task 3.12

Rust tests: parser (measured shape, guard failures, strict time, boundaries,
marker in every free-text field, stdout and stderr, snapshot, wire, error and
log capture), version gate with a fake binary (same-path downgrade, truncated,
multi-token output spawns no usage run), instance resolution through the saved
settings shape, admission (staggered, simultaneous forced, cancellation), RPC
named-only responses. Web tests: the item and states table, an unknown provider
renders nothing, toggling the flag with an unchanged snapshot, a reset crossing
with a skewed clock, the no-hint pin, the placeholder and label. Mutation proof:
let the parser accept any command name and see the tests fail. Live comparison
against `agy -p "/usage"` at the end, percentages only.
