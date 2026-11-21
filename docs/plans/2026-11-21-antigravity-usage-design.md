# Antigravity in the agent usage status bar: design (task 3.11, requirement R18)

Status: draft written 2026-11-21, not yet reviewed by Codex or the advisor.

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
  one `weekly`, and one extra `fableWeekly` slot (`:30-33`). A window stores the
  USED percent, the window length in minutes, `resetsAt` and a free
  `resetDescription` (`:15-20`).
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
  timeout, not through `process::supervised` (`mod.rs:830-914`). That path is
  the older one; AGENTS.md asks new child processes to use
  `process::supervised`. OpenCode's probe is the pattern to copy
  (`provider_terminal/opencode.rs:2350-2375`: `run_supervised` with
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

## Decision A: wire shape for several quota groups

Options.

1. Show one group only (Gemini) in `session` and `weekly`. No contract change
   beyond the provider literal. Cost: the Claude and GPT models, which the CLI
   also serves, silently have no limit shown, and a user on those models sees
   an empty-looking bar while blocked. This hides measured data.
2. Add flat slots in the style of `fableWeekly` (`thirdPartySession`,
   `thirdPartyWeekly`). Mechanical, but names one provider's marketing split in
   the shared contract and adds two more nullable slots every consumer must
   list (the presentation already enumerates slots in
   `providerUsagePresentation.ts:64-70`).
3. Add an optional `windowGroups` array to the snapshot: each `{id, label,
   session, weekly}` using the existing window type, decoded with a default of
   `[]` like `planType`. Antigravity fills it and leaves `session`/`weekly`
   null. Claude and Codex are unchanged. A future provider with groups needs no
   contract change.
4. Two pseudo-providers (`antigravity-gemini`, `antigravity-3p`). Two spawns or
   a shared cache, two bar items, and a provider list that no longer maps to
   drivers. Rejected.

Recommendation: option 3. It is additive (old clients decode the field away;
the default makes new clients read old servers), keeps `ProviderUsageWindow`
as is, and is the only option that shows all measured data without growing the
slot list again.

Conversion. The CLI reports remaining, the contract stores used.
`usedPercent = round((1 - remaining_fraction) * 100)`, clamped to 0..100 after
dropping non-finite values, so 0.986 reads 1 % used (the existing `map_window`
rounds the same way, `mod.rs:1049-1069`). `windowMinutes` is 300 for `5h` and
10080 for `weekly`; any other `window` value drops that bucket. `resetsAt` is
`reset_time` parsed as RFC 3339 (`parse_reset`, `:1103`); an unparsable time
becomes null, not an error. `resetDescription` is null. Group `id` is a stable
slug (`gemini`, `third-party`) derived from the bucket id prefix, `label` is the
group `name` the CLI reports, capped to 40 characters. A group with no usable
bucket is dropped; no group at all gives `unavailable`, not `ok`.
Edge: 0.996 remaining rounds to 0 % used and 0.004 remaining to 100 % used while
a sliver is left; the out-of-usage hint (Decision D) therefore tests
`remaining_fraction <= 0` through `usedPercent === 100` only after rounding, the
same behavior Claude and Codex have today. Accepted.

Server-side, `ProviderUsageSnapshot` gains `window_groups: Vec<ProviderUsageWindowGroup>`;
`has_usable_usage` (`mod.rs:1205-1211`) counts it, so the last good groups
survive a failed fetch. The plan name is never stored: `plan_type` stays `None`.

## Decision B: status bar item and detail

- Item. A third usage item with the Antigravity (Gemini mark) icon and the label
  "Antigravity". `ProviderUsageBadge` and `ProviderUsageSummary` show the
  tightest window across all groups in compact mode, the existing rule
  (`providerUsagePresentation.ts:147-152`). In detailed mode the summary shows
  that same tightest window, because four meters do not fit in a status bar
  item.
- Popover. One section per group under its label ("Gemini Models", "Claude and
  GPT models"), each with its 5-hour and weekly meter (reusing
  `ProviderUsageWindowMeter`) and the reset time. The existing "used" or
  "remaining" display setting applies. A footer line says "Read from the
  Antigravity CLI". No plan, no credits.
- Why no data. The item always renders when switched on and the server has a
  snapshot. For `unavailable` or `error` the popover shows one sentence from the
  server and no meters:
  - provider disabled: "Antigravity is turned off. Turn it on in Settings,
    Providers."
  - CLI missing: "The Antigravity CLI was not found at the configured path."
  - CLI older than 1.1.11: "Antigravity CLI 1.1.11 or newer is needed to show
    usage."
  - exit code 2: "This sign-in uses an API key, which has no account quota."
  - signed out or any other non-zero exit: "Antigravity could not read your
    quota. Run agy to sign in." The CLI's stderr is not shown: it can name the
    account.
  - unrecognized output (guard fails or shape unknown): "Antigravity reported
    usage in a format this version of BiBCode does not read."
- Settings. A third checkbox, off by default, in `StatusBarSettingsSection`.
  Off by default because Antigravity itself is disabled by default (spec D7) and
  the item would show nothing for most users.
- Unknown providers. Every `provider === "claude" ? ... : Codex` becomes a
  lookup table keyed by provider, with no default branch that names a vendor: an
  unknown provider renders nothing (and TypeScript's exhaustive record fails the
  build when a new literal is added). This satisfies R18 bullet 3.

## Decision C: the fetch

Command. `<binary> -p "/usage" --output-format json`, no other flags, never
`--dangerously-skip-permissions`. `--print-timeout` is not passed: the
supervisor's own timeout is the single clock and does not depend on a flag an
older CLI may lack.

Spawn. `run_supervised` with `SupervisedRunRequest`: `timeout` 15 s (the
measured run is 3.7 s, mostly one network call; the service-level 10 s
`USAGE_TIMEOUT` is raised for this provider to match), `cleanup_timeout` 2 s,
`max_output_bytes` 64 KiB with `SupervisedOverflow::Truncate` treated as
unrecognized output, `StopPolicy::Force`, stdin closed, stdout and stderr piped,
`sanitize_provider_subprocess_environment` applied, a neutral working directory
(the server's state directory, never a project, so nothing in a repository is
loaded). The binary is resolved with `resolve_provider_executable`
(`production/provider_runtime.rs:15038`) and launched with
`prepare_provider_launch` (`:15107`), as Codex does (`mod.rs:822-833`).

Which binary and instance. The built-in `antigravity` instance's `binaryPath`,
read from `ProviderSettingsStore` at fetch time, and only when its `enabled` is
true; otherwise the snapshot is `unavailable` (reason above) and nothing is
spawned. Alternatives: the first enabled instance with driver `antigravity`
(custom instances may carry their own environment, so a different account would
be reported under the one label; rejected for now), or one item per instance
(needs a per-instance snapshot key; out of scope). Custom Antigravity instances
are therefore not covered; the settings row says so in one line. The
`ProviderSettingsStore` is passed into `production_fetchers(...)` from
`runtime.rs:690`.

Version gate (the safety property). A CLI before 1.1.11 would treat `/usage` as
a prompt and spend quota on every poll, and the result guard below only looks
after the spend. So the fetcher first runs `<binary> --version` under the same
supervisor (5 s timeout), accepts only output that is exactly one
`major.minor.patch` token, and fetches only when it is at least 1.1.11. The
token rule is the only defense against the IDE launcher that shares the name
`agy`; what that launcher prints for `--version` was not measured, so the
rule narrows the risk and does not close it (the result guard still applies). The version is
cached per resolved binary path for the life of the process: the common path
then costs one spawn per refresh, and an upgrade never lowers a version. A
failed or unparsable probe is not cached, so a fixed install is picked up on
the next refresh. If the provider inventory (owned by another lane) later
exposes a probed version, the fetcher should read that instead; this note does
not depend on it.

Result guard. The JSON is accepted only when `command.name == "usage"` and
`num_turns == 0` (an integer zero; a missing field fails). Anything else,
including `status` other than `SUCCESS`, is "unrecognized output" and the
snapshot is `unavailable`. Exit code 2 is checked before the output is parsed
and maps to the API-key message. Any other non-zero exit, a timeout, or a spawn
error is an `error` snapshot (last good data kept, as for the other providers).
A parse never panics and logs only the failure class through `tracing::warn!`,
never the CLI's text.

Poll cost. The bar asks every 30 s and the server throttles only globally. A
`usage` spawn every 30 s costs a process, a Google API call (the changelog says
`/usage` forces a real-time quota reload) and 3.7 s of a sequential refresh that
Claude and Codex also wait on. Options:

1. Refresh on every poll. 120 spawns an hour; rejected.
2. A cache inside the Antigravity fetcher. Hides the policy inside one closure,
   and a forced refresh would need a second path to bypass it.
3. A `min_interval: Option<Duration>` on `ProviderUsageFetcher`, applied by the
   service: a throttled refresh skips a provider whose last attempt is younger
   than the interval and serves the cached snapshot; a forced refresh (the
   Refresh button, which the user pressed to see fresh numbers) always runs.
   Claude and Codex keep `None`.
4. Exclude Antigravity from the polled provider list and refresh it only when
   its popover opens. Needs new client state and gives stale numbers in the bar.

Recommendation: option 3 with `min_interval` of 5 minutes. The windows are 5 hours
and a week, so 5 minutes is invisible, it gives at most 12 spawns an hour, and
the 30-minute staleness threshold (`mod.rs:31`) stays well clear. Failed fetches
count as attempts, so a broken CLI is also retried at most every 5 minutes. The
web client requests `antigravity` only while its item is on, so a user who never
enables it never spawns anything. Fetchers also run last in the list so a slow
CLI does not delay Claude and Codex.

Version skew. A server that returns an unknown `provider` literal in the
`providers` array makes an older client fail to decode the whole result, which
would blank Claude and Codex too (remote servers can be newer than the client).
`read()` therefore lists Claude and Codex always and any other provider only once
it has been refreshed at least once (it then has a snapshot in state). An older
client never asks for it, so it never receives it. A newer client reading an
older server sees no Antigravity entry and renders no item. The same hazard
exists for `StatusBarItem`: `Schema.Array(StatusBarItem)` with `catchDecoding`
resets the whole list to the default when it holds a literal the reader does not
know (`packages/contracts/src/settings.ts:217-220`), so an older client reading
settings that hold `"antigravity"` resets to the defaults. That is a downgrade
cost only, no data is lost, and is accepted and noted in the changelog entry.

## Decision D: every two-provider spot

| Place                                                                  | Today                                                                                       | Change                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/providerUsage.ts:6`                            | `["claude","codex"]`                                                                        | add `"antigravity"`; add `ServerProviderUsageWindowGroup` and `windowGroups` (default `[]`)                                                                                                             |
| `packages/contracts/src/settings.ts:29-34`                             | `StatusBarItem` literal and `DEFAULT_STATUS_BAR_ITEMS`                                      | add `"antigravity"` to the literal, not to the default list                                                                                                                                             |
| `apps/server/src/provider_usage/mod.rs:48-51, 1130-1132, 493-495`      | enum, `providers()`, `production_fetchers()`                                                | add `Antigravity`; `providers()` per the skew rule; add the fetcher, `min_interval`, window groups                                                                                                      |
| `apps/server/src/production/server_terminal.rs:781-783, 1849`          | request match (`"provider must be claude or codex"`) and response match                     | add `"antigravity"` to both; the error text names all three; add `windowGroups` to the wire; extend the wire test (`:3712-3748`)                                                                        |
| `apps/server/src/production/runtime.rs:690`                            | `production_fetchers()`                                                                     | pass the settings store                                                                                                                                                                                 |
| `apps/web/src/components/status-bar/AppStatusBar.tsx:126-129, 239-251` | provider list, `showClaudeUsage ? ... : showCodexUsage`, fixed `["claude","codex"]` request | provider table with a visibility flag each; the request lists only visible providers                                                                                                                    |
| `ProviderUsageControl.tsx:10-20`                                       | `providerLabel`, `ProviderIcon` (Claude else OpenAI)                                        | lookup tables, no default                                                                                                                                                                               |
| `ProviderUsageDetail.tsx:60-62, 116, 167, 198, 226`                    | label; Codex-only plan, credits and reset notice blocks                                     | label table; keep Codex-only blocks; add the group sections                                                                                                                                             |
| `providerUsagePresentation.ts:16-21, 64-70, 134-170`                   | window keys and labels                                                                      | flatten `windowGroups` into windows with a group label; widen `label`                                                                                                                                   |
| `settings/StatusBarSettingsSection.tsx:7-11, 80-125`                   | `STATUS_BAR_ITEM_ORDER` and two checkboxes                                                  | third row and entry, with the custom-instance note                                                                                                                                                      |
| `sendToAgent/outOfTokens.logic.ts:32-36, 86-90`                        | `usageProviderOf` maps two drivers; limited windows are `session`, `weekly`, `fableWeekly`  | map `antigravity`; include group windows. Out of usage only when every group has a window at 100 % that has not reset: the thread's model group is unknown, so a limit on one group alone gives no hint |
| `settings/ProviderModelsSection.tsx:33-38`                             | custom-model placeholder per driver                                                         | add `antigravity` with a model id the CLI lists (read it from `agy models`, not guessed)                                                                                                                |
| `activity/activityPresentation.ts:245-251`                             | `PROVIDER_LABELS`                                                                           | add `antigravity: "Antigravity"`                                                                                                                                                                        |

Out of scope for this task and confirmed absent from the usage path: the
hermetic guard and `test_support` mentions of Antigravity concern the CLI's home
directory, not usage; `provider_inventory.rs`, `provider_runtime.rs` and
`control.rs` belong to other lanes and need no change here.

## Decision E: profiler, crash and trace coverage

- Child process. Both spawns (`--version`, `/usage`) go through
  `process::supervised::run_supervised`, which owns timeout, forced stop and
  reaping. They are short-lived and read-only, like the OpenCode probe, so they
  are not registered with `ProcessAttributionRegistry`. A spawn that dies
  unrequested surfaces as a failed fetch, not a `subprocess.crash`: the child is
  not a long-lived worker.
- RPC. `server.refreshProviderUsage` is already in `is_long_running`
  (`latency.rs:168`); the added 15 s ceiling and one more provider do not change
  that. `server.getProviderUsage` reads state only and stays out.
- Logging. Failures log through `tracing::warn!` with the failure class, never
  the CLI's output (it can name the account). No profiler event is added.
- Shutdown. No new service: the fetch is a request-scoped future, aborted with
  its caller by the existing refresh supervisor (`mod.rs:379-392`).
- Documentation. `docs/providers/antigravity.md` (phase 3, task 3.10) gains a
  "Usage in the status bar" paragraph; `docs/architecture/overview.md` names the
  new fetcher and the window groups in its provider usage section.

## Verification plan for task 3.12

- Parser tests (Rust, fixture anonymized, no plan name): the measured shape maps
  to four windows in two groups with the right minutes and rounded used
  percents; `command.name` other than `usage`, `num_turns` other than 0, `status`
  not `SUCCESS`, an unknown `window`, a non-finite fraction and a missing
  `groups` each give `unavailable` or a dropped bucket as decided; exit code 2
  gives the API-key message; a version below 1.1.11 or multi-line version output
  spawns no `/usage` (a fake binary records its argument list).
- Service tests: `min_interval` skips a throttled refresh and serves the cache,
  a forced refresh bypasses it, `read()` omits Antigravity until refreshed.
- Web tests: the item shows both groups with reset times; each message above
  renders for its snapshot; an unknown provider literal renders nothing; the
  out-of-usage hint needs every group limited.
- Mutation proof as in the task: let the parser accept any command name and see
  the tests fail.
- Live comparison against `agy -p "/usage"` at the end, recorded as percentages
  only.
