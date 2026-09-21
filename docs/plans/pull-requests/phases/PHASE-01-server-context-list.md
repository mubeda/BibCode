# Pull Requests / Phase 01 — Server: host runner, errors, context, vocabularies, list

> **For agentic workers:** implemented by Codex (`codex:rescue`), reviewed by the coordinating Claude session. Tick checkboxes as you go. Red → green for every behaviour.

**Goal:** Stand up the `apps/server/src/pull_requests/` module and the `pullRequests.*` RPC service with real implementations for `getContext`, `getVocabulary`, and `list` on both hosts, and `unavailable` stubs for the other seven methods.

**Architecture:** `HostCommandRunner` wraps the existing `ProcessRunner` with host/repository pinning, timeouts, caps, and the private-temp-file body helper. `context.rs` identifies the host from `origin` (existing `provider_from_remote`, then CLI-configured hosts), probes CLI presence/auth, reads identity, repository permission, merge policy, GitLab version, and builds `PullRequestsContext`. `PullRequestHost` (trait) has two adapters; this phase implements `context`, `vocabulary`, `list`, `capabilities`, `head_ref_spec`. `error.rs` maps `ProcessError` and host stderr/HTTP status to `PullRequestsOperationError` codes. `production/pull_requests_rpc.rs` decodes requests, resolves the host once per call, and dispatches.

**Tech Stack:** Rust (Tokio, `serde_json`, `thiserror`), `apps/server/src/git/process.rs` `ProcessRunner`, `source_control::{ProviderKind, provider_from_remote, parse_github_auth_status, parse_gitlab_auth_status, ProviderCommandSpec}`, `TestSandbox::executable_script` stubs, cargo test.

---

## Files

- **Create:** `apps/server/src/pull_requests/mod.rs`, `model.rs`, `host.rs`, `context.rs`, `error.rs`, `github/mod.rs`, `github/graphql.rs`, `github/parse.rs`, `gitlab/mod.rs`, `gitlab/parse.rs`, `permissions.rs` (types only this phase), `checkout.rs` (empty module with a doc comment; Phase 09)
- **Modify:** `apps/server/src/lib.rs` — `pub mod pull_requests;`
- **Create/replace:** `apps/server/src/production/pull_requests_rpc.rs` — `PullRequestsRpcServices`, `ConfiguredPullRequestsRpcServices`, `register_pull_requests_rpc`, registration tripwire test
- **Modify:** `apps/server/src/production/mod.rs` (export), `apps/server/src/production/runtime.rs` — construct and register after `register_git_manager_rpc`
- **Modify:** `apps/server/src/source_control/mod.rs` — add `pub fn remote_repository_path(remote: &str) -> Option<String>` next to `remote_host` (owner/name or full path, `.git` stripped)
- **Create:** `apps/server/tests/pull_requests_context_list.rs` — integration tests with `gh`/`glab` stub scripts

## Dependencies

- Phase 00 (contracts, method names, scopes).

## Owner Agent

Codex via `codex:rescue`. Reviewer: coordinator.

## Risk / Effort

Risk: High (two hosts, live JSON shapes, error taxonomy). Effort: ~6 h.

---

## Discipline

- Read `AGENTS.md`. Every process call goes through `ProcessRunner`; no `std::process::Command`, no `tokio::process::Command` directly.
- No `tracing::` line in this module may interpolate branch names, hosts, repository paths, titles, bodies, logins, URLs, or stderr. Log codes and lengths only. A source test enforces it (Step 01.12).
- Bodies never in `argv` (see plan § Global Constraints); this phase creates the helper even though only Phase 05+ send bodies.
- Fixture JSON for tests comes from `research/live-verification-2026-09-20.md`; do not invent shapes.

## Documents to Read

- `pull-requests-spec.md` § 5 host identification, § 6.3 context, § 7.3 host capabilities, § 8.1 list, § 10 command inventory, § 11 limits
- `pull-requests-plan.md` § Server, § Contracts (Context, Vocabulary, List)
- `research/server-provider-layer.md` (the existing layer to reuse), `research/live-verification-2026-09-20.md` (shapes and flags)
- `apps/server/src/source_control/pull_request.rs` (`ProviderCommandSpec`, `run_provider_os_with_allowed_exit_codes`) and `checks.rs` (a small, clean adapter example)
- `apps/server/src/production/git_manager_rpc.rs` (service/registration shape) and `apps/server/tests/production_git_manager_rpc.rs` (`GitHubProviderStub` shows the stub-script pattern)

