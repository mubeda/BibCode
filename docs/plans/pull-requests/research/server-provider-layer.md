# Existing hosted source-control provider layer (server) — research map

Captured 2026-09-20 from the working tree at 15fabc78. Line numbers drift.

## 1. Provider detection

- `apps/server/src/source_control/mod.rs:24` — `enum ProviderKind { Github, Gitlab, AzureDevops, Bitbucket, Unknown }` (kebab-case wire form).
- `apps/server/src/source_control/mod.rs:34` — `struct ProviderInfo { kind, name, base_url }`.
- `apps/server/src/source_control/mod.rs:144` — `fn provider_from_remote(remote) -> ProviderInfo`: substring match on the `origin` URL: `github.com` → Github; `gitlab` anywhere in the host → Gitlab with `remote_host()`-derived base URL (self-hosted supported); `dev.azure.com`/`visualstudio.com` → AzureDevops; `bitbucket` → Bitbucket; else Unknown.
- `apps/server/src/source_control/mod.rs:195` — `fn remote_host(remote)` strips scheme/user-info/port/path (handles `ssh://`, `git@host:`, IPv6).
- Unavailable providers are data values, not exceptions: `ProviderKind::Unknown`/`Bitbucket` (CLI-only ops) → `SourceControlProviderError` detail "Pull-request resolution is unavailable for this provider." (`pull_request.rs:511`), `ProviderChecksResult::Unavailable` (`checks.rs:43`), or the `unavailable_pull_requests()` envelope (`git_manager_rpc.rs:960`).

## 2. CLI invocation / process supervision

- `apps/server/src/git/process.rs:114` — `ProcessRunner::run()/run_bytes()` → `run_supervised` (`apps/server/src/process/supervised.rs`) for timeout, output cap, cancellation.
- `apps/server/src/git/process.rs:21` — `ProcessRequest { operation, command, args, cwd, env, stdin, timeout, max_output_bytes, output_policy: OutputPolicy::{Truncate,Error}, append_truncation_marker, allow_non_zero_exit }`.
- `apps/server/src/git/process.rs:53` — `enum ProcessError { Spawn, Pipe, Read, Stdin, Timeout, Cancelled, OutputLimit, NonZeroExit, MissingExitCode, Wait }`.
- Working directory is `request.cwd`; env additive; PATH is the OS default (no lookup in ProcessRunner). A PATH-search helper exists for PTY spawns: `apps/server/src/process/executable.rs:231 locate_executable`.
- Timeouts/caps in `apps/server/src/source_control/pull_request.rs`: `resolve()` 30 s / 128 000 bytes / `OutputPolicy::Error` / `allow_non_zero_exit: true` (525-529); `run_provider_os_with_allowed_exit_codes()` 60 s / 128 000 (1021-1026); Bitbucket `git remote get-url origin` probe 10 s / 16 000 (751-753); discovery probes 5 s / 8 000 / Truncate (`discovery.rs:13-14`).
- `ProviderCommandSpec` (`pull_request.rs:19`) = `executable: PathBuf` + `prefix_args`; `PullRequestService::default()` (138) wires bare `gh`, `glab`, `az`; `with_provider_commands()` (155) substitutes absolute paths (tests).
- Bitbucket REST client (same file): `reqwest::Client::new()` (129); `BITBUCKET_REQUEST_TIMEOUT` 30 s wall-clock via `timeout_at` covering send + streamed body (790-848, 871-973); `BITBUCKET_RESPONSE_LIMIT` 1 MiB via Content-Length pre-check and running counter; `BITBUCKET_MAX_PAGES` 100; credentials from `BIBCODE_BITBUCKET_ACCESS_TOKEN` or `BIBCODE_BITBUCKET_EMAIL`/`BIBCODE_BITBUCKET_API_TOKEN`; base URL `BIBCODE_BITBUCKET_API_BASE_URL`.

## 3. Existing PR/MR operations (`PullRequestService`)

- Resolve current PR for branch — `resolve_current_optional()` (226) / `resolve_current()` (203):
  - GitHub: `gh pr list --head <branch> --state open --limit 1 --json number,title,url,baseRefName,headRefName,state`
  - GitLab: `glab mr list --source-branch <branch> --state opened --output json`
  - Azure: `az repos pr list --only-show-errors --detect true --source-branch refs/heads/<branch> --status active --top 1 --output json`
  - Bitbucket: REST `GET .../pullrequests?q=source.branch.name="<branch>" AND state="OPEN"&pagelen=1`, paginated, origin-pinned (`urls_have_same_origin`, 1337).
