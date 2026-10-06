# Create Pull/Merge Request Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The shared create dialog sets draft, assignees, reviewers, labels and milestone on GitHub and GitLab, plus delete-source-branch and squash on GitLab, at creation time.

**Architecture:** Options travel with the existing `git.runStackedAction` create step (`pullRequestOptions`) into `PullRequestService::create_with_options`, which adds `gh pr create` flags or sends GitLab one JSON body. A new read `pullRequests.getCreateDefaults` supplies the current user and GitLab's project merge defaults. A `pullRequestCreateOptions` capability hides the fields on older servers.

**Tech Stack:** Rust (Tokio, serde), TypeScript (Effect Schema, React, Base UI combobox), Vitest via `vp`, cargo tests.

**Spec:** `docs/superpowers/specs/2026-10-06-mr-create-options-design.md`

## Global Constraints

- Bounds: at most 20 assignees, 20 reviewers, 50 labels; every id and title is a trimmed non-empty string of at most 255 characters.
- GitLab: one assignee and one reviewer (single pickers); GitHub: several.
- Merge options (`removeSourceBranch`, `squash`) exist only for GitLab; the server refuses them for any other provider before anything is pushed.
- Draft on GitLab = `Draft: ` title prefix, added only when the title does not already start (case-insensitively) with `draft:`, `[draft]` or `(draft)`.
- Without capability `pullRequestCreateOptions` the dialog renders no new field and sends no `pullRequestOptions`.
- Requests without options keep today's provider commands byte for byte.
- Run gates serialized: `node scripts/run-local-vp.mjs …` (vp is not on PATH); cargo commands one at a time.
- Before every commit: run `codex review --uncommitted` (detached: `setsid nohup bash -c "timeout 1500 codex review --uncommitted > LOG 2>&1; echo exit=\$? >> LOG" &`), evaluate findings with `superpowers:receiving-code-review`, fix what holds up.

## Review Focus

1. A request whose title already says `Draft:` with Draft checked must not become `Draft: Draft: …` (Task 2 test `gitlab_draft_title_is_added_once`).
2. A GitHub repository with merge options in the payload (stale dialog after a provider change) must be refused before any push, not after (Task 2 test `merge_options_are_refused_for_github_before_publication`).
3. `gh pr create` exiting 1 after creating the PR must report `created` with a warning and never retry into a duplicate (Task 2 test `github_failure_with_url_is_created_with_warning`).
4. An open request already existing for the branch must not silently drop the chosen options (Task 2 test `existing_request_reports_options_not_applied`).
5. A picker whose vocabulary read fails must leave Create enabled (Task 4 test `a failed picker keeps creation available`).

---

### Task 1: `pullRequests.getCreateDefaults` read

**Files:**
- Modify: `packages/contracts/src/pullRequests.ts` (after `PullRequestsVocabulary`, ~line 211)
- Modify: `packages/contracts/src/rpc.ts` (`WS_METHODS` ~line 466, Rpc defs ~line 1284, group ~line 1760)
- Test: `packages/contracts/src/pullRequests.test.ts`
- Modify: `apps/server/src/pull_requests/model.rs` (after `Vocabulary`, ~line 286)
- Modify: `apps/server/src/pull_requests/host.rs` (trait `PullRequestHost`, ~line 477)
- Modify: `apps/server/src/pull_requests/github/mod.rs` (impl at ~line 176; operation list ~line 60)
- Modify: `apps/server/src/pull_requests/gitlab/mod.rs` (impl at ~line 209; operation list ~line 98)
- Modify: `apps/server/src/pull_requests/gitlab/parse.rs`
- Modify: `apps/server/src/pull_requests/mod.rs` (after `vocabulary`, ~line 170)
- Modify: `apps/server/src/production/pull_requests_rpc.rs` (method list line 22, dispatch ~line 129)
- Modify: `apps/server/src/rpc/methods.rs` (~line 118), `apps/server/src/auth/scope.rs` (~lines 32 and 244)
- Modify: `packages/contracts/scripts/export-rust-rpc-fixtures.ts`, `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`, `apps/server/tests/rpc_wire.rs` (pinned counts); regenerated `packages/contracts/fixtures/rpc-wire/**`

**Interfaces:**
- Produces (TS): `PullRequestsCreateDefaults = { viewer: { id: string; label: string } | null; squash: "never" | "always" | "default_on" | "default_off" | null; removeSourceBranch: boolean | null }`; `WS_METHODS.pullRequestsGetCreateDefaults = "pullRequests.getCreateDefaults"` with payload `PullRequestsCwdInput`.
- Produces (Rust): `pull_requests::model::{CreateDefaults, ViewerRef}`; `PullRequestsService::create_defaults(&self, cwd: &Path, c: &CancellationToken) -> Result<CreateDefaults, PullRequestsOperationError>`.

- [ ] **Step 1: Write the failing contract test** in `packages/contracts/src/pullRequests.test.ts`:

```ts
describe("PullRequestsCreateDefaults", () => {
  it("decodes GitLab defaults and GitHub's empty merge settings", () => {
    const decode = Schema.decodeUnknownSync(PullRequestsCreateDefaults);
    expect(
      decode({ viewer: { id: "7", label: "alice" }, squash: "default_on", removeSourceBranch: true }),
    ).toEqual({ viewer: { id: "7", label: "alice" }, squash: "default_on", removeSourceBranch: true });
    expect(decode({ viewer: { id: "octo", label: "octo" }, squash: null, removeSourceBranch: null }))
      .toEqual({ viewer: { id: "octo", label: "octo" }, squash: null, removeSourceBranch: null });
    expect(() => decode({ viewer: null, squash: "sometimes", removeSourceBranch: null })).toThrow();
  });
});
```