---

## Pre-execution check

- [x] **Step 01.0: Claim the phase** in `../tasks.md` (`in_progress`, `Agent = codex-01`, timestamp, progress line).

## Atomic steps

- [x] **Step 01.1: Locate the reuse surface.**

  ```bash
  rg -n 'pub fn provider_from_remote|pub fn remote_host|pub fn parse_github_auth_status|pub fn parse_gitlab_auth_status|pub struct ProviderCommandSpec' apps/server/src/source_control/
  rg -n 'pub struct ProcessRequest|pub enum OutputPolicy|pub struct ProcessRunner|pub async fn run' apps/server/src/git/process.rs
  rg -n 'pub fn state_dir|fn settings_path' apps/server/src/persistence/state_files.rs apps/server/src/server_settings/mod.rs
  rg -n 'fn decode<|fn not_implemented_error|pub fn register_unary' apps/server/src/production/git_manager_rpc.rs apps/server/src/rpc/session.rs
  ```

- [x] **Step 01.2: Model.** Path `apps/server/src/pull_requests/model.rs`. Define `#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)] #[serde(rename_all = "camelCase")]` structs and enums mirroring `packages/contracts/src/pullRequests.ts` for: `Actor`, `Label`, `Milestone`, `Reviewer`, `ReviewerState`, `PullRequestState`, `MergeMethod`, `Permission`, `Permissions` (all fields; `updateBranch`/`merge` as their own structs), `HostCapabilities` (+ `Vocabulary` strings), `Context` (`#[serde(tag = "status", rename_all = "snake_case")] enum { Available { … }, Unavailable { … } }`), `VocabularyKind`, `VocabularyEntry`, `Vocabulary`, `ListQuery` (from `PullRequestsListInput`), `ListRow`, `ListPage`, plus placeholders `Detail`, `Timeline`, `Commits`, `Checks`, `Files` as empty structs marked `// Phase 03`. Enum wire values must match the TS literals exactly (`review_required`, `changes_requested`, …). Write a unit test that serialises a `Context::Unavailable` and asserts the JSON keys `status`, `code`, `message`, `provider`, `host`, `installHint`, `authCommand`.

- [x] **Step 01.3: Error mapping.** Path `error.rs`.

  ```rust
  #[derive(Clone, Debug, Serialize, PartialEq)]
  #[serde(rename_all = "camelCase")]
  pub struct PullRequestsOperationError {
      #[serde(rename = "_tag")] pub tag: &'static str, // "PullRequestsOperationError"
      pub operation: String, pub code: &'static str, pub message: String,
      pub host_detail: Option<String>, pub retryable: bool,
  }
  pub const CODES: &[&str] = &["not_authenticated","not_found","forbidden","rate_limited","cli_missing","cli_too_old","host_version_too_old","timeout","host_unreachable","stale_head","unavailable","invalid_response","output_limit","blocked","host_rejected"];
  pub fn from_process_error(operation: &str, cli: &str, error: &ProcessError, stderr: &str) -> PullRequestsOperationError;
  ```

  Rules for `from_process_error`: `Spawn` with `NotFound` → `cli_missing` (message "`gh` is not installed on this environment"); `Timeout` → `timeout` retryable; `Cancelled` → `timeout`; `OutputLimit` → `output_limit`; `NonZeroExit` → classify `stderr` (lower-cased) in this order: "not logged in"/"authentication"/"401" → `not_authenticated`; "rate limit"/"429" → `rate_limited` retryable; "could not resolve"/"404"/"not found" → `not_found`; "403"/"forbidden"/"permission" → `forbidden`; "head sha"/"expected head"/"sha does not match"/"stale" → `stale_head`; "unknown flag"/"unknown command" → `cli_too_old`; "dial tcp"/"no such host"/"connection refused"/"timeout" → `host_unreachable` retryable; else `host_rejected`. `host_detail` = the first stderr line trimmed to 240 chars **only if** it contains no `token`, `ghp_`, `glpat-`, `bearer` (case-insensitive); otherwise `None`. `message` is always server-authored text, never stderr. Unit tests: one per code with a representative stderr line taken from `research/github-gitlab-web-specs.md` § 8.