- Resolve explicit PR by number/URL — `resolve()` (455): `gh pr view <ref> --json number,title,url,baseRefName,headRefName,state`; `glab mr view <ref> --output json`; `az repos pr show --id <ref> --output json`; Bitbucket GET by number (`normalize_pull_request_number`, 1326).
- Create PR — `create()` (348): `gh pr create --base --head --title --body` (URL parsed by `parse_github_create_output`, 1261); GitLab `glab api --method POST projects/:fullpath/merge_requests --raw-field source_branch=… target_branch=… title=… description=…`; Azure `az repos pr create …`; Bitbucket REST POST.
- Checks (GitHub only) — `apps/server/src/source_control/checks.rs:35 read_checks()` runs `gh pr view <number> --json statusCheckRollup` (never `gh pr checks`, see file header comment); `aggregate_github_checks` (105) replicates gh's `pkg/cmd/pr/checks/aggregate.go` folding. Non-GitHub → `ProviderChecksResult::Unavailable` without spawning.
- Open PR in browser — no server RPC; the client opens the URL from `GitRunStackedActionToastCta` `open_pr {label,url}` (`packages/contracts/src/git.ts:64`).
- Checkout PR branch locally — RPC `git.preparePullRequestThread` (`apps/server/src/production/git_vcs.rs:587`, handler `resolve_pull_request_preparation` 1492): resolves PR then `repository.switch_ref(cwd, branch, token)` (plain checkout, current working copy). Only `mode: "local"` exists server-side (`GitPreparePullRequestThreadMode = Schema.Literal("local")`, `git.ts:59`). `apps/web/src/components/PullRequestThreadDialog.tsx` also offers `"worktree"` but composes it client-side from worktree primitives.
- Standalone resolve RPC — `git.resolvePullRequest` (`git_vcs.rs:849`, handler 1455).
- Git Manager pane — `gitManager.listPullRequests` (`apps/server/src/production/git_manager_rpc.rs:876`): reads `summary.source_control_provider`/`ref_name` from `GitRepository::summary_status`; `unavailable` for Bitbucket/Unknown/no-ref; else `resolve_current_optional` + `read_checks`; returns `{ status: "available"|"unavailable", pullRequests: [...], checks: [...] }` built ad hoc with `json!` (942).
- Create PR via stacked action — `git.runStackedAction` `create_pr`/`commit_push_pr` (`git_vcs.rs` ~2145-2211): `resolve_open_pull_request` (2238) first, then derives title and calls `pull_requests.create` (2196). No standalone create RPC.
- Adjacent: `sourceControl.lookupRepository` (1520: `gh repo view … --json nameWithOwner,url,sshUrl` / `glab repo view … --output json`), `sourceControl.publishRepository` (1597: `gh repo create … --source . --remote=<name>`).
- Errors: `pull_request.rs:99 SourceControlProviderError { tag, provider, operation, cwd, command, reference, detail }` (helpers `operation_error` 1405, `provider_error` 1387, `bitbucket_deadline_error` 1424, `bitbucket_response_limit_error` 1443). Contracts: `packages/contracts/src/sourceControl.ts:153 SourceControlProviderError` (TaggedError), `:171 SourceControlRepositoryError`.

## 4. Data shapes

| Concept               | Rust                                                                                      | Contracts                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Provider kind         | `source_control/mod.rs:24 ProviderKind`                                                   | `sourceControl.ts:5 SourceControlProviderKind`                              |
| Provider identity     | `source_control/mod.rs:34 ProviderInfo`; `git/model.rs:59 SourceControlProviderInfo`      | `sourceControl.ts:14 SourceControlProviderInfo`                             |
| Resolved PR           | `pull_request.rs:73 ResolvedPullRequest {number,title,url,base_branch,head_branch,state}` | `git.ts:97 GitResolvedPullRequest`; `git.ts:313/318` results                |
| PR state              | `pull_request.rs:65 ChangeRequestState {Open,Closed,Merged}`                              | `sourceControl.ts:21`, `git.ts:47 GitPullRequestState`, `gitManager.ts:472` |
| Pane PR row           | ad hoc JSON (`git_manager_rpc.rs:942`)                                                    | `gitManager.ts:466 GitManagerPullRequestEntry`                              |
| Check entry           | `checks.rs:21 ProviderCheck {name,state,link,workflow}`                                   | `gitManager.ts:476 GitManagerCheckEntry`                                    |
| Pane result           | ad hoc                                                                                    | `gitManager.ts:484 GitManagerPullRequestsResult`                            |
| Auth status           | `discovery.rs:77 AuthStatus`, `:84 SourceControlProviderAuth`                             | `sourceControl.ts:109/116`                                                  |
| Discovery             | `discovery.rs:93/64/107`                                                                  | `sourceControl.ts:140/133/147`                                              |
| Status change request | `git/summary.rs`                                                                          | `git.ts:232 VcsStatusChangeRequest`                                         |
| Stacked actions       | string match in `git_vcs.rs`                                                              | `git.ts:11 GitStackedAction`, `:64 GitRunStackedActionToastCta`             |