(Import `PullRequestsCreateDefaults` from `./pullRequests.ts` and `Schema` from `effect/Schema` if the file does not already.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/contracts && node ../../scripts/run-local-vp.mjs test run src/pullRequests.test.ts`
Expected: FAIL — `PullRequestsCreateDefaults` is not exported.

- [ ] **Step 3: Add the schema and RPC**

In `pullRequests.ts` after `PullRequestsVocabulary`:

```ts
export const PullRequestsSquashOption = Schema.Literals([
  "never",
  "always",
  "default_on",
  "default_off",
]);
export type PullRequestsSquashOption = typeof PullRequestsSquashOption.Type;

/** What the create dialog prefills: the viewer for "Assign to me" and GitLab's merge defaults. */
export const PullRequestsCreateDefaults = Schema.Struct({
  viewer: Schema.NullOr(
    Schema.Struct({ id: TrimmedNonEmptyStringSchema, label: TrimmedNonEmptyStringSchema }),
  ),
  squash: Schema.NullOr(PullRequestsSquashOption),
  removeSourceBranch: Schema.NullOr(Schema.Boolean),
});
export type PullRequestsCreateDefaults = typeof PullRequestsCreateDefaults.Type;
```

In `rpc.ts`: add `pullRequestsGetCreateDefaults: "pullRequests.getCreateDefaults",` after `pullRequestsGetVocabulary`; import `PullRequestsCwdInput` and `PullRequestsCreateDefaults`; after `WsPullRequestsGetVocabularyRpc`:

```ts
export const WsPullRequestsGetCreateDefaultsRpc = Rpc.make(
  WS_METHODS.pullRequestsGetCreateDefaults,
  {
    payload: PullRequestsCwdInput,
    success: PullRequestsCreateDefaults,
    error: PullRequestsOperationError,
  },
);
```

and add `WsPullRequestsGetCreateDefaultsRpc,` after `WsPullRequestsGetVocabularyRpc,` in the group.

- [ ] **Step 4: Run the contract test** — same command; Expected: PASS.

- [ ] **Step 5: Write the failing server parse test** in `apps/server/src/pull_requests/gitlab/parse.rs` tests module (create `#[cfg(test)] mod create_defaults_tests` at the end if no tests module exists):

```rust
#[cfg(test)]
mod create_defaults_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn gitlab_defaults_carry_the_numeric_viewer_and_project_merge_settings() {
        let user = json!({"id": 7, "username": "alice"});
        let project = json!({"squash_option": "default_on", "remove_source_branch_after_merge": true});
        let defaults = create_defaults(&user, &project, "pullRequests.getCreateDefaults").unwrap();
        assert_eq!(defaults.viewer, Some(ViewerRef { id: "7".into(), label: "alice".into() }));
        assert_eq!(defaults.squash.as_deref(), Some("default_on"));
        assert_eq!(defaults.remove_source_branch, Some(true));
    }

    #[test]
    fn unknown_squash_values_are_dropped() {
        let user = json!({"id": 7, "username": "alice"});
        let project = json!({"squash_option": "sometimes"});
        let defaults = create_defaults(&user, &project, "pullRequests.getCreateDefaults").unwrap();
        assert_eq!(defaults.squash, None);
        assert_eq!(defaults.remove_source_branch, None);
    }
}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cargo test -p bibcode-server --lib create_defaults_tests`
Expected: FAIL to compile — `create_defaults`, `ViewerRef` missing.

- [ ] **Step 7: Implement model, parse, trait, adapters, service, RPC**

`model.rs` after `Vocabulary`:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ViewerRef {
    pub id: String,
    pub label: String,
}

/// Prefill for the create dialog; GitHub has no per-request merge settings.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateDefaults {
    pub viewer: Option<ViewerRef>,
    pub squash: Option<String>,
    pub remove_source_branch: Option<bool>,
}
```

`gitlab/parse.rs` (import `CreateDefaults, ViewerRef` from the model module the file already imports from):

```rust
pub(super) fn create_defaults(
    user: &Value,
    project: &Value,
    operation: &str,
) -> Result<CreateDefaults, PullRequestsOperationError> {
    let id = user["id"].as_u64().ok_or_else(|| invalid(operation))?.to_string();
    let label = string(user, "username", operation)?;
    let squash = project["squash_option"]
        .as_str()
        .filter(|option| matches!(*option, "never" | "always" | "default_on" | "default_off"))
        .map(str::to_owned);
    Ok(CreateDefaults {
        viewer: Some(ViewerRef { id, label }),
        squash,
        remove_source_branch: project["remove_source_branch_after_merge"].as_bool(),
    })
}
```

`host.rs` trait `PullRequestHost`, after `vocabulary`:

```rust
    /// Hosts without per-request defaults return none.
    fn create_defaults<'a>(
        &'a self,
        _scope: &'a HostScope,
        _c: &'a CancellationToken,
    ) -> HostFuture<'a, CreateDefaults> {
        Box::pin(async { Ok(CreateDefaults::default()) })
    }
```

`github/mod.rs` impl (GitHub vocabulary user ids are logins):

```rust
    fn create_defaults<'a>(
        &'a self,
        scope: &'a HostScope,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, CreateDefaults> {
        Box::pin(async move {
            let operation = "pullRequests.getCreateDefaults";
            let user = self.api(scope, "user", operation, c).await?;
            let login = parse::string(&user, "login", operation)?;
            Ok(CreateDefaults {
                viewer: Some(ViewerRef { id: login.clone(), label: login }),
                squash: None,
                remove_source_branch: None,
            })
        })
    }
```

`gitlab/mod.rs` impl:

```rust
    fn create_defaults<'a>(
        &'a self,
        scope: &'a HostScope,
        c: &'a CancellationToken,
    ) -> HostFuture<'a, CreateDefaults> {
        Box::pin(async move {
            let operation = "pullRequests.getCreateDefaults";
            let project = project_path(scope);
            let (user, project) = tokio::join!(
                self.api(scope, "user", operation, c),
                self.api(scope, &project, operation, c),
            );
            parse::create_defaults(&user?, &project?, operation)
        })
    }
```

In both adapters, add `"pullRequests.getCreateDefaults"` next to `"pullRequests.getVocabulary"` in the operation match at github/mod.rs ~line 60 and gitlab/mod.rs ~line 98.

`pull_requests/mod.rs` after `vocabulary`:

```rust
    pub async fn create_defaults(
        &self,
        cwd: &Path,
        c: &CancellationToken,
    ) -> Result<CreateDefaults, PullRequestsOperationError> {
        bounded_read(
            "pullRequests.getCreateDefaults",
            Duration::from_secs(30),
            c,
            |c| async move {
                let scope = resolve_scope(&self.runner, cwd, &DiscoveredHosts::default(), &c)
                    .await
                    .map_err(|u| u.operation_error("pullRequests.getCreateDefaults"))?;
                self.host(&scope).create_defaults(&scope, &c).await
            },
        )
        .await
        .inspect_err(|error| self.invalidate_failed_context(error))
    }
```

`pull_requests_rpc.rs`: add `"pullRequests.getCreateDefaults",` after `"pullRequests.getVocabulary",` in `PULL_REQUESTS_UNARY_METHODS`; add next to `VocabularyInput`:

```rust
#[derive(Deserialize)]
struct CwdOnlyInput {
    cwd: PathBuf,
}
```

and a dispatch arm after `"pullRequests.getVocabulary"`:

```rust
            "pullRequests.getCreateDefaults" => {
                let input: CwdOnlyInput = decode(request.payload, operation)?;
                validate_cwd(&input.cwd, operation)?;
                encode(
                    self.service.create_defaults(&input.cwd, &cancellation).await,
                    operation,
                )
            }