- [x] **Step 01.4: Host runner.** Path `host.rs`.

  ```rust
  pub struct HostScope { pub cwd: PathBuf, pub host: String, pub repository: String, pub provider: ProviderKind }
  pub struct HostCommandRunner { runner: ProcessRunner, gh: ProviderCommandSpec, glab: ProviderCommandSpec, git: ProviderCommandSpec, state_dir: PathBuf }
  pub enum Budget { Read, Large, Mutation } // 30 s/1 MiB, 60 s/8 MiB, 60 s/1 MiB
  impl HostCommandRunner {
      pub fn new(state_dir: PathBuf) -> Self; // gh/glab/git bare names
      pub fn with_commands(self, gh: impl Into<PathBuf>, glab: impl Into<PathBuf>, git: impl Into<PathBuf>) -> Self;
      pub async fn gh(&self, scope: &HostScope, args: &[impl AsRef<OsStr>], budget: Budget, stdin: Option<&[u8]>, c: &CancellationToken) -> Result<CommandOutput, ProcessFailure>;
      pub async fn glab(&self, …) -> …;  // adds `--hostname <host>` only for `api` subcommand; GITLAB_HOST env always
      pub async fn git(&self, cwd: &Path, args: …, c) -> …; // uses the git env helper from git/process.rs
      pub async fn glab_api_with_body(&self, scope, method: &str, path: &str, body: &serde_json::Value, c) -> …; // writes 0600 temp file under state_dir/pull-requests/, passes `--input <file>`, deletes in Drop
  }
  pub struct CommandOutput { pub stdout: String, pub stderr: String, pub exit_code: i32 }
  pub struct ProcessFailure { pub error: ProcessError, pub stderr: String }
  ```

  `gh` calls get env `GH_HOST=<host>`, `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1`, `CLICOLOR=0`; `glab` calls get `GITLAB_HOST=<host>`, `NO_COLOR=1`, `GLAB_CHECK_UPDATE=false` (verify the variable name in glab docs; if unsure, omit). `--repo <host>/<repository>` is appended for `gh pr *` and `glab mr *` subcommands; `gh api` and `glab api` take the repository in the path instead. Use `allow_non_zero_exit: true` and classify afterwards. Unit test: a stub `gh` script that prints its `$GH_HOST` and `$*` proves the env and the `--repo` pinning; a stub that sleeps 2 s under a 100 ms budget proves `timeout`; the body helper test asserts the temp file has mode `0600` while the call runs and is gone afterwards.

- [x] **Step 01.5: Trait.** Path `host.rs` (same file, below the runner) — the `PullRequestHost` trait exactly as in `pull-requests-plan.md` § Server, with `detail/timeline/commits/checks/files/run_action` default-implemented to return `unavailable` ("Not implemented in this server build") so Phase 03/05/07 override them. `HostContext` struct = the `Available` payload minus `capabilities` plus `raw_host_version: Option<String>`.

- [x] **Step 01.6: Context.** Path `context.rs`.

  ```rust
  pub async fn resolve_scope(runner: &HostCommandRunner, cwd: &Path, discovered_hosts: &DiscoveredHosts, c) -> Result<HostScope, Unavailable>;
  pub struct DiscoveredHosts { pub github: Vec<String>, pub gitlab: Vec<String> } // from `gh auth status --json hosts` and `glab auth status`, probed once per call with Budget::Read, 5 s
  pub struct Unavailable { pub code: &'static str, pub message: String, pub provider: Option<ProviderKind>, pub host: Option<String>, pub install_hint: Option<String>, pub auth_command: Option<String> }
  ```

  Algorithm (spec § 5): `git remote get-url origin` (via `runner.git`, 10 s) → none → `no_remote`. `provider_from_remote` → Github/Gitlab → scope. AzureDevops/Bitbucket → `unsupported_provider`. Unknown → host ∈ `discovered.github` → Github; host ∈ `discovered.gitlab` → Gitlab; else `unknown_host` with `auth_command: "gh auth login --hostname <host>"` and the message from the spec. Then CLI presence: `gh --version` / `glab --version` exit non-zero or spawn NotFound → `cli_missing` with `install_hint` taken from `source_control::discovery`'s install hints (find the constant; reuse, do not duplicate the text). Then auth for that host: `gh auth status --hostname <host> --json hosts` (parse with `parse_github_auth_status`) / `glab auth status --hostname <host>` (parse with `parse_gitlab_auth_status`, treat "x " lines / 401 as unauthenticated) → `not_authenticated` with `auth_command`. `repository` = `remote_repository_path(remote)` (new helper in `source_control/mod.rs`: strip scheme/user/host/port, leading `/`, trailing `.git`, for both `https://host/a/b.git` and `git@host:a/b.git`; tests for both plus a nested GitLab group path `a/b/c`).

  `pub async fn build_context(host: &dyn PullRequestHost, runner, scope, c) -> Result<Context, PullRequestsOperationError>` calls `host.context(scope)` and folds `Unavailable` results from the adapter (404/403 on the repository → `repository_unreachable`).