## 5. Settings → Source Control discovery

- RPC `server.discoverSourceControl` (`git_vcs.rs:854`), `EmptyInput`, calls `SourceControlDiscovery::discover(PathBuf::from("."), &cancellation)` (`git_vcs.rs:346`).
- `apps/server/src/source_control/discovery.rs:182 discover()` probes `VCS_PROBES` (`git --version`, `jj --version`; 130) and `PROVIDER_PROBES` (149): `gh --version` + `gh auth status --json hosts`; `glab --version` + `glab auth status`; `az version` + `az account show --output json`. Bitbucket appended statically as Missing (246).
- Auth parsing: `parse_auth()` (300) → `parse_github_auth_status()`/`parse_gitlab_auth_status()` (`source_control/mod.rs:71/107`).
- No server-side cache; every call re-probes. Rescan = re-invoke (`apps/web/src/components/settings/SourceControlSettings.tsx:457 handleScan`). Probes run with `cwd="."` (server process cwd), never the project path.
- Settings persistence: `apps/server/src/server_settings/mod.rs` single document (`ServerSettingsPatch`, 201) persisted to JSON at `settings_path()` (276) via `write_json_atomically`; per environment (server instance), fetched by `useEnvironmentQuery` (`apps/web/src/state/query.ts:26`).
- Existing toggle precedent: `ProvidersState`/`ProviderBinarySettingsState` (`server_settings/mod.rs:15-72`) `{enabled, binary_path, server_url, server_password}` with `with_defaults()`; `ProviderInstanceState` (88) in a `BTreeMap` with `enabled`, `environment`, `config`. Source-control providers have no settings toggle or binary path override today.

## 6. Auth/trust

- `apps/server/src/auth/scope.rs:11 required_scope(method)` maps every RPC to one scope (`auth/model.rs:3-9`: `orchestration:read`, `orchestration:operate`, `terminal:operate`, `review:write`, `access:read`, `access:write`, `relay:read`, `relay:write`). `server.discoverSourceControl`, `gitManager.listPullRequests`, `sourceControl.lookupRepository` → read; `git.resolvePullRequest`, `git.preparePullRequestThread`, `sourceControl.publishRepository`, `server.updateSettings` → operate. Test at `scope.rs:165` asserts every method has exactly one scope.
- Coarse session/device scopes, not per-user roles; no per-repository permission model.
- Environment scoping: every source-control RPC is routed by `environmentId`; the provider CLIs run as children of the server process owning that environment, i.e. on the remote host for remote environments.

## 7. Tests

- Unit: `source_control/mod.rs:214-267`; `discovery.rs:373-479`; `checks.rs:184-435` (rollup parsing, no-background-process, unsupported providers don't spawn); `pull_request.rs:1459+` (~1550 lines: all four providers, pagination, stalled servers, response limit, same-origin guard); `git/summary.rs:816-1339`; `git/manager/mod.rs:456,481` (no timer/process on construction; explicit checks handler is the only non-git process surface).
- Integration: `apps/server/tests/production_git_manager_rpc.rs:358-383`, `apps/server/tests/git_rpc.rs:283-290` with `PullRequestService::with_provider_commands(...)` pointing at fixture scripts.
- Stub injection: `apps/server/src/test_support/sandbox.rs:196-223 TestSandbox::executable_script(name, unix_body, windows_body)` writes an executable script and returns its absolute path; injected via `with_provider_commands` (not PATH).

## 8. Exists vs. does not exist

Exists (partial): single-PR resolve (current branch or explicit ref); create PR only inside `git.runStackedAction`; GitHub-only checks for the resolved PR; local checkout of the PR head (`mode: "local"`); repo lookup/publish; discovery in Settings; display-only MR-merged badges (`ThreadStatusIndicators.tsx`).

Does not exist: listing many PRs with filters; review/approve/request-changes/comment; merge; PR diff (hosted); PR comments/threads; GitLab/Azure checks; Bitbucket beyond resolve/create; standalone create-PR RPC; server-side worktree PR checkout; any settings toggle or binary path override for gh/glab/az; caching of discovery; per-user permission model.