```

`rpc/methods.rs`: `read_unary("pullRequests.getCreateDefaults"),` after the getVocabulary entry (and in the list near line 213 if that list enumerates Pull Requests methods). `auth/scope.rs`: add `| "pullRequests.getCreateDefaults"` after `| "pullRequests.getVocabulary"` (line ~32) and `"pullRequests.getCreateDefaults",` to the test list (~line 244).

- [ ] **Step 8: Run the server tests**

Run: `cargo test -p bibcode-server --lib create_defaults_tests` then `cargo test -p bibcode-server --lib every_active_rpc_method_has_exactly_one_declared_scope`
Expected: PASS both.

- [ ] **Step 9: Regenerate fixtures and pinned counts**

Run: `node scripts/run-local-vp.mjs run check:contracts`. It fails on pinned counts. Update, in `packages/contracts/scripts/export-rust-rpc-fixtures.ts` (lines ~966-984), `export-rust-rpc-fixtures.test.ts` (lines ~101-124) and `apps/server/tests/rpc_wire.rs` (~lines 92 and 102), each pinned number to the value the failure reports: expected methods 139→140, typed failure fixtures 306→307, fixtures 413→414, schema fingerprints 377→378. Re-run until the only failing step is the final fixture diff, then confirm `git status --short packages/contracts/fixtures` shows only `pullRequests__getCreateDefaults` additions and the manifest.

- [ ] **Step 10: Commit** (after the Codex review step from Global Constraints)

```bash
git add packages/contracts apps/server/src/pull_requests apps/server/src/production/pull_requests_rpc.rs apps/server/src/rpc/methods.rs apps/server/src/auth/scope.rs apps/server/tests/rpc_wire.rs
git commit -m "feat(pull-requests): read create defaults for the request dialog"
```

---

### Task 2: Create options on the server path

**Files:**
- Modify: `packages/contracts/src/git.ts` (`GitRunStackedActionInput` ~line 131, result `pr` ~line 366), `packages/contracts/src/environment.ts` (~line 68), `packages/shared/src/testSupport.ts`
- Test: `packages/contracts/src/git.test.ts`
- Modify: `apps/server/src/source_control/pull_request.rs` (types ~line 90, `create` ~line 395, invocation ~line 1068)
- Modify: `apps/server/src/production/git_vcs.rs` (input ~2205, step details ~2240, validation ~2279, provider resolution ~2510, existing ~2672, create ~2709)
- Modify: `apps/server/src/lifecycle.rs` (~line 66), `apps/server/src/production/control.rs` (~line 2423) and their descriptor asserts
- Regenerated fixtures as in Task 1 Step 9 (fingerprints change; counts unchanged).

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (TS): `GitPullRequestCreateOptions = { draft: boolean; assignees: string[]; reviewers: string[]; labels: string[]; milestone: { id: string; title: string } | null; removeSourceBranch: boolean | null; squash: boolean | null }`; `GitRunStackedActionInput.pullRequestOptions?`; `GitRunStackedActionResult["pr"].warning?: string`; capability `pullRequestCreateOptions: boolean`.
- Produces (Rust): `source_control::{CreatePullRequestOptions, MilestoneRef, CreatedPullRequest}`; `PullRequestService::create_with_options(&self, input: CreatePullRequestInput, options: &CreatePullRequestOptions, c: &CancellationToken) -> Result<CreatedPullRequest, SourceControlProviderError>`.

- [ ] **Step 1: Write the failing contract tests** in `packages/contracts/src/git.test.ts`:

```ts
describe("GitRunStackedActionInput pullRequestOptions", () => {
  const decode = Schema.decodeUnknownSync(GitRunStackedActionInput);
  const base = { actionId: "a", cwd: "/repo", action: "create_pr", pullRequestBaseBranch: "main" };
  const options = {
    draft: true,
    assignees: ["7"],
    reviewers: [],
    labels: ["bug"],
    milestone: { id: "3", title: "Sprint 9" },
    removeSourceBranch: true,
    squash: null,
  };
  it("accepts reviewed options", () => {
    expect(decode({ ...base, pullRequestOptions: options }).pullRequestOptions).toEqual(options);
  });
  it("caps assignees at 20 and labels at 50", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
    expect(() => decode({ ...base, pullRequestOptions: { ...options, assignees: ids(21) } })).toThrow();
    expect(() => decode({ ...base, pullRequestOptions: { ...options, labels: ids(51) } })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/contracts && node ../../scripts/run-local-vp.mjs test run src/git.test.ts`; Expected: FAIL (option dropped or unknown).

- [ ] **Step 3: Add the contract schemas**

In `git.ts` before `GitRunStackedActionInput`:

```ts
const CreateOptionId = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(255));
/** Reviewed create-time options; merge options apply to GitLab only. */
export const GitPullRequestCreateOptions = Schema.Struct({
  draft: Schema.Boolean,
  assignees: Schema.Array(CreateOptionId).check(Schema.isMaxLength(20)),
  reviewers: Schema.Array(CreateOptionId).check(Schema.isMaxLength(20)),
  labels: Schema.Array(CreateOptionId).check(Schema.isMaxLength(50)),
  milestone: Schema.NullOr(Schema.Struct({ id: CreateOptionId, title: CreateOptionId })),
  removeSourceBranch: Schema.NullOr(Schema.Boolean),
  squash: Schema.NullOr(Schema.Boolean),
});
export type GitPullRequestCreateOptions = typeof GitPullRequestCreateOptions.Type;
```

Add to `GitRunStackedActionInput` after `pullRequestHeadBranch`:

```ts
  /** Create-time options; requires capability `pullRequestCreateOptions`. */
  pullRequestOptions: Schema.optional(GitPullRequestCreateOptions),
```

Add to the result's `pr` struct after `title`:

```ts
    /** The request exists, but some chosen options were not applied. */
    warning: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000))),
```

`environment.ts` after `terminalImagePaste`:

```ts
  /** `git.runStackedAction` accepts `pullRequestOptions` and reports `pr.warning`. */
  pullRequestCreateOptions: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
```

`packages/shared/src/testSupport.ts`: add `pullRequestCreateOptions: false,` after `terminalImagePaste: false,`.

- [ ] **Step 4: Run the contract tests** — Expected: PASS.

- [ ] **Step 5: Write the failing server unit tests** at the end of the tests module in `apps/server/src/source_control/pull_request.rs`:

```rust
    fn options() -> CreatePullRequestOptions {
        CreatePullRequestOptions {
            draft: true,
            assignees: vec!["7".into()],
            reviewers: vec!["9".into()],
            labels: vec!["bug".into(), "ui".into()],
            milestone: Some(MilestoneRef { id: "3".into(), title: "Sprint 9".into() }),
            remove_source_branch: Some(true),
            squash: Some(false),
        }
    }

    fn input(title: &str) -> CreatePullRequestInput {
        CreatePullRequestInput {
            cwd: PathBuf::from("/repo"),
            provider: ProviderKind::Gitlab,
            base_branch: "main".into(),
            head_branch: "feature".into(),
            title: title.into(),
            body: "Body".into(),
        }
    }

    #[test]
    fn github_create_args_repeat_each_option_flag() {
        let mut github = input("Add grid");
        github.provider = ProviderKind::Github;
        let args = github_create_args(&github, &CreatePullRequestOptions {
            remove_source_branch: None,
            squash: None,
            assignees: vec!["octo".into(), "cat".into()],
            ..options()
        });
        let args: Vec<String> = args.into_iter().map(|a| a.into_string().unwrap()).collect();
        assert_eq!(args, [
            "pr", "create", "--base", "main", "--head", "feature", "--title", "Add grid",
            "--body", "Body", "--draft", "--assignee", "octo", "--assignee", "cat",
            "--reviewer", "9", "--label", "bug", "--label", "ui", "--milestone", "Sprint 9",
        ]);
    }

    #[test]
    fn gitlab_body_carries_ids_labels_milestone_and_merge_options() {
        let body = gitlab_create_body(&input("Add grid"), &options()).unwrap();
        assert_eq!(body, serde_json::json!({
            "source_branch": "feature", "target_branch": "main", "title": "Draft: Add grid",
            "description": "Body", "assignee_ids": [7], "reviewer_ids": [9], "labels": "bug,ui",
            "milestone_id": 3, "remove_source_branch": true, "squash": false,
        }));
    }

    #[test]
    fn gitlab_draft_title_is_added_once() {
        for title in ["Draft: Add grid", "[draft] Add grid", "(Draft) Add grid"] {
            assert_eq!(gitlab_draft_title(title, true), title);
        }
        assert_eq!(gitlab_draft_title("Add grid", false), "Add grid");
    }

    #[test]
    fn gitlab_body_refuses_non_numeric_ids() {
        let mut bad = options();
        bad.assignees = vec!["alice".into()];
        assert!(gitlab_create_body(&input("Add grid"), &bad).is_err());
    }

    #[test]
    fn github_failure_with_url_is_created_with_warning() {
        let mut github = input("Add grid");
        github.provider = ProviderKind::Github;
        let created = interpret_github_create(
            1,
            "https://github.com/org/repo/pull/12\n",
            "could not request reviewer: 'ghost' not found\n",
            &github,
        )
        .unwrap();
        assert_eq!(created.pull_request.number, 12);
        assert!(created.warning.unwrap().contains("could not request reviewer"));
        assert!(interpret_github_create(1, "", "boom", &github).is_err());
    }