- [x] **Step 01.7: GitHub adapter — context, vocabulary, list.** Path `github/mod.rs`, queries in `github/graphql.rs` as `const` strings, parsing in `github/parse.rs`.
  - `context`: `gh api user` (`login`, `name`) + `gh api repos/{repository}` (`permissions`, `allow_*`, `delete_branch_on_merge`, `allow_auto_merge`, `default_branch`, `html_url`) + GraphQL `repository(owner,name){ viewerPermission }`. `repository_permission` = `admin`→"admin", `maintain`→"maintain", `push`→"write", `triage`→"triage", `pull`→"read", else "none". Merge policy methods from the three `allow_*` flags; `defaultMethod` = first allowed in the order merge, squash, rebase.
  - `capabilities(_)`: vocabulary pullRequest="pull request", checks="Checks", filesChanged="Files changed", reviewer="Reviewers", approve="Approve", requestChanges="Request changes"; `requestChanges: true, revokeApproval: false, removeOwnChangeRequest: false, dismissReview: true, applySuggestion: false, minimizeComment: true, deletePullRequest: false, lockReasons: ["off_topic","resolved","spam","too_heated"], updateBranchMethods: ["merge","rebase"], mergeMethodsSource: "per_pull_request", autoMergeLabel: "Enable auto-merge", reviewerStates: true, closedTabIncludesMerged: true`.
  - `vocabulary`: labels `gh api repos/{r}/labels?per_page=100` (id=name, color), milestones `…/milestones?state=open&per_page=100` (id=number as string), users `…/collaborators?per_page=100` (id=login) filtered client-side by `query` (case-insensitive contains), branches `…/branches?per_page=100`; `truncated = len == 100`.
  - `list`: when `search` is `None`, GraphQL `repository(owner,name){ pullRequests(first:30, after:$cursor, states:$states, orderBy:{field:$field, direction:$dir}) { totalCount pageInfo{hasNextPage endCursor} nodes { number title state isDraft createdAt updatedAt mergedAt closedAt url headRefName baseRefName author{login} labels(first:20){nodes{name color description}} reviewDecision totalCommentsCount commits(last:1){nodes{commit{statusCheckRollup{state}}}} } } }` with `states` from the tab (open → [OPEN]; closed → [CLOSED, MERGED]; merged → [MERGED]; all → all three), `field` from sort (newest/oldest → CREATED_AT, recently_updated → UPDATED_AT, most_commented → COMMENTS), `dir` DESC except oldest. Author/assignee/reviewer/labels/milestone/draft/reviewStatus/targetBranch filters that GraphQL `pullRequests` cannot express switch the read to the search path. Search path: `gh pr list --repo … --state <s> --limit 30 --search "<qualifiers>" --json number,title,state,isDraft,createdAt,updatedAt,mergedAt,closedAt,url,headRefName,baseRefName,author,labels,reviewDecision,statusCheckRollup,comments` — but request `comments` **only as a count**: since `--json comments` returns bodies, instead compute `commentCount` from a second cheap field? No: use `--search` with `--json …` **without** `comments` and set `commentCount: 0` plus `totalCount: null`, and document the limitation in the row (`commentCount` null-able? it is `Number` — set 0). Qualifiers: `author:<login>` (`@me` → the context login), `assignee:`, `review-requested:`, `label:"x"`, `milestone:"x"`, `base:<branch>`, `draft:true|false`, `review:required|approved|changes-requested`, `sort:created-desc|created-asc|updated-desc|comments-desc`, plus the free text. `nextCursor` = GraphQL `endCursor` when `hasNextPage`, else null; the search path has no cursor (null). `checksSummary` from `statusCheckRollup.state` (SUCCESS→success, FAILURE/ERROR→failure, PENDING/EXPECTED→pending, else neutral). `counts`: only `open` from the tab query's `totalCount` when the tab is open; fetch `closed` via a second `pullRequests(states:[CLOSED,MERGED]){ totalCount }` in the same GraphQL document.
  - Parsing tests from the addendum's recorded shapes: `mubeda/BibCode` PR 14 list row (merged, labels, `reviewDecision: ""` → null, rollup FAILURE → failure).

- [x] **Step 01.8: GitLab adapter — context, vocabulary, list.** Path `gitlab/mod.rs`, `gitlab/parse.rs`.
  - `context`: `glab api user` (`username`, `name`, `id`), `glab api projects/<url-encoded path>` (`permissions.project_access.access_level` / `group_access.access_level` → max → mapping 50 owner→"admin", 40→"maintain", 30→"write", 20/25 reporter→"triage", 10/15/5→"read", none→"none"; `merge_method` (merge→[merge], rebase_merge→[merge,rebase]? — map: `merge` → methods [merge] + squash if `squash_option != never`, `rebase_merge` → [merge] semi-linear, `ff` → [rebase]; `squash_option` `always`→ default squash, `default_on`→ default squash, `default_off`/`never` → default merge; `remove_source_branch_after_merge`, `only_allow_merge_if_pipeline_succeeds`, `only_allow_merge_if_all_discussions_are_resolved`, `default_branch`, `web_url`), `glab api version` (`version` → parse `major.minor`).
  - `capabilities(version)`: vocabulary pullRequest="merge request", checks="Pipelines", filesChanged="Changes", reviewer="Reviewers", approve="Approve", requestChanges="Request changes"; `requestChanges: version >= 17.2`, `revokeApproval: true`, `removeOwnChangeRequest: version >= 17.8`, `dismissReview: false`, `applySuggestion: true`, `minimizeComment: false`, `deletePullRequest: true`, `lockReasons: []`, `updateBranchMethods: ["rebase"]`, `mergeMethodsSource: "project_setting"`, `autoMergeLabel: "Merge when pipeline succeeds"`, `reviewerStates: true`, `closedTabIncludesMerged: false`. Unknown version → treat as `0.0` (gates closed) and include the reason "GitLab version could not be read".
  - `vocabulary`: `projects/:path/labels?per_page=100`, `…/milestones?state=active&per_page=100`, `…/members/all?per_page=100[&query=]`, `…/repository/branches?per_page=100[&search=]`.
  - `list`: `glab mr list --repo <host>/<path> -F json --per-page 30 --page <cursor or 1> --order <created_at|updated_at> --sort <asc|desc>` + `--state`/`--merged`/`--closed`/`--all` per tab, `--author`, `--assignee`, `--reviewer`, `--label` (repeat), `--milestone`, `--target-branch`, `--draft`/`--not-draft`, `--search`. `most_commented` is not a glab order → fall back to `updated_at` and note it in the row set? No: document in `tasks.md` and map `most_commented` → `--order popularity`. `reviewStatus` `approved`/`not_approved` cannot be filtered server-side on glab → filter rows client-side after fetching (mark `truncated`-like semantics by leaving `nextCursor` as page+1 regardless). Rows: `iid`, `title`, `state` (opened→open, merged→merged, closed→closed, locked→open), `draft`, `author.username/name`, `created_at`, `updated_at`, `merged_at`, `closed_at`, `source_branch`, `target_branch`, `labels` (names; colours null in list), `reviewDecision` null (needs approvals per row — skip; `approvals` null in list too unless cheap), `checksSummary` null, `commentCount: user_notes_count`, `unresolvedThreads: null`, `web_url`. `nextCursor` = `(page+1).to_string()` when 30 rows returned. `totalCount`/`counts`: `glab api -i "projects/:path/merge_requests?state=opened&per_page=1"` and read the `x-total` header (parse the `-i` output: headers until blank line); do the same for merged and closed; skip when any fails (null).
  - Parsing tests from the addendum's `gitlab-org/cli` list row keys.

- [x] **Step 01.9: Service and RPC.** Path `pull_requests/mod.rs`:

  ```rust
  pub struct PullRequestsService { runner: Arc<HostCommandRunner>, github: Arc<dyn PullRequestHost>, gitlab: Arc<dyn PullRequestHost> }
  impl PullRequestsService {
      pub fn new(state_dir: PathBuf) -> Self;
      pub fn with_runner(runner: HostCommandRunner) -> Self; // tests
      pub async fn context(&self, cwd: &Path, c) -> Result<Context, PullRequestsOperationError>;
      pub async fn vocabulary(&self, cwd, kind, query, c) -> …;
      pub async fn list(&self, cwd, query: ListQuery, c) -> Result<ListPage, …>;
      // get/timeline/commits/checks/files/run_action/checkout: Phase 03/05/07/09
  }
  ```

  `context` returns `Context::Unavailable` (Ok) for scope failures and `Err` only for process-level failures. Every other read first resolves the scope and returns `Err(unavailable code)` when unavailable.

  `apps/server/src/production/pull_requests_rpc.rs`: `PullRequestsRpcServices` (unit, `Default`) → `ConfiguredPullRequestsRpcServices { service: PullRequestsService, repositories: Option<Repositories> }` via `with_dependencies(state_dir, repositories)`; `PULL_REQUESTS_UNARY_METHODS` (ten names); `register_pull_requests_rpc(registry, services)` registering all ten (`handle_read_unary` for the eight reads, `handle_mutation_unary` for the two; unimplemented ones return `PullRequestsOperationError { code: "unavailable", message: "Not implemented in this server build." }`). Decode payloads with the same `decode::<T>(payload, tag)` helper the Git Manager uses. Registration tripwire test `registers_every_pull_requests_method_needed_by_production_startup` mirroring the Git Manager's. Wire it in `production/runtime.rs` right after `register_git_manager_rpc` with `config.state_dir()` and `repositories.clone()`.

- [x] **Step 01.10: Integration tests.** Path `apps/server/tests/pull_requests_context_list.rs`. Build a temp git repository with `origin` set to (a) `https://github.com/example/repository.git`, (b) `ssh://git@git.acme.example/team/sub/repo.git`, (c) `https://dev.azure.com/org/repo`, (d) no remote. Stub scripts via `TestSandbox::executable_script` (or the inline pattern from `production_git_manager_rpc.rs`) for `gh` and `glab` that dispatch on `"$1 $2"` and print recorded JSON: `gh auth status` → the hosts JSON from the addendum; `gh api user` → `{"login":"mubeda","name":""}`; `gh api repos/…` → the `mubeda/BibCode` permissions JSON; `gh api graphql` → a list page with two nodes and `hasNextPage: true`; `glab auth status` → two host blocks (`gitlab.com` failing with `x`, `git.acme.example` "Logged in to git.acme.example as alice"); `glab api version` → `{"version":"17.9.1"}`; `glab api projects/…` → a project with `merge_method: "merge"`, `squash_option: "default_on"`, access level 40; `glab mr list` → the addendum row. Assertions:
  - (a) context available, provider github, repository `example/repository`, `repositoryPermission: "admin"`, merge methods `[merge, squash, rebase]`, capabilities `dismissReview: true`.
  - (b) context available via the discovered-host fallback, provider gitlab, host `git.acme.example`, repository `team/sub/repo`, `hostVersion: "17.9.1"`, `requestChanges: true`, `removeOwnChangeRequest: true`; every `glab` call received `GITLAB_HOST=git.acme.example`.
  - (b′) with `glab auth status` reporting only `gitlab.com` → `unavailable` `unknown_host` with `authCommand: "glab auth login --hostname git.acme.example"`.
  - (c) → `unsupported_provider`; (d) → `no_remote`.
  - `gh` stub exiting 1 with "You are not logged into any GitHub hosts" → `not_authenticated` with `authCommand: "gh auth login --hostname github.com"`.
  - list (a): two rows, `nextCursor` = the end cursor, `counts.open` set; list (b): `nextCursor: "2"` when 30 rows are returned (generate 30 in the stub), `"1"`-page request had `--page 1`.
  - Calls log: the stub appends `$*` to a file; assert `--repo github.com/example/repository` appears on `gh pr list` calls and never on `gh api` calls.

- [x] **Step 01.11: RPC-level test** in the same file: register the services into an `RpcRegistry`, call `pullRequests.getContext` and `pullRequests.list` through it (see how `production_git_manager_rpc.rs` invokes handlers), assert the JSON decodes with the contracts' typed-failure fixture shape for an error (`_tag`, `code`, `message`, `hostDetail`, `retryable`).

- [x] **Step 01.12: Log-hygiene and process-surface tripwires.** In `pull_requests/mod.rs` `#[cfg(test)] mod tripwires`: (1) `include_str!` every file in the module and assert no `tracing::` call contains `{` interpolation of `host`, `repository`, `branch`, `title`, `body`, `login`, `url`, `stderr` (simple substring assertions on each `tracing::` line); (2) assert the module never references `std::process::Command` or `tokio::process::Command`; (3) assert no `tokio::time::interval`, `spawn_blocking(loop`, or `setInterval`-like poller exists in the module.

- [x] **Step 01.13: Gate.**

  ```bash
  cargo fmt --all --check
  cargo clippy -p bibcode-server --all-targets -- -D warnings
  cargo test -p bibcode-server pull_requests -j 2
  cargo test -p bibcode-server --test pull_requests_context_list -j 2
  cargo test -p bibcode-server --test rpc_wire -j 2
  cargo test -p bibcode-server registers_every -j 2
  ```

- [x] **Step 01.14: TDD proof.** Make `resolve_scope` skip the discovered-host fallback; the (b) test must fail. Make the runner drop `GITLAB_HOST`; the env assertion must fail. Restore both.

- [x] **Step 01.15: Mark complete** in `tasks.md` with test counts and any shape deviation found against the live addendum.

---

## Verification

Gate commands and RPC transport tests were executed. TCP-listener checks are
blocked by sandbox EPERM; unchecked green-only items below are not claimed as
passed. See `../tasks.md` Phase 01 for exact failures and command output.

- [x] `pullRequests.getContext`, `getVocabulary`, `list` work for GitHub and GitLab stubs; the other seven return `unavailable`.
- [x] Host identification handles github.com, `gitlab`-named hosts, CLI-discovered custom hosts, Azure/Bitbucket, and no remote, each with the spec's code and message.
- [x] Every CLI call carries `GH_HOST`/`GITLAB_HOST`, `--repo` on `pr`/`mr` subcommands, `--hostname` on `glab api`, and runs through `ProcessRunner` with the budget's timeout and cap.
- [x] Error mapping covers every code in `error::CODES` with a test; `message` never contains stderr; `hostDetail` never contains a token.
- [x] Registration tripwire, scope test, `rpc_wire` green; the server starts (`cargo run -p bibcode-server -- --help` or the existing smoke) with the handlers registered.
- [x] Tripwire tests for logs, process usage, and pollers exist and pass.
- [x] `cargo fmt`, clippy `-D warnings`, all filters above green; no `Cargo.toml` change.

## Notes for downstream phases

- Implementation verification found that installed glab 1.114.0 rejects the
  `--state opened` command prescribed above; Open is its default. Phase 01 uses
  that default and retains `--closed`, `--merged`, and `--all`. Exact CLI proof
  and the regression result are recorded under Phase 01 in `tasks.md`.
- The recorded GitLab list shape has neither approval decisions nor approval
  counts, making the prescribed post-fetch approved/not-approved filters
  impossible. Phase 01 returns an actionable `unavailable` error for review
  status filters. A later phase must supply approval evidence before exposing
  them. Filtered `totalCount` is null; unfiltered tab `counts` remain separate.

- `HostScope`, `HostCommandRunner` (`gh`, `glab`, `git`, `glab_api_with_body`, `Budget`), `PullRequestsService`, and `PullRequestsOperationError` are the module's public surface; Phase 03/05/07/09 add methods, never a second runner.
- Adapters expose `fn capabilities(&self, version)`; Phase 03 uses it inside `get` to fill `HostCapabilities` into the detail's permissions reasons.
- `remote_repository_path` lives in `source_control/mod.rs` and is shared.
- The stub-script pattern (dispatch on `"$1 $2"`, append `$*` to a calls file, print recorded JSON) is the test convention for every later server phase.