```

- [ ] **Step 6: Run to verify they fail** — `cargo test -p bibcode-server --lib source_control::pull_request`; Expected: FAIL to compile (new names missing).

- [ ] **Step 7: Implement the source-control side** in `pull_request.rs`.

Types after `CreatePullRequestInput`:

```rust
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneRef {
    pub id: String,
    pub title: String,
}

/// Reviewed create-time options; ids are the Pull Requests vocabulary entry ids.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatePullRequestOptions {
    pub draft: bool,
    pub assignees: Vec<String>,
    pub reviewers: Vec<String>,
    pub labels: Vec<String>,
    pub milestone: Option<MilestoneRef>,
    pub remove_source_branch: Option<bool>,
    pub squash: Option<bool>,
}

impl CreatePullRequestOptions {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Clone, Debug)]
pub struct CreatedPullRequest {
    pub pull_request: ResolvedPullRequest,
    /// The request exists, but some options were not applied.
    pub warning: Option<String>,
}
```

Re-export `CreatePullRequestOptions, CreatedPullRequest, MilestoneRef` from `source_control/mod.rs` next to `CreatePullRequestInput`.

Free functions (module level):

```rust
fn github_create_args(input: &CreatePullRequestInput, options: &CreatePullRequestOptions) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "pr", "create", "--base", input.base_branch.as_str(), "--head",
        input.head_branch.as_str(), "--title", input.title.as_str(), "--body", input.body.as_str(),
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    if options.draft {
        args.push("--draft".into());
    }
    for (flag, values) in [
        ("--assignee", &options.assignees),
        ("--reviewer", &options.reviewers),
        ("--label", &options.labels),
    ] {
        for value in values {
            args.push(flag.into());
            args.push(value.into());
        }
    }
    if let Some(milestone) = &options.milestone {
        args.push("--milestone".into());
        args.push(milestone.title.as_str().into());
    }
    args
}

fn gitlab_draft_title(title: &str, draft: bool) -> String {
    let lower = title.trim_start().to_lowercase();
    if !draft || ["draft:", "[draft]", "(draft)"].iter().any(|marker| lower.starts_with(marker)) {
        title.to_owned()
    } else {
        format!("Draft: {title}")
    }
}

fn gitlab_ids(values: &[String]) -> Result<Vec<u64>, String> {
    values
        .iter()
        .map(|value| value.parse::<u64>().map_err(|_| format!("'{value}' is not a GitLab id.")))
        .collect()
}

fn gitlab_create_body(
    input: &CreatePullRequestInput,
    options: &CreatePullRequestOptions,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::json!({
        "source_branch": input.head_branch, "target_branch": input.base_branch,
        "title": gitlab_draft_title(&input.title, options.draft), "description": input.body,
    });
    if !options.assignees.is_empty() {
        body["assignee_ids"] = serde_json::json!(gitlab_ids(&options.assignees)?);
    }
    if !options.reviewers.is_empty() {
        body["reviewer_ids"] = serde_json::json!(gitlab_ids(&options.reviewers)?);
    }
    if !options.labels.is_empty() {
        body["labels"] = serde_json::json!(options.labels.join(","));
    }
    if let Some(milestone) = &options.milestone {
        body["milestone_id"] = serde_json::json!(gitlab_ids(std::slice::from_ref(&milestone.id))?[0]);
    }
    if let Some(remove) = options.remove_source_branch {
        body["remove_source_branch"] = serde_json::json!(remove);
    }
    if let Some(squash) = options.squash {
        body["squash"] = serde_json::json!(squash);
    }
    Ok(body)
}

/// `gh` creates the request before applying reviewers and labels; a later step can fail
/// after the URL is printed. That request exists, so report it instead of retrying.
fn interpret_github_create(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
    input: &CreatePullRequestInput,
) -> Result<CreatedPullRequest, Option<i32>> {
    let created = parse_github_create_output(stdout, input).ok_or(Some(exit_code))?;
    let warning = (exit_code != 0).then(|| {
        let reason = stderr.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("unknown error");
        let reason: String = crate::diagnostics::redact_sensitive_text(reason).chars().take(300).collect();
        format!("Created, but some options weren't applied: {reason}. Review them on GitHub.")
    });
    Ok(CreatedPullRequest { pull_request: created, warning })
}
```

(`interpret_github_create` returns `Err(Some(code))` when no URL is present; the caller turns it into the existing `process_error` / unrecognized-payload error.)

Add `stdin: Option<Vec<u8>>` to `ProviderCommandInvocation` and pass it as `stdin` in the `ProcessRequest` built in `run_provider_os_with_allowed_exit_codes`; every existing construction sets `stdin: None`.

Rename the body of `create` into `create_with_options(&self, input, options: &CreatePullRequestOptions, cancellation) -> Result<CreatedPullRequest, _>` and make `create` delegate:

```rust
    pub async fn create(
        &self,
        input: CreatePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedPullRequest, SourceControlProviderError> {
        Ok(self
            .create_with_options(input, &CreatePullRequestOptions::default(), cancellation)
            .await?
            .pull_request)
    }
```

Inside `create_with_options`:
- The `gitlab_create_transport` branch passes `gitlab_create_body(&input, options)` (map the `Err(message)` to `operation_error(... "createPullRequest", Some("glab"), Some(&input.head_branch), &message)`), wrapping the parsed result as `CreatedPullRequest { pull_request, warning: None }`.
- GitHub args come from `github_create_args(&input, options)`.
- GitLab with `options.is_empty()` keeps today's `--raw-field` args. Otherwise args are `["api", "--method", "POST", "projects/:fullpath/merge_requests", "-H", "Content-Type: application/json", "--input", "-"]` with `stdin: Some(serde_json::to_vec(&body)?)`.
- GitHub with non-empty options runs with `allowed_non_zero_exit_codes: &[1]` and maps the output through `interpret_github_create(output.exit_code, &output.stdout, &output.stderr, &input)`; `Err(Some(code))` with a non-zero code becomes `process_error(provider, &input.cwd, "createPullRequest", command.label(), ProcessFailureFacts::exited(code))`, `Err(_)` with zero becomes the existing unrecognized-payload error.
- Every other path wraps its result in `CreatedPullRequest { pull_request, warning: None }`.

- [ ] **Step 8: Run the source-control tests** — `cargo test -p bibcode-server --lib source_control::pull_request`; Expected: PASS (new and existing).

- [ ] **Step 9: Write the failing stacked-action tests** in `apps/server/src/production/git_vcs.rs` tests (next to `create_pr_uses_the_reviewed_title_and_body_and_never_duplicates` ~line 5220), following that test's fixture setup:

```rust
    #[test]
    fn options_are_refused_on_non_request_actions() {
        let input: StackedActionInput = serde_json::from_value(json!({
            "actionId": "a", "cwd": "/repo", "action": "push",
            "pullRequestOptions": {"draft": true, "assignees": [], "reviewers": [], "labels": [],
                "milestone": null, "removeSourceBranch": null, "squash": null}
        }))
        .unwrap();
        assert!(validate_stacked_action_input(&input).is_err());
    }
```

Plus two async tests built from the `create_pr_uses_the_reviewed_title_and_body_and_never_duplicates` fixture (fake `gh` and repository):
- `merge_options_are_refused_for_github_before_publication`: GitHub remote, `pullRequestOptions.squash = true`, unpublished branch; assert the action errors with "Merge options apply only to GitLab merge requests." and the fake remote has no pushed ref.
- `existing_request_reports_options_not_applied`: the fixture's existing open request and `pullRequestOptions.draft = true`; assert `pr.status == "opened_existing"` and `pr.warning` contains "were not applied".

- [ ] **Step 10: Implement the stacked-action wiring** in `git_vcs.rs`:
- `StackedActionInput` gains `pull_request_options: Option<CreatePullRequestOptions>`.
- `PullRequestStepDetails` gains `#[serde(skip_serializing_if = "Option::is_none")] warning: Option<String>`; `resolved_pull_request_step` sets `warning: None`.
- `validate_stacked_action_input`: include `input.pull_request_options.is_some()` in the "applies only to pull request actions" check; then, for `Some(options)`, refuse more than 20 assignees, 20 reviewers or 50 labels, or any empty/over-255-character id or title, with `request_error("git.runStackedAction", "Pull request options exceed the supported limits.")`.
- Right after the provider is resolved (before any branch, commit or push), refuse `remove_source_branch.is_some() || squash.is_some()` when `provider != ProviderKind::Gitlab` with `request_error("git.runStackedAction", "Merge options apply only to GitLab merge requests.")`.
- In the existing-request branch, when options are present and not empty, set `warning = Some(format!("An open {noun} already existed for this branch; the new options were not applied."))` where `noun` is `"merge request"` for GitLab and `"pull request"` otherwise.
- The create call becomes `create_with_options(CreatePullRequestInput { … }, &input.pull_request_options.clone().unwrap_or_default(), cancellation)`; build the step from `created.pull_request` and copy `created.warning`.

- [ ] **Step 11: Advertise the capability**: add `"pullRequestCreateOptions": true,` after `"terminalImagePaste": true,` in `apps/server/src/lifecycle.rs` and `apps/server/src/production/control.rs`, and `assert_eq!(descriptor["capabilities"]["pullRequestCreateOptions"], true);` next to each `terminalImagePaste` assert.

- [ ] **Step 12: Run server tests** — `cargo test -p bibcode-server --lib git_vcs` then `cargo test -p bibcode-server --lib descriptor`; Expected: PASS. Then regenerate fixtures (`node scripts/run-local-vp.mjs run check:contracts`, counts should not change).

- [ ] **Step 13: Commit** (after Codex review)

```bash
git add packages/contracts packages/shared/src/testSupport.ts apps/server
git commit -m "feat(source-control): create requests with draft, people, labels and merge options"
```

---

### Task 3: Client runtime gate and defaults atom

**Files:**
- Modify: `packages/client-runtime/src/state/vcsAction.ts` (~lines 102 and 502)
- Modify: `packages/client-runtime/src/state/pullRequests.ts` (~line 97)
- Test: `packages/client-runtime/src/state/vcsAction.test.ts` (next to the branch-selection test ~line 118), `packages/client-runtime/src/state/pullRequests.test.ts` (~line 31)

**Interfaces:**
- Consumes: Task 1 `WS_METHODS.pullRequestsGetCreateDefaults`; Task 2 capability and `pullRequestOptions`.
- Produces: `pullRequestsEnvironment.getCreateDefaults` atom family (`{ environmentId, input: { cwd } }`); error class `VcsPullRequestCreateOptionsUnsupportedError`.

- [ ] **Step 1: Write the failing tests.** In `pullRequests.test.ts` add `"getCreateDefaults",` to the expected key list (alphabetical, after `"getContext"`). In `vcsAction.test.ts` copy the existing branch-selection capability test (~line 118) into `refuses create options when the server lacks pullRequestCreateOptions`, with capabilities `{ gitPullRequestBranchSelection: true, pullRequestCreateOptions: false }`, input carrying `pullRequestOptions: { draft: true, assignees: [], reviewers: [], labels: [], milestone: null, removeSourceBranch: null, squash: null }`, asserting failure tag `VcsPullRequestCreateOptionsUnsupportedError` and that the RPC was not called.

- [ ] **Step 2: Run to verify they fail** — `cd packages/client-runtime && node ../../scripts/run-local-vp.mjs test run src/state/pullRequests.test.ts src/state/vcsAction.test.ts`; Expected: FAIL.

- [ ] **Step 3: Implement.** In `pullRequests.ts` after `getVocabulary`:

```ts
    getCreateDefaults: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:get-create-defaults",
      tag: WS_METHODS.pullRequestsGetCreateDefaults,
      staleTimeMs: 60_000,
    }),
```

In `vcsAction.ts` after `VcsPullRequestBranchSelectionUnsupportedError`:

```ts
export class VcsPullRequestCreateOptionsUnsupportedError extends Schema.TaggedError<VcsPullRequestCreateOptionsUnsupportedError>()(
  "VcsPullRequestCreateOptionsUnsupportedError",
  { environmentId: EnvironmentId },
) {
  override get message(): string {
    return "Update this environment's BiBCode server to set draft, people, labels or merge options when creating a request.";
  }
}
```

and inside the `create_pr`/`commit_push_pr` check after the branch-selection test:

```ts
                  if (
                    input.pullRequestOptions !== undefined &&
                    config.environment.capabilities.pullRequestCreateOptions !== true
                  ) {
                    return yield* new VcsPullRequestCreateOptionsUnsupportedError({
                      environmentId: target.environmentId,
                    });
                  }
```

Add the new error to the action's error union type where `VcsPullRequestBranchSelectionUnsupportedError` is listed.

- [ ] **Step 4: Run the tests** — same command; Expected: PASS.

- [ ] **Step 5: Commit** (after Codex review)

```bash
git add packages/client-runtime
git commit -m "feat(client-runtime): gate create options and read create defaults"
```

---

### Task 4: Dialog fields

**Files:**
- Create: `apps/web/src/components/gitManager/provider/CreatePullRequestOptions.tsx`
- Modify: `apps/web/src/components/gitManager/provider/GitManagerPullRequestPanel.logic.ts` (`createPullRequestAction` ~line 93, progress reducer ~line 224)
- Modify: `apps/web/src/components/gitManager/provider/GitManagerCreatePullRequestDialog.tsx`
- Test: `apps/web/src/components/gitManager/provider/GitManagerPullRequestPanel.logic.test.ts`, `apps/web/src/components/gitManager/provider/GitManagerCreatePullRequestDialog.test.tsx`

**Interfaces:**
- Consumes: Task 3 `pullRequestsEnvironment.getCreateDefaults`; `usePullRequestsVocabulary(scope, kind)` from `apps/web/src/components/pullRequests/edit/usePullRequestsVocabulary.ts` (returns `{ entries, search, onSearch, searching, error, refresh }`); Task 2 `GitPullRequestCreateOptions`, `pr.warning`.
- Produces: `CreateOptionsState`, `EMPTY_CREATE_OPTIONS`, `squashControl(defaults)`, `createOptionsPayload(state, providerKind)`, `createPullRequestAction(actionId, reviewed, options?)`; component `CreatePullRequestOptions`.

- [ ] **Step 1: Write the failing logic tests** in `GitManagerPullRequestPanel.logic.test.ts`:

```ts
describe("create options", () => {
  const chosen: CreateOptionsState = {
    ...EMPTY_CREATE_OPTIONS,
    draft: true,
    assignees: [{ id: "7", label: "alice" }],
    labels: [{ id: "bug", label: "bug" }],
    milestone: { id: "3", label: "Sprint 9" },
    removeSourceBranch: true,
    squash: false,
  };

  it("sends nothing when no option is set", () => {
    expect(createOptionsPayload(EMPTY_CREATE_OPTIONS, "gitlab")).toBeUndefined();
  });

  it("sends GitLab ids and merge options", () => {
    expect(createOptionsPayload(chosen, "gitlab")).toEqual({
      draft: true, assignees: ["7"], reviewers: [], labels: ["bug"],
      milestone: { id: "3", title: "Sprint 9" }, removeSourceBranch: true, squash: false,
    });
  });

  it("never sends merge options for GitHub", () => {
    expect(createOptionsPayload(chosen, "github")).toMatchObject({ removeSourceBranch: null, squash: null });
  });

  it("locks squash when the project forces it", () => {
    expect(squashControl({ squash: "always" })).toEqual({
      checked: true, locked: true, note: "This project always squashes commits.",
    });
    expect(squashControl({ squash: "never" })).toEqual({
      checked: false, locked: true, note: "This project never squashes commits.",
    });
    expect(squashControl({ squash: "default_on" })).toEqual({ checked: true, locked: false, note: null });
    expect(squashControl(null)).toEqual({ checked: false, locked: false, note: null });
  });

  it("adds options to the create action only when present", () => {
    const reviewed = { baseBranch: "main", headBranch: undefined, title: "T", body: "" };
    expect(createPullRequestAction("a", reviewed)).not.toHaveProperty("pullRequestOptions");
    expect(createPullRequestAction("a", reviewed, createOptionsPayload(chosen, "gitlab")))
      .toHaveProperty("pullRequestOptions.draft", true);
  });
});
```

(Adapt `reviewed` to the exact `ReviewedPullRequest` fields defined in the logic file.)

- [ ] **Step 2: Run to verify they fail** — `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/gitManager/provider/GitManagerPullRequestPanel.logic.test.ts`; Expected: FAIL.

- [ ] **Step 3: Implement the logic** in `GitManagerPullRequestPanel.logic.ts`:

```ts
export interface VocabularyChoice {
  readonly id: string;
  readonly label: string;
}

export interface CreateOptionsState {
  readonly draft: boolean;
  readonly assignees: readonly VocabularyChoice[];
  readonly reviewers: readonly VocabularyChoice[];
  readonly labels: readonly VocabularyChoice[];
  readonly milestone: VocabularyChoice | null;
  readonly removeSourceBranch: boolean | null;
  readonly squash: boolean | null;
}

export const EMPTY_CREATE_OPTIONS: CreateOptionsState = {
  draft: false,
  assignees: [],
  reviewers: [],
  labels: [],
  milestone: null,
  removeSourceBranch: null,
  squash: null,
};

/** `null` options leave the provider's own default in force. */
export function createOptionsPayload(
  state: CreateOptionsState,
  providerKind: string | null,
): GitPullRequestCreateOptions | undefined {
  const gitlab = providerKind === "gitlab";
  const payload: GitPullRequestCreateOptions = {
    draft: state.draft,
    assignees: state.assignees.map((choice) => choice.id),
    reviewers: state.reviewers.map((choice) => choice.id),
    labels: state.labels.map((choice) => choice.id),
    milestone: state.milestone === null ? null : { id: state.milestone.id, title: state.milestone.label },
    removeSourceBranch: gitlab ? state.removeSourceBranch : null,
    squash: gitlab ? state.squash : null,
  };
  const empty =
    !payload.draft && payload.assignees.length === 0 && payload.reviewers.length === 0 &&
    payload.labels.length === 0 && payload.milestone === null &&
    payload.removeSourceBranch === null && payload.squash === null;
  return empty ? undefined : payload;
}

export function squashControl(
  defaults: { readonly squash: PullRequestsSquashOption | null } | null,
): { checked: boolean; locked: boolean; note: string | null } {
  switch (defaults?.squash) {
    case "always":
      return { checked: true, locked: true, note: "This project always squashes commits." };
    case "never":
      return { checked: false, locked: true, note: "This project never squashes commits." };
    case "default_on":
      return { checked: true, locked: false, note: null };
    default:
      return { checked: false, locked: false, note: null };
  }
}
```

Extend `createPullRequestAction(actionId, reviewed, options?: GitPullRequestCreateOptions)` with `...(options === undefined ? {} : { pullRequestOptions: options })`. In `reduceCreatePullRequestProgress`, copy `event.result.pr.warning` into the `created` and `existing` states as `warning: string | null`.

- [ ] **Step 4: Run the logic tests** — Expected: PASS.

- [ ] **Step 5: Create `CreatePullRequestOptions.tsx`**:

```tsx
import type { EnvironmentId, PullRequestsCreateDefaults } from "@bibcode/contracts";
import { useId } from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "~/components/ui/combobox";
import { Label } from "~/components/ui/label";
import { usePullRequestsVocabulary } from "../../pullRequests/edit/usePullRequestsVocabulary";
import { PullRequestsLabelChip } from "../../pullRequests/shared/PullRequestsLabelChip";
import {
  type CreateOptionsState,
  squashControl,
  type VocabularyChoice,
} from "./GitManagerPullRequestPanel.logic";

interface PickerProps {
  readonly scope: { environmentId: EnvironmentId; cwd: string };
  readonly label: string;
  readonly kind: "users" | "labels" | "milestones";
  readonly multiple: boolean;
  readonly value: readonly VocabularyChoice[];
  readonly onChange: (value: VocabularyChoice[]) => void;
  readonly disabled: boolean;
  readonly action?: React.ReactNode;
}

function OptionPicker(props: PickerProps) {
  const id = useId();
  const query = usePullRequestsVocabulary(props.scope, props.kind);
  const byId = new Map(query.entries.map((entry) => [entry.id, entry]));
  for (const choice of props.value) if (!byId.has(choice.id)) byId.set(choice.id, { ...choice, color: null, description: null });
  const selectedIds = props.value.map((choice) => choice.id);
  const choose = (ids: string[]) =>
    props.onChange(ids.flatMap((choiceId) => {
      const entry = byId.get(choiceId);
      return entry === undefined ? [] : [{ id: entry.id, label: entry.label }];
    }));
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{props.label}</Label>
        {props.action}
      </div>
      <Combobox
        items={query.entries.map((entry) => entry.id)}
        filter={null}
        multiple={props.multiple}
        value={props.multiple ? selectedIds : (selectedIds[0] ?? null)}
        inputValue={query.search}
        onInputValueChange={(value) => query.onSearch(value)}
        onValueChange={(value: string | string[] | null) =>
          choose(value === null ? [] : Array.isArray(value) ? value : [value])
        }
        disabled={props.disabled}
      >
        <ComboboxInput id={id} placeholder={props.multiple ? "Search" : "Unassigned"} showClear />
        <ComboboxPopup data-text-surface="popover">
          <ComboboxList>
            {(entryId: string) => (
              <ComboboxItem key={entryId} value={entryId}>
                {byId.get(entryId)?.label ?? entryId}
              </ComboboxItem>
            )}
          </ComboboxList>
          {query.searching ? <p role="status" className="p-2 text-sm">Loading…</p> : null}
        </ComboboxPopup>
      </Combobox>
      {query.error ? (
        <div className="flex items-center gap-2 text-sm">
          <p role="alert" className="text-destructive">Couldn't load {props.label.toLowerCase()}.</p>
          <Button size="sm" variant="outline" onClick={query.refresh}>Retry</Button>
        </div>
      ) : null}
      {props.multiple && props.value.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {props.value.map((choice) => (
            <PullRequestsLabelChip key={choice.id} name={choice.label} color={byId.get(choice.id)?.color ?? null} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CreatePullRequestOptions(props: {
  readonly scope: { environmentId: EnvironmentId; cwd: string };
  readonly providerKind: string | null;
  readonly defaults: PullRequestsCreateDefaults | null;
  readonly value: CreateOptionsState;
  readonly onChange: (value: CreateOptionsState) => void;
  readonly disabled: boolean;
}) {
  const gitlab = props.providerKind === "gitlab";
  const people = !gitlab;
  const set = (patch: Partial<CreateOptionsState>) => props.onChange({ ...props.value, ...patch });
  const squash = squashControl(props.defaults);
  const viewer = props.defaults?.viewer ?? null;
  return (
    <div className="grid gap-3">
      <OptionPicker
        scope={props.scope}
        label="Assignee"
        kind="users"
        multiple={people}
        value={props.value.assignees}
        onChange={(assignees) => set({ assignees })}
        disabled={props.disabled}
        action={
          viewer === null ? null : (
            <Button
              size="xs"
              variant="link"
              disabled={props.disabled || props.value.assignees.some((a) => a.id === viewer.id)}
              onClick={() =>
                set({ assignees: people ? [...props.value.assignees, viewer] : [viewer] })
              }
            >
              Assign to me
            </Button>
          )
        }
      />
      <OptionPicker scope={props.scope} label="Reviewer" kind="users" multiple={people}
        value={props.value.reviewers} onChange={(reviewers) => set({ reviewers })} disabled={props.disabled} />
      <OptionPicker scope={props.scope} label="Milestone" kind="milestones" multiple={false}
        value={props.value.milestone === null ? [] : [props.value.milestone]}
        onChange={(chosen) => set({ milestone: chosen[0] ?? null })} disabled={props.disabled} />
      <OptionPicker scope={props.scope} label="Labels" kind="labels" multiple
        value={props.value.labels} onChange={(labels) => set({ labels })} disabled={props.disabled} />
      {gitlab ? (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Merge options</legend>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={props.value.removeSourceBranch ?? props.defaults?.removeSourceBranch ?? false}
              onCheckedChange={(checked) => set({ removeSourceBranch: checked === true })}
              disabled={props.disabled}
            />
            Delete source branch when merge request is accepted.
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={squash.locked ? squash.checked : (props.value.squash ?? squash.checked)}
              onCheckedChange={(checked) => set({ squash: checked === true })}
              disabled={props.disabled || squash.locked}
            />
            Squash commits when merge request is accepted.
          </label>
          {squash.note === null ? null : (
            <p className="text-xs text-muted-foreground">{squash.note}</p>
          )}
        </fieldset>
      ) : null}
    </div>
  );
}
```

Check `PullRequestsLabelChip`'s and `Checkbox`'s actual prop names in their files and adjust the two call sites to match (the chip may take a `label` object; the checkbox may use `onCheckedChange`).

- [ ] **Step 6: Wire the dialog** in `GitManagerCreatePullRequestDialog.tsx`:
- `const createOptionsSupported = serverConfig?.environment.capabilities.pullRequestCreateOptions === true;`
- `const [createOptions, setCreateOptions] = useState<CreateOptionsState>(EMPTY_CREATE_OPTIONS);` — reset to `EMPTY_CREATE_OPTIONS` wherever the dialog already resets its reviewed content on reopen or scope change.
- Defaults: `const defaultsQuery = useEnvironmentQuery(useMemo(() => open && createOptionsSupported ? pullRequestsEnvironment.getCreateDefaults({ environmentId, input: { cwd } }) : null, [open, createOptionsSupported, environmentId, cwd]));` (`pullRequestsEnvironment` from `~/state/pullRequests`).
- Under the Title input, when `createOptionsSupported`: a `Checkbox` "Mark as draft" with help text "Drafts can't be merged until marked ready." bound to `createOptions.draft`.
- After the Description field, when `createOptionsSupported`: `<CreatePullRequestOptions scope={scope} providerKind={provider?.kind ?? null} defaults={defaultsQuery.data ?? null} value={createOptions} onChange={setCreateOptions} disabled={running} />`.
- Submit: pass `createOptionsSupported ? createOptionsPayload(createOptions, provider?.kind ?? null) : undefined` as the third argument of `createPullRequestAction`. Before building the payload, fill unset GitLab merge options from the defaults: `removeSourceBranch ?? defaults.removeSourceBranch`, and `squash` from `squashControl(defaults)` when the box is locked or untouched, so the request matches what the dialog showed.
- Make the dialog body scroll with a pinned footer: wrap the field stack in `<div className="min-h-0 flex-1 overflow-y-auto">` inside the existing popup, leaving the footer with Create outside it.
- After `created`/`existing` with `warning !== null`, render `<p role="status" className="text-sm text-warning-foreground">{warning}</p>` in the result area.

- [ ] **Step 7: Write the failing dialog tests** in `GitManagerCreatePullRequestDialog.test.tsx`. Add to the hoisted state `createOptionsSupported: true as boolean, createDefaults: null as unknown, vocabularyError: null as string | null`; add `pullRequestCreateOptions: h.createOptionsSupported` to the mocked capabilities; mock `~/state/pullRequests` as `{ pullRequestsEnvironment: { getCreateDefaults: vi.fn(() => ({ kind: "createDefaults" })) } }`; extend the `useEnvironmentQuery` mock with `atom?.kind === "createDefaults" ? h.createDefaults :`; mock the vocabulary hook:

```ts
vi.mock("../../pullRequests/edit/usePullRequestsVocabulary", () => ({
  usePullRequestsVocabulary: (_scope: unknown, kind: string) => ({
    entries:
      kind === "users"
        ? [{ id: "7", label: "alice", color: null, description: null }]
        : kind === "labels"
          ? [{ id: "bug", label: "bug", color: "#f00", description: null }]
          : [{ id: "3", label: "Sprint 9", color: null, description: null }],
    search: "",
    onSearch: vi.fn(),
    searching: false,
    error: h.vocabularyError,
    refresh: vi.fn(),
  }),
}));
```

Tests (use the file's `renderDialog`, `chooseTarget`, `button`, `setValue` helpers; reset the new hoisted fields in `beforeEach`):

```ts
  it("hides create options on servers without the capability", async () => {
    h.createOptionsSupported = false;
    await renderDialog();
    expect(document.body.textContent).not.toContain("Mark as draft");
    expect(document.body.textContent).not.toContain("Assignee");
  });

  it("sends draft and Assign to me with the create request", async () => {
    h.createDefaults = { viewer: { id: "7", label: "alice" }, squash: null, removeSourceBranch: null };
    h.script.push({ events: [finished("created")], outcome: "success" });
    await renderDialog(vi.fn(), vi.fn(), { kind: "gitlab", baseUrl: "https://gitlab.example" });
    await chooseTarget("main");
    await act(async () => (document.querySelector('[aria-label="Mark as draft"]') as HTMLElement).click());
    await act(async () => button("Assign to me").click());
    await act(async () => button("Publish and create merge request").click());
    expect(h.runs[0]?.pullRequestOptions).toMatchObject({ draft: true, assignees: ["7"] });
  });

  it("locks squash when the GitLab project forces it", async () => {
    h.createDefaults = { viewer: null, squash: "always", removeSourceBranch: true };
    await renderDialog(vi.fn(), vi.fn(), { kind: "gitlab", baseUrl: "https://gitlab.example" });
    expect(document.body.textContent).toContain("This project always squashes commits.");
  });

  it("shows merge options only for GitLab", async () => {
    await renderDialog(vi.fn(), vi.fn(), { kind: "github", baseUrl: "https://github.com" });
    expect(document.body.textContent).not.toContain("Merge options");
  });

  it("a failed picker keeps creation available", async () => {
    h.vocabularyError = "Forbidden";
    await renderDialog();
    await chooseTarget("main");
    expect(document.body.textContent).toContain("Couldn't load reviewer.");
    expect(button("Publish and create pull request").disabled).toBe(false);
  });
```

Add `pullRequestOptions?: unknown` to the file's `RunInput` type. Give the draft checkbox `aria-label="Mark as draft"` in Step 6 so the test can find it. Adjust button texts to the dialog's actual wording for the merge-request case if it differs (see the existing test "says merge request and shows the self-hosted GitLab address").

- [ ] **Step 8: Run the dialog and logic tests** — `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/gitManager/provider`; Expected: PASS. Fix the provider hint used for "merge request" wording by reading that existing test if a button lookup fails.

- [ ] **Step 9: Reviews** — run the `vercel-react-best-practices` skill on `CreatePullRequestOptions.tsx` and the dialog changes, and review against `UI.md` (labels name the action, disabled/locked states explain themselves via the squash note, errors offer Retry). Fix findings.

- [ ] **Step 10: Commit** (after Codex review)

```bash
git add apps/web/src/components/gitManager/provider
git commit -m "feat(web): draft, people, labels, milestone and merge options in the create dialog"
```

---

### Task 5: Documentation and final gates

**Files:**
- Modify: `docs/integrations/source-control-providers.md` (dialog section ~lines 157-190)
- Modify: `docs/architecture/rpc-and-orchestration.md` (Pull Requests flow ~lines 505-535)
- Modify: `docs/user/workspace-ui.md` (~lines 637-643)
- Modify: `docs/testing/cross-platform-validation.md` (step 11 ~line 2051)

**Interfaces:** consumes the behavior of Tasks 1-4.

- [ ] **Step 1: Update the integration doc** — add to the dialog description: "On servers with `pullRequestCreateOptions`, the dialog also sets Mark as draft, Assignee (with Assign to me), Reviewer, Milestone and Labels; GitLab adds Delete source branch and Squash, prefilled from the project's settings and locked when the project forces squash. GitLab takes one assignee and one reviewer; GitHub several. A GitHub request whose later option step fails is reported as created with a warning; an existing open request keeps its options and the dialog says so."

- [ ] **Step 2: Update the architecture doc** — document `pullRequestOptions` on `git.runStackedAction` (validation, GitLab-only merge options refused before publication, GitHub flags vs GitLab JSON body over stdin, draft prefix rule, `pr.warning`), the `pullRequests.getCreateDefaults` read (viewer plus GitLab `squash_option` and `remove_source_branch_after_merge`), and the capability.

- [ ] **Step 3: Update the user doc** — one paragraph listing the new fields and the GitLab-only merge options.

- [ ] **Step 4: Update the runbook step 11** — add: on GitLab, create an MR with Draft, Assign to me, a reviewer, a label and a milestone, Delete source branch and Squash; verify each on the GitLab page and that the title has one `Draft:` prefix. On GitHub, create a draft PR with an assignee, reviewer, label and milestone; verify on GitHub. With a reviewer who lacks access, verify the PR is created once and the dialog shows the warning. Against an older server, verify the fields are absent.

- [ ] **Step 5: Final gates** (serialized)

Run:
```bash
node scripts/run-local-vp.mjs check
node scripts/run-local-vp.mjs run typecheck
node scripts/run-local-vp.mjs run check:contracts
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
cargo test -p bibcode-server --no-fail-fast
(cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit)
(cd packages/client-runtime && node ../../scripts/run-local-vp.mjs test run)
(cd packages/contracts && node ../../scripts/run-local-vp.mjs test run)
```
Expected: all pass (`vp check` may still flag the unrelated untracked `docs/plans/2026-10-06-internal-browser-and-mobile-emulator-research.md`; leave that file alone).

- [ ] **Step 6: Commit** (after Codex review)

```bash
git add docs
git commit -m "docs: create-request options in the dialog, RPC and runbook"
```
