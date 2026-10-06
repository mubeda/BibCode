# Sidebar Repositories View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second left-panel view that groups every environment's projects by their `origin` repository, backed by a server-authored `repositoryIdentity` on each project.

**Architecture:** The Rust server derives `repositoryIdentity` from a checkout's `origin` remote, stores it in a new projection column, and changes it only through a new server-internal command that emits `project.meta-updated`. A reconciler sets it after project creation, at startup, and (throttled) after healthy worktree-catalog scans. The React sidebar gains an **Environments | Repositories** toggle; the Repositories view runs the existing project pipeline over all environments with `separate` grouping (one project node per environment checkout), buckets those nodes by `repositoryIdentity.canonicalKey`, renders each bucket as a read-only group card, and renders each node with the existing project row in an environment presentation. The environment rail is hidden in that view.

**Tech Stack:** Rust (Tokio, rusqlite, serde_json), React 19 + Zustand + Tailwind, Vite+ (`vp`) test runner.

**Spec:** `docs/superpowers/specs/2026-10-05-sidebar-repositories-view-design.md`

## Global Constraints

- `vp` is not on PATH in this checkout: run Vite+ through `node scripts/run-local-vp.mjs <args>` from the repository root (web tests: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit <files>`).
- Rust: `cargo test -p bibcode-server --lib -j 2 <filter>`; finish with `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`.
- `repositoryIdentity` is server-authored only; clients can never set it.
- Canonical key = lowercased host + `/` + repository path without `.git`, path case preserved, nested groups kept.
- A failed or unavailable read never clears a stored identity.
- The identity update must not change a project's `updatedAt` (sidebar sort order must not shuffle).
- Sidebar text floor is 12px (`text-xs`); names use `text-[13px]`; no `tracking-*` utilities (`components/sidebar/sidebarTypography.test.ts` enforces this).
- The Repositories view issues no new client requests.
- Toggle preference is per device (UI-state store), default `environments`.
- In the Repositories view the environment rail is not rendered; switching back restores it with its previous selection (the active-environment atom is untouched).
- Do not stage the unrelated uncommitted working-tree changes present before this plan (terminal, collapse and MR fixes): commit only the files each task lists.

## Review Focus

1. **A project whose folder is missing or unmounted** (remote disk detached): the reconciler must keep the stored identity, not clear it — test in Task 4.
2. **The identity update looping**: the reconciler reacts to `project.meta-updated`; its own update must not trigger another reconcile — Task 4 reacts only when the event carries `workspaceRoot`, and its test asserts a single event.
3. **Two checkouts of one repository in the same environment** must render as two environment cards, not merge — test in Task 7.
4. **Collapsing an environment card in the Repositories view, then switching views**: the Environments row for that repository must show the same state — test in Task 8.
5. **Drafts written before a project gained an identity** must still be found — test in Task 5.

---

## File Structure

Server (`apps/server/src/`):
- Create `source_control/repository_identity.rs` — pure `origin` URL → identity JSON.
- Modify `source_control/mod.rs` — declare the module.
- Modify `persistence/migrations.rs` — migration 052 adds `projection_projects.repository_identity_json`.
- Modify `persistence/repositories.rs` — `ProjectionProject.repository_identity`, shared project SELECT, decode, upsert.
- Modify `orchestration/engine.rs` — server-internal `project.repository-identity.set` command, projector support.
- Modify every `ProjectionProject { .. }` literal (compiler-guided list in Task 2).
- Modify `production/orchestration_rpc.rs` — emit `repositoryIdentity` in `project_shell`.
- Create `production/repository_identity.rs` — read, reconcile, backfill, throttle.
- Modify `production/mod.rs`, `production/orchestration_effects.rs`, `production/worktree_catalog_rpc.rs` — triggers.

Web (`apps/web/src/`):
- Modify `composerDraftStore.ts`, `hooks/useHandleNewThread.ts`, `components/ChatView.tsx` — draft key fallback.
- Modify `uiStateStore.ts` — `sidebarView`, `repositoryGroupExpandedById`.
- Create `components/sidebar/repositoryView.logic.ts` — environment card identities and repository grouping.
- Modify `components/sidebar/EnvironmentRail.tsx` — export the status dot.
- Create `components/sidebar/EnvironmentCardHeader.tsx`, `components/sidebar/SidebarRepositoryGroup.tsx`, `components/sidebar/SidebarViewToggle.tsx`.
- Modify `sidebarProjectGrouping.ts` — optional `sharedExpansionKey`.
- Modify `components/Sidebar.tsx`, `components/AppSidebarLayout.tsx`, `components/Sidebar.testHarness.tsx`.

Docs: `docs/architecture/overview.md`, `docs/architecture/worktree-catalog.md`, `docs/user/workspace-ui.md`, `docs/testing/cross-platform-validation.md`.

---

### Task 1: Repository identity from an `origin` URL (pure)

**Files:**
- Create: `apps/server/src/source_control/repository_identity.rs`
- Modify: `apps/server/src/source_control/mod.rs:1-4`

**Interfaces:**
- Consumes: `source_control::{remote_host, remote_repository_path, provider_from_remote, ProviderKind}` (existing, `source_control/mod.rs`).
- Produces: `pub fn repository_identity(remote_url: &str, root_path: &str) -> Option<serde_json::Value>` returning the contract `RepositoryIdentity` JSON (`canonicalKey`, `locator`, `rootPath`, `displayName`, `name`, optional `owner`, optional `provider`).

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/source_control/repository_identity.rs` with only the tests first:

```rust
//! Cross-machine repository identity derived from a checkout's `origin` remote.

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::repository_identity;

    #[test]
    fn equivalent_remote_forms_share_one_canonical_key() {
        for remote in [
            "git@gitlab.internal.pathfinder.app:tripunkt/pathfinder-application-server.git",
            "https://gitlab.internal.pathfinder.app/tripunkt/pathfinder-application-server.git",
            "ssh://git@GitLab.Internal.Pathfinder.App:2222/tripunkt/pathfinder-application-server",
            "https://user@gitlab.internal.pathfinder.app:8443/tripunkt/pathfinder-application-server.git/",
        ] {
            let identity = repository_identity(remote, "/work/repo").expect(remote);
            assert_eq!(
                identity["canonicalKey"],
                "gitlab.internal.pathfinder.app/tripunkt/pathfinder-application-server",
                "{remote}"
            );
            assert_eq!(identity["name"], "pathfinder-application-server");
            assert_eq!(identity["displayName"], "pathfinder-application-server");
            assert_eq!(identity["owner"], "tripunkt");
            assert_eq!(identity["provider"], "gitlab");
            assert_eq!(identity["rootPath"], "/work/repo");
            assert_eq!(identity["locator"]["source"], "git-remote");
            assert_eq!(identity["locator"]["remoteName"], "origin");
            assert_eq!(identity["locator"]["remoteUrl"], remote);
        }
    }

    #[test]
    fn nested_groups_and_path_case_are_kept() {
        let identity =
            repository_identity("git@github.com:Acme/Team/Repo.git", "C:/repo").unwrap();
        assert_eq!(identity["canonicalKey"], "github.com/Acme/Team/Repo");
        assert_eq!(identity["owner"], "Acme/Team");
        assert_eq!(identity["name"], "Repo");
        assert_eq!(identity["provider"], "github");
    }

    #[test]
    fn single_segment_paths_and_unknown_hosts_omit_owner_and_provider() {
        let identity = repository_identity("https://git.example.org/tools.git", "/r").unwrap();
        assert_eq!(identity["canonicalKey"], "git.example.org/tools");
        assert!(identity.get("owner").is_none());
        assert!(identity.get("provider").is_none());
    }

    #[test]
    fn local_and_hostless_remotes_have_no_identity() {
        for remote in ["/srv/git/repo.git", "C:/work/repo", "./relative", "https://host/", ""] {
            assert_eq!(repository_identity(remote, "/r"), None, "{remote}");
        }
        assert_eq!(
            repository_identity("git@[fe80::1]:a/b.git", "/r").unwrap()["canonicalKey"],
            json!("fe80::1/a/b")
        );
    }
}
```

Add `pub mod repository_identity;` after `mod pull_request;` in `apps/server/src/source_control/mod.rs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bibcode-server --lib -j 2 source_control::repository_identity`
Expected: FAIL to compile with "cannot find function `repository_identity` in module `super`".

- [ ] **Step 3: Write minimal implementation**

Insert above the `#[cfg(test)]` block:

```rust
use serde_json::{Value, json};

use super::{ProviderKind, provider_from_remote, remote_host, remote_repository_path};

/// The identity of the repository behind `remote_url`, or `None` for a local
/// path or a remote without a host and repository path.
#[must_use]
pub fn repository_identity(remote_url: &str, root_path: &str) -> Option<Value> {
    let remote_url = remote_url.trim();
    let host = remote_host(remote_url)?;
    let path = remote_repository_path(remote_url)?;
    let (owner, name) = match path.rsplit_once('/') {
        Some((owner, name)) => (Some(owner), name),
        None => (None, path.as_str()),
    };
    let mut identity = json!({
        "canonicalKey": format!("{host}/{path}"),
        "locator": {"source": "git-remote", "remoteName": "origin", "remoteUrl": remote_url},
        "rootPath": root_path,
        "displayName": name,
        "name": name,
    });
    if let Some(owner) = owner {
        identity["owner"] = json!(owner);
    }
    let provider = provider_from_remote(remote_url).kind;
    if provider != ProviderKind::Unknown {
        identity["provider"] = json!(provider);
    }
    Some(identity)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p bibcode-server --lib -j 2 source_control::repository_identity`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/source_control/repository_identity.rs apps/server/src/source_control/mod.rs
git commit -m "feat(server): derive repository identity from an origin remote"
```

---

### Task 2: Persist `repositoryIdentity` on projects and send it to clients

**Files:**
- Modify: `apps/server/src/persistence/migrations.rs` (registry near `:682`, new fn after `migration_051`, test module)
- Modify: `apps/server/src/persistence/repositories.rs:375-395,610,2060-2072,2543-2556`
- Modify: every `ProjectionProject { .. }` literal outside `repositories.rs`: `production/orchestration_rpc.rs:1959`, `production/orchestration_effects.rs:1773,1788,1808,2003`, `production/git_manager_rpc.rs:2144,2238`, `production/worktree_runtime.rs:2821`, plus any the compiler reports in tests
- Modify: `apps/server/src/production/orchestration_rpc.rs:1253-1264`

**Interfaces:**
- Produces: `ProjectionProject.repository_identity: Option<serde_json::Value>`; column `projection_projects.repository_identity_json TEXT NULL`; wire field `repositoryIdentity` (JSON object or `null`) on every project shell.

- [ ] **Step 1: Write the failing test**

In `persistence/migrations.rs`'s test module add:

```rust
    #[test]
    fn migration_052_adds_nullable_repository_identity_column() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        run_migrations(&mut connection, None).unwrap();
        connection
            .execute(
                "INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, worktree_discovery_json, created_at, updated_at, deleted_at) VALUES ('p', 'P', '/repo', NULL, '[]', '{}', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', NULL)",
                [],
            )
            .unwrap();
        let value: Option<String> = connection
            .query_row(
                "SELECT repository_identity_json FROM projection_projects WHERE project_id = 'p'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, None);
    }
```

(If `run_migrations` in the test module takes `&Connection` rather than `&mut`, match the call used by the neighbouring tests around `:3463`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bibcode-server --lib -j 2 migration_052`
Expected: FAIL with "no such column: repository_identity_json".

- [ ] **Step 3: Add the migration**

Register after `Migration::new(51, ...)`:

```rust
    Migration::new(52, "ProjectRepositoryIdentity", migration_052),
```

Add after `migration_051`:

```rust
fn migration_052(transaction: &Transaction<'_>) -> Result<()> {
    if table_exists(transaction, "projection_projects")?
        && !table_has_column(transaction, "projection_projects", "repository_identity_json")?
    {
        transaction.execute_batch(
            "ALTER TABLE projection_projects ADD COLUMN repository_identity_json TEXT;",
        )?;
    }
    Ok(())
}
```

Run: `cargo test -p bibcode-server --lib -j 2 migration_052` → PASS.

- [ ] **Step 4: Carry the column through the projection row**

In `persistence/repositories.rs`:

1. Add a shared SELECT near the top of the `impl Repositories` file section (module scope, above `impl`):

```rust
const PROJECT_SELECT: &str = "SELECT project_id, title, workspace_root, default_model_selection_json, scripts_json, worktree_discovery_json, (SELECT repository_key FROM project_worktree_repository_pins WHERE project_id = projection_projects.project_id), created_at, updated_at, deleted_at, repository_identity_json FROM projection_projects";
```

2. Replace the three literal SELECTs (`get_project` `:390`, `list_projects` `:394`, `load_worktree_catalog_projection` `:610`) with `&format!("{PROJECT_SELECT} WHERE project_id = ?")` and `&format!("{PROJECT_SELECT} ORDER BY created_at ASC, project_id ASC")` respectively.

3. Add the field after `worktree_repository_key` in `ProjectionProject`:

```rust
    pub repository_identity: Option<Value>,
```

4. In `decode_project` add after `deleted_at: row.get(9)?,`:

```rust
        repository_identity: decode_optional_json(row.get(10)?, "repository_identity_json")?,
```

5. In `upsert_project` add the column to the INSERT list, the VALUES (`?` count 10), the `ON CONFLICT` set list (`repository_identity_json=excluded.repository_identity_json`), and the param `optional_json(&row.repository_identity)?` after `encode_json(&row.worktree_discovery)?`.

6. Run `cargo check -p bibcode-server --all-targets -j 2`; for each "missing field `repository_identity`" error add `repository_identity: None,` to that literal.

- [ ] **Step 5: Emit it on the wire**

In `production/orchestration_rpc.rs` `project_shell` add after `"worktreeDiscovery"`:

```rust
        "repositoryIdentity": project.repository_identity,
```

- [ ] **Step 6: Add a round-trip test and run**

In `persistence/repositories.rs` tests (or the nearest repositories test module) add:

```rust
    #[tokio::test]
    async fn project_repository_identity_round_trips() {
        let repositories = test_repositories().await;
        let identity = serde_json::json!({"canonicalKey":"github.com/acme/repo","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"git@github.com:acme/repo.git"},"name":"repo"});
        let mut project = sample_project("p-identity");
        project.repository_identity = Some(identity.clone());
        repositories.upsert_project(project).await.unwrap();
        let stored = repositories.get_project("p-identity".into()).await.unwrap().unwrap();
        assert_eq!(stored.repository_identity, Some(identity));
    }
```

Use the module's existing in-memory repositories constructor and project fixture; if they are named differently, use the ones the neighbouring `upsert_project` tests use (search `upsert_project(` in the test module).

Run: `cargo test -p bibcode-server --lib -j 2 repository_identity` → PASS. Then `cargo test -p bibcode-server --lib -j 2 orchestration_rpc` → PASS (shell tests that compare whole objects may need `"repositoryIdentity": null` added to their expected JSON; add it).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/persistence apps/server/src/production apps/server/src/orchestration
git commit -m "feat(server): store and publish project repository identity"
```

---

### Task 3: Server-internal `project.repository-identity.set` command

**Files:**
- Modify: `apps/server/src/orchestration/engine.rs` (enum near `:328`, `plan_command` near `:3476`, projector near `:5528`, accessors near `:6539-6680`, tests)

**Interfaces:**
- Produces: `OrchestrationCommand::ProjectRepositoryIdentitySet { command_id: String, project_id: String, repository_identity: Option<Value> }`, serde tag `"project.repository-identity.set"`, field `"repositoryIdentity"`; `is_server_internal()` true; emits `project.meta-updated` with `{"projectId","repositoryIdentity","updatedAt": <the project's current updated_at>}`.

- [ ] **Step 1: Write the failing test**

In the engine test module, beside `adoption_engine` tests, add:

```rust
        #[tokio::test]
        async fn repository_identity_set_updates_projection_without_touching_updated_at() {
            let engine = adoption_engine(TestHooks::default()).await;
            let before = engine
                .repositories()
                .get_project(PROJECT_ID.into())
                .await
                .unwrap()
                .unwrap();
            let identity = json!({"canonicalKey":"github.com/acme/repo","locator":{"source":"git-remote","remoteName":"origin","remoteUrl":"git@github.com:acme/repo.git"},"name":"repo"});
            engine
                .dispatch(OrchestrationCommand::ProjectRepositoryIdentitySet {
                    command_id: "identity-1".into(),
                    project_id: PROJECT_ID.into(),
                    repository_identity: Some(identity.clone()),
                })
                .await
                .unwrap();
            let after = engine
                .repositories()
                .get_project(PROJECT_ID.into())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(after.repository_identity, Some(identity));
            assert_eq!(after.updated_at, before.updated_at);

            engine
                .dispatch(OrchestrationCommand::ProjectRepositoryIdentitySet {
                    command_id: "identity-2".into(),
                    project_id: PROJECT_ID.into(),
                    repository_identity: None,
                })
                .await
                .unwrap();
            let cleared = engine
                .repositories()
                .get_project(PROJECT_ID.into())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(cleared.repository_identity, None);
        }

        #[test]
        fn repository_identity_set_is_server_internal() {
            let command: OrchestrationCommand = serde_json::from_value(json!({
                "type":"project.repository-identity.set",
                "commandId":"c",
                "projectId":"p",
                "repositoryIdentity":null
            }))
            .unwrap();
            assert!(command.is_server_internal());
        }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bibcode-server --lib -j 2 repository_identity_set`
Expected: FAIL to compile ("no variant named `ProjectRepositoryIdentitySet`").

- [ ] **Step 3: Add the variant**

After the `ProjectMetaUpdate` variant:

```rust
    #[serde(rename = "project.repository-identity.set")]
    ProjectRepositoryIdentitySet {
        #[serde(rename = "commandId")]
        command_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "repositoryIdentity", default)]
        repository_identity: Option<Value>,
    },
```

Update the accessors:
- command type name list: `Self::ProjectRepositoryIdentitySet { .. } => "project.repository-identity.set",`
- `command_id`: add `| Self::ProjectRepositoryIdentitySet { command_id, .. }`
- `occurred_at`: add `| Self::ProjectRepositoryIdentitySet { .. }` to the `=> None` arm
- `aggregate_ref`: add `Self::ProjectRepositoryIdentitySet { project_id, .. } => ("project", project_id),`
- `is_server_internal`: add `| Self::ProjectRepositoryIdentitySet { .. }`
- run `cargo check -p bibcode-server -j 2` and add the variant to any other exhaustive match it reports, following how `ProjectMetaUpdate` is handled there.

- [ ] **Step 4: Plan the event**

In `plan_command`, after the `ProjectMetaUpdate` arm:

```rust
        OrchestrationCommand::ProjectRepositoryIdentitySet {
            command_id,
            project_id,
            repository_identity,
        } => {
            require_project(model, command, project_id)?;
            // Keep updatedAt: an identity refresh is not user activity and must not reorder projects.
            let updated_at = repositories
                .get_project(project_id.clone())
                .await
                .map_err(wrap_persistence)?
                .map_or_else(|| occurred_at.to_owned(), |project| project.updated_at);
            Ok(vec![make_event(
                "project.meta-updated",
                "project",
                project_id,
                occurred_at,
                command_id,
                metadata,
                json!({
                    "projectId": project_id,
                    "repositoryIdentity": repository_identity,
                    "updatedAt": updated_at,
                }),
            )])
        }
```

(`wrap_persistence` is the helper used at `engine.rs:1100`; `updated_at` is a `Timestamp` — if it is not `String`, use `project.updated_at.to_string()` the way other arms serialize it.)

- [ ] **Step 5: Project the event**

In the `"project.meta-updated"` projector arm, extend the SQL and params:

```rust
            "UPDATE projection_projects SET title = COALESCE(?, title), workspace_root = COALESCE(?, workspace_root), default_model_selection_json = CASE WHEN ? THEN ? ELSE default_model_selection_json END, scripts_json = COALESCE(?, scripts_json), worktree_discovery_json = CASE WHEN ? THEN ? ELSE worktree_discovery_json END, repository_identity_json = CASE WHEN ? THEN ? ELSE repository_identity_json END, updated_at = ? WHERE project_id = ?",
```

with these two params inserted before `required_str(payload, "updatedAt")?`:

```rust
                payload.get("repositoryIdentity").is_some(),
                optional_json_string(payload.get("repositoryIdentity"))?,
```

- [ ] **Step 6: Run tests**

Run: `cargo test -p bibcode-server --lib -j 2 repository_identity_set` → PASS.
Run: `cargo test -p bibcode-server --lib -j 2 orchestration::engine` → PASS.
Run: `cargo test -p bibcode-server --lib -j 2 dispatch` → PASS (client dispatch of the new type is rejected by the existing `is_server_internal` guard in `orchestration_rpc.rs:274`).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/orchestration/engine.rs
git commit -m "feat(server): server-internal repository identity command"
```

---

### Task 4: Reconcile identities on create, workspace move, startup and catalog scans

**Files:**
- Create: `apps/server/src/production/repository_identity.rs`
- Modify: `apps/server/src/production/mod.rs` (add `mod repository_identity;`)
- Modify: `apps/server/src/production/orchestration_effects.rs:397-440,563-572,575-615`
- Modify: `apps/server/src/production/worktree_catalog_rpc.rs:470-480,615-635`

**Interfaces:**
- Consumes: Task 1 `repository_identity`, Task 3 command, `GitRepository::{repository_root, origin_url}`, `OrchestrationEngine::{repositories, dispatch}`.
- Produces:
  - `pub(crate) async fn reconcile_repository_identity(engine: &OrchestrationEngine, repository: &GitRepository, project_id: &str, cancellation: &CancellationToken) -> bool` (true when an update was dispatched)
  - `pub(crate) async fn backfill_repository_identities(engine: OrchestrationEngine, repository: Arc<GitRepository>, cancellation: CancellationToken)`
  - `pub(crate) struct RepositoryIdentityThrottle` with `admit(&self, project_id: &str, now: Instant) -> bool`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/production/repository_identity.rs` with tests first:

```rust
//! Keeps each project's server-authored repository identity in step with its `origin`.

#[cfg(test)]
mod tests {
    use std::{process::Command, time::{Duration, Instant}};

    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    use super::*;

    fn git(dir: &std::path::Path, args: &[&str]) {
        assert!(Command::new("git").args(args).current_dir(dir).status().unwrap().success());
    }

    async fn engine_with_project(root: &str) -> OrchestrationEngine {
        let database = crate::persistence::Database::open_in_memory().await.unwrap();
        database
            .call(|connection| {
                crate::persistence::run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .unwrap();
        let engine = OrchestrationEngine::start(database, crate::orchestration::EngineOptions::default())
            .await
            .unwrap();
        engine
            .dispatch(serde_json::from_value(serde_json::json!({
                "type":"project.create","commandId":"create","projectId":"p","title":"P",
                "workspaceRoot":root,"defaultModelSelection":null,"createdAt":"2026-10-05T00:00:00Z"
            })).unwrap())
            .await
            .unwrap();
        engine
    }

    async fn stored(engine: &OrchestrationEngine) -> Option<serde_json::Value> {
        engine.repositories().get_project("p".into()).await.unwrap().unwrap().repository_identity
    }

    #[tokio::test]
    async fn sets_identity_once_and_follows_origin_changes() {
        let checkout = TempDir::new().unwrap();
        git(checkout.path(), &["init", "-q"]);
        git(checkout.path(), &["remote", "add", "origin", "git@github.com:acme/repo.git"]);
        let root = checkout.path().to_string_lossy().replace('\\', "/");
        let engine = engine_with_project(&root).await;
        let git_repository = GitRepository::default();
        let cancel = CancellationToken::new();

        assert!(reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        assert_eq!(stored(&engine).await.unwrap()["canonicalKey"], "github.com/acme/repo");
        assert!(!reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);

        git(checkout.path(), &["remote", "set-url", "origin", "https://gitlab.com/acme/other.git"]);
        assert!(reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        assert_eq!(stored(&engine).await.unwrap()["canonicalKey"], "gitlab.com/acme/other");

        git(checkout.path(), &["remote", "remove", "origin"]);
        assert!(reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        assert_eq!(stored(&engine).await, None);
    }

    #[tokio::test]
    async fn a_missing_checkout_keeps_the_stored_identity() {
        let checkout = TempDir::new().unwrap();
        git(checkout.path(), &["init", "-q"]);
        git(checkout.path(), &["remote", "add", "origin", "git@github.com:acme/repo.git"]);
        let root = checkout.path().to_string_lossy().replace('\\', "/");
        let engine = engine_with_project(&root).await;
        let git_repository = GitRepository::default();
        let cancel = CancellationToken::new();
        assert!(reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        drop(checkout);
        assert!(!reconcile_repository_identity(&engine, &git_repository, "p", &cancel).await);
        assert_eq!(stored(&engine).await.unwrap()["canonicalKey"], "github.com/acme/repo");
    }

    #[test]
    fn throttle_admits_each_project_once_per_interval() {
        let throttle = RepositoryIdentityThrottle::default();
        let start = Instant::now();
        assert!(throttle.admit("p", start));
        assert!(!throttle.admit("p", start + Duration::from_secs(10)));
        assert!(throttle.admit("q", start));
        assert!(throttle.admit("p", start + RepositoryIdentityThrottle::INTERVAL));
    }
}
```

Add `mod repository_identity;` to `production/mod.rs`. (If `run_migrations`, `Database` or `EngineOptions` live at different paths, use the imports at the top of `orchestration/engine.rs`'s test module.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bibcode-server --lib -j 2 production::repository_identity`
Expected: FAIL to compile ("cannot find function `reconcile_repository_identity`").

- [ ] **Step 3: Implement the module**

Insert above the tests:

```rust
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    git::{GitCommandError, GitRepository},
    orchestration::{OrchestrationCommand, OrchestrationEngine},
    source_control::repository_identity::repository_identity,
};

async fn read_repository_identity(
    repository: &GitRepository,
    workspace_root: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<Value>, GitCommandError> {
    let Some(root) = repository.repository_root(workspace_root, cancellation).await? else {
        return Ok(None);
    };
    let Some(remote) = repository.origin_url(workspace_root, cancellation).await? else {
        return Ok(None);
    };
    Ok(repository_identity(&remote, &root.to_string_lossy().replace('\\', "/")))
}

/// Dispatches an identity update when the checkout's `origin` no longer matches
/// the stored identity. An unreadable or missing checkout keeps the stored value.
pub(crate) async fn reconcile_repository_identity(
    engine: &OrchestrationEngine,
    repository: &GitRepository,
    project_id: &str,
    cancellation: &CancellationToken,
) -> bool {
    let Ok(Some(project)) = engine.repositories().get_project(project_id.to_owned()).await else {
        return false;
    };
    let workspace_root = Path::new(&project.workspace_root);
    if project.deleted_at.is_some() || !tokio::fs::try_exists(workspace_root).await.unwrap_or(false) {
        return false;
    }
    let observed = match read_repository_identity(repository, workspace_root, cancellation).await {
        Ok(observed) => observed,
        Err(error) => {
            tracing::debug!(project_id, %error, "repository identity read failed; keeping the stored value");
            return false;
        }
    };
    if observed == project.repository_identity {
        return false;
    }
    let command = OrchestrationCommand::ProjectRepositoryIdentitySet {
        command_id: format!("repository-identity:{}", Uuid::new_v4()),
        project_id: project_id.to_owned(),
        repository_identity: observed,
    };
    match engine.dispatch(command).await {
        Ok(_) => true,
        Err(error) => {
            tracing::warn!(project_id, %error, "could not record the repository identity");
            false
        }
    }
}

/// One sequential startup pass so existing projects group without being re-added.
pub(crate) async fn backfill_repository_identities(
    engine: OrchestrationEngine,
    repository: Arc<GitRepository>,
    cancellation: CancellationToken,
) {
    let Ok(projects) = engine.repositories().list_projects().await else {
        return;
    };
    for project in projects.into_iter().filter(|project| project.deleted_at.is_none()) {
        if cancellation.is_cancelled() {
            return;
        }
        reconcile_repository_identity(&engine, &repository, &project.project_id, &cancellation).await;
    }
}

/// ponytail: one global map, fine for hundreds of projects; prune it if projects ever churn heavily.
#[derive(Clone, Default)]
pub(crate) struct RepositoryIdentityThrottle(Arc<Mutex<HashMap<String, Instant>>>);

impl RepositoryIdentityThrottle {
    pub(crate) const INTERVAL: Duration = Duration::from_secs(300);

    pub(crate) fn admit(&self, project_id: &str, now: Instant) -> bool {
        let mut checked = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if checked
            .get(project_id)
            .is_some_and(|last| now.duration_since(*last) < Self::INTERVAL)
        {
            return false;
        }
        checked.insert(project_id.to_owned(), now);
        true
    }
}
```

Fix import paths to match the crate (`crate::git::GitRepository` is used by `production/orchestration_effects.rs`; copy its `use` lines). Make `GitRepository::origin_url` reachable (it is `pub(crate)`).

Run: `cargo test -p bibcode-server --lib -j 2 production::repository_identity` → PASS (3 tests).

- [ ] **Step 4: React to project creation and workspace moves**

In `production/orchestration_effects.rs`:

1. `is_reactor_event`: add `| "project.created" | "project.meta-updated"` to the `matches!` list.
2. `run_worker` and `process_event` gain a `repository: &GitRepository` / `Arc<GitRepository>` parameter; `OrchestrationEffects::start` passes `repository.clone()` into `run_worker`.
3. In `process_event` add arms before the fallback:

```rust
        "project.created" => {
            if let Some(project_id) = event.event.payload.get("projectId").and_then(Value::as_str) {
                reconcile_repository_identity(engine, repository, project_id, cancellation).await;
            }
            Ok(())
        }
        // Only a moved workspace changes the checkout; the identity update itself carries no
        // workspaceRoot, so this cannot loop.
        "project.meta-updated" if event.event.payload.get("workspaceRoot").is_some() => {
            if let Some(project_id) = event.event.payload.get("projectId").and_then(Value::as_str) {
                reconcile_repository_identity(engine, repository, project_id, cancellation).await;
            }
            Ok(())
        }
```

4. In `OrchestrationEffects::start`, before `let worker = tokio::spawn(...)`, spawn the backfill:

```rust
        tokio::spawn(backfill_repository_identities(
            engine.clone(),
            repository.clone(),
            cancellation.child_token(),
        ));
```

5. Import `super::repository_identity::{backfill_repository_identities, reconcile_repository_identity}`.

Add a test in the effects test module (follow the existing `OrchestrationEffects::start` test setup in this file):

```rust
    #[tokio::test]
    async fn created_projects_receive_their_repository_identity() {
        // Arrange: a temp checkout with origin git@github.com:acme/repo.git, effects started
        // with GitRepository::default(), then dispatch project.create for that checkout.
        // Act: wait (bounded, 5 s) until get_project("p").repository_identity is Some.
        // Assert: canonicalKey == "github.com/acme/repo" and exactly one
        // project.meta-updated event carrying repositoryIdentity was appended.
    }
```

Write the body using this file's existing effects test harness (search for `OrchestrationEffects::start(` in its tests) and the `git` helper pattern from Step 1; poll with `tokio::time::timeout(Duration::from_secs(5), async { loop { …; tokio::time::sleep(Duration::from_millis(20)).await } })`. Count events with `engine.repositories()` event-log reads used elsewhere in that test module.

- [ ] **Step 5: Refresh after healthy catalog scans (throttled)**

In `production/worktree_catalog_rpc.rs`:

1. Extend `BranchReconciliationObserver` with `git: Option<Arc<GitRepository>>` and `identity_throttle: RepositoryIdentityThrottle`; construct it in `WorktreeCatalogRpcServices::new` with `git: catalog.git_repository()` and `identity_throttle: RepositoryIdentityThrottle::default()` (keep `#[derive(Clone)]`).
2. At the start of `BranchReconciliationObserver::reconcile`, after the authoritative/`Ready` early return, add:

```rust
        if let Some(git) = self.git.as_deref()
            && self.identity_throttle.admit(&project_id, std::time::Instant::now())
        {
            reconcile_repository_identity(&self.orchestration, git, &project_id, &CancellationToken::new())
                .await;
        }
```

3. Make `RepositoryIdentityThrottle` and `reconcile_repository_identity` `pub(crate)` imports from `super::repository_identity`.

Run: `cargo test -p bibcode-server --lib -j 2 worktree_catalog_rpc` → PASS.

- [ ] **Step 6: Run the server suite slice and lint**

Run: `cargo test -p bibcode-server --lib -j 2 repository_identity orchestration_effects worktree_catalog_rpc`
Expected: PASS.
Run: `cargo fmt --all --check && cargo clippy -p bibcode-server --all-targets -j 2 -- -D warnings`
Expected: no output / no warnings.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/production
git commit -m "feat(server): reconcile project repository identities"
```

---

### Task 5: Find drafts stored before a project gained an identity

**Files:**
- Modify: `apps/web/src/composerDraftStore.ts:347-348,2256-2274`
- Modify: `apps/web/src/hooks/useHandleNewThread.ts:73-80`
- Modify: `apps/web/src/components/ChatView.tsx:2231-2235`
- Test: `apps/web/src/composerDraftStore.test.ts`

**Interfaces:**
- Produces: `getDraftSessionByLogicalProjectKey(logicalProjectKey: string, fallbackKeys?: readonly string[]): ProjectDraftSession | null` (same for `getDraftThreadByLogicalProjectKey`).

- [ ] **Step 1: Write the failing test**

Inside the `describe` block that defines `projectRef`, `draftId` and `threadId` (the one containing "clears branch and worktree context when remapping a draft to another environment") add:

```ts
  it("finds a draft stored under a project's earlier key through fallback keys", () => {
    const store = useComposerDraftStore.getState();
    const earlierKey = scopedProjectKey(projectRef);
    store.setLogicalProjectDraftThreadId(earlierKey, projectRef, draftId, { threadId });

    const current = useComposerDraftStore.getState();
    expect(current.getDraftSessionByLogicalProjectKey("github.com/acme/repo")).toBeNull();
    expect(
      current.getDraftSessionByLogicalProjectKey("github.com/acme/repo", [earlierKey])?.draftId,
    ).toBe(draftId);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/composerDraftStore.test.ts -t "earlier key"`
Expected: FAIL (the fallback call returns `null`).

- [ ] **Step 3: Implement**

Types (`:347-348`):

```ts
  getDraftThreadByLogicalProjectKey: (
    logicalProjectKey: string,
    fallbackKeys?: readonly string[],
  ) => ProjectDraftSession | null;
  getDraftSessionByLogicalProjectKey: (
    logicalProjectKey: string,
    fallbackKeys?: readonly string[],
  ) => ProjectDraftSession | null;
```

Implementation (`:2256-2274`):

```ts
        getDraftThreadByLogicalProjectKey: (logicalProjectKey, fallbackKeys) => {
          return get().getDraftSessionByLogicalProjectKey(logicalProjectKey, fallbackKeys);
        },
        getDraftSessionByLogicalProjectKey: (logicalProjectKey, fallbackKeys = []) => {
          for (const candidate of [logicalProjectKey, ...fallbackKeys]) {
            const normalizedLogicalProjectKey = logicalProjectDraftKey(candidate);
            if (normalizedLogicalProjectKey.length === 0) continue;
            const draftId =
              get().logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
            if (!draftId) continue;
            const draftThread = get().draftThreadsByThreadKey[draftId];
            if (!draftThread || isDraftThreadPromoting(draftThread)) continue;
            return toProjectDraftSession(DraftId.make(draftId), draftThread);
          }
          return null;
        },
```

Callers: in `hooks/useHandleNewThread.ts` replace
`getDraftSessionByLogicalProjectKey(logicalProjectKey)` with
`getDraftSessionByLogicalProjectKey(logicalProjectKey, project ? [derivePhysicalProjectKey(project)] : [])`;
in `components/ChatView.tsx` replace it with
`getDraftSessionByLogicalProjectKey(logicalProjectKey, [derivePhysicalProjectKey(activeProject)])`.
Import `derivePhysicalProjectKey` from `../logicalProject` (ChatView: `~/logicalProject` per its existing import style of `deriveLogicalProjectKeyFromSettings`).

The caller's existing `setLogicalProjectDraftThreadId(logicalProjectKey, …)` writes the draft under the new key on next use.

- [ ] **Step 4: Run tests**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/composerDraftStore.test.ts src/hooks src/components/ChatView`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/composerDraftStore.ts apps/web/src/composerDraftStore.test.ts apps/web/src/hooks/useHandleNewThread.ts apps/web/src/components/ChatView.tsx
git commit -m "fix(web): keep drafts reachable when a project gains a repository identity"
```

---

### Task 6: Persist the sidebar view and repository group expansion

**Files:**
- Modify: `apps/web/src/uiStateStore.ts`
- Test: `apps/web/src/uiStateStore.test.ts`

**Interfaces:**
- Produces: `export type SidebarView = "environments" | "repositories"`; `UiState.sidebarView: SidebarView`; `UiState.repositoryGroupExpandedById: Record<string, boolean>`; pure `setSidebarView(state, view)`, `setRepositoryGroupExpanded(state, key, expanded)`; store actions `setSidebarView(view)`, `setRepositoryGroupExpanded(key, expanded)`.

- [ ] **Step 1: Write the failing test**

Add to `uiStateStore.test.ts` (import the new names from `./uiStateStore`):

```ts
describe("sidebar view preference", () => {
  it("defaults to environments and restores persisted values", () => {
    expect(parsePersistedState({}).sidebarView).toBe("environments");
    expect(parsePersistedState({ sidebarView: "bogus" as never }).sidebarView).toBe("environments");
    const restored = parsePersistedState({
      sidebarView: "repositories",
      repositoryGroupExpandedById: { "github.com/acme/repo": false },
    });
    expect(restored.sidebarView).toBe("repositories");
    expect(restored.repositoryGroupExpandedById).toEqual({ "github.com/acme/repo": false });
  });

  it("updates without copying unchanged state", () => {
    const state = parsePersistedState({});
    expect(setSidebarView(state, "environments")).toBe(state);
    expect(setSidebarView(state, "repositories").sidebarView).toBe("repositories");
    const collapsed = setRepositoryGroupExpanded(state, "key", false);
    expect(collapsed.repositoryGroupExpandedById).toEqual({ key: false });
    expect(setRepositoryGroupExpanded(collapsed, "key", false)).toBe(collapsed);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/uiStateStore.test.ts -t "sidebar view"`
Expected: FAIL (`setSidebarView` is not exported).

- [ ] **Step 3: Implement**

In `uiStateStore.ts`:

```ts
export type SidebarView = "environments" | "repositories";
```

- `PersistedUiState`: add `sidebarView?: SidebarView; repositoryGroupExpandedById?: Record<string, boolean>;`
- `UiProjectState`: add `sidebarView: SidebarView; repositoryGroupExpandedById: Record<string, boolean>;`
- `initialState`: add `sidebarView: "environments", repositoryGroupExpandedById: {},`
- `parsePersistedState` return: add
  ```ts
    sidebarView: parsed.sidebarView === "repositories" ? "repositories" : "environments",
    repositoryGroupExpandedById: sanitizeBooleanRecord(parsed.repositoryGroupExpandedById),
  ```
- `persistState` payload: add `sidebarView: state.sidebarView, repositoryGroupExpandedById: state.repositoryGroupExpandedById,`
- Pure setters (next to `setAgentsSectionExpanded`):
  ```ts
  export function setSidebarView(state: UiState, sidebarView: SidebarView): UiState {
    return state.sidebarView === sidebarView ? state : { ...state, sidebarView };
  }

  export function setRepositoryGroupExpanded(
    state: UiState,
    key: string,
    expanded: boolean,
  ): UiState {
    if (state.repositoryGroupExpandedById[key] === expanded) return state;
    return {
      ...state,
      repositoryGroupExpandedById: { ...state.repositoryGroupExpandedById, [key]: expanded },
    };
  }
  ```
- `UiStateStore` interface and `create(...)`: add
  ```ts
  setSidebarView: (view: SidebarView) => void;
  setRepositoryGroupExpanded: (key: string, expanded: boolean) => void;
  ```
  ```ts
  setSidebarView: (view) => set((state) => setSidebarView(state, view)),
  setRepositoryGroupExpanded: (key, expanded) =>
    set((state) => setRepositoryGroupExpanded(state, key, expanded)),
  ```

- [ ] **Step 4: Run tests**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/uiStateStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/uiStateStore.ts apps/web/src/uiStateStore.test.ts
git commit -m "feat(web): remember the sidebar view and repository group expansion"
```

---

### Task 7: Repository grouping and environment card identity (pure logic)

**Files:**
- Create: `apps/web/src/components/sidebar/repositoryView.logic.ts`
- Test: `apps/web/src/components/sidebar/repositoryView.logic.test.ts`

**Interfaces:**
- Consumes: `EnvironmentRailCandidate`, `environmentLetterAvatar`, `isLocalRailCandidate`, `resolveEnvironmentRailStatus`, `EnvironmentRailStatus` from `./environmentRail.logic`; `SidebarProjectSnapshot` from `../../sidebarProjectGrouping`.
- Produces:
  ```ts
  export interface EnvironmentCardIdentity {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly isLocal: boolean;
    readonly avatar: string;
    readonly status: EnvironmentRailStatus;
    readonly statusLabel: string;
    readonly available: boolean;
  }
  export interface RepositoryGroup {
    readonly key: string;
    readonly title: string;
    readonly host: string | null;
    readonly showHost: boolean;
    readonly environmentCount: number;
    readonly cards: readonly SidebarProjectSnapshot[];
  }
  export function buildEnvironmentCardIdentities(
    candidates: readonly EnvironmentRailCandidate[],
  ): ReadonlyMap<EnvironmentId, EnvironmentCardIdentity>;
  export function groupProjectsByRepository(input: {
    readonly projects: readonly SidebarProjectSnapshot[];
    readonly environments: ReadonlyMap<EnvironmentId, EnvironmentCardIdentity>;
  }): RepositoryGroup[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { EnvironmentId, ProjectId } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { EnvironmentRailCandidate } from "./environmentRail.logic";
import { buildEnvironmentCardIdentities, groupProjectsByRepository } from "./repositoryView.logic";

const LOCAL = EnvironmentId.make("env-local");
const AI = EnvironmentId.make("env-ai");
const OFF = EnvironmentId.make("env-off");

function candidate(
  environmentId: EnvironmentId,
  label: string,
  overrides: Partial<EnvironmentRailCandidate> = {},
): EnvironmentRailCandidate {
  return {
    environmentId,
    label,
    isPrimary: false,
    isDesktopLocal: false,
    phase: "connected",
    compat: null,
    updateAvailable: false,
    ...overrides,
  };
}

const identities = buildEnvironmentCardIdentities([
  candidate(AI, "ai-server"),
  candidate(LOCAL, "This machine", { isPrimary: true }),
  candidate(OFF, "build box", { phase: "offline" }),
]);

function card(
  id: string,
  environmentId: EnvironmentId,
  workspaceRoot: string,
  canonicalKey: string | null,
  name = "repo",
): SidebarProjectSnapshot {
  return {
    id: ProjectId.make(id),
    environmentId,
    workspaceRoot,
    title: id,
    repositoryIdentity:
      canonicalKey === null
        ? null
        : {
            canonicalKey,
            locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}.git` },
            name,
          },
    projectKey: `${environmentId}:${workspaceRoot}`,
  } as unknown as SidebarProjectSnapshot;
}

describe("buildEnvironmentCardIdentities", () => {
  it("presents local, remote and offline environments", () => {
    expect(identities.get(LOCAL)).toMatchObject({
      label: "Local",
      isLocal: true,
      statusLabel: "This device",
      available: true,
    });
    expect(identities.get(AI)).toMatchObject({
      label: "ai-server",
      isLocal: false,
      avatar: "AS",
      status: "connected",
      statusLabel: "Connected",
    });
    expect(identities.get(OFF)).toMatchObject({
      status: "disconnected",
      statusLabel: "Offline",
      available: false,
    });
  });
});

describe("groupProjectsByRepository", () => {
  it("groups by canonical key, keeps input order, and puts Local first", () => {
    const groups = groupProjectsByRepository({
      environments: identities,
      projects: [
        card("a-ai", AI, "/work/a", "gitlab.example/team/a", "a"),
        card("b", LOCAL, "/home/b", "github.com/acme/b", "b"),
        card("a-local", LOCAL, "/home/a", "gitlab.example/team/a", "a"),
      ],
    });
    expect(groups.map((group) => group.key)).toEqual(["gitlab.example/team/a", "github.com/acme/b"]);
    expect(groups[0]!.cards.map((project) => project.id)).toEqual(["a-local", "a-ai"]);
    expect(groups[0]).toMatchObject({ title: "a", environmentCount: 2, showHost: false });
  });

  it("keeps two checkouts in one environment as two cards", () => {
    const [group] = groupProjectsByRepository({
      environments: identities,
      projects: [
        card("one", AI, "/work/a", "github.com/acme/a"),
        card("two", AI, "/work/a-copy", "github.com/acme/a"),
      ],
    });
    expect(group!.cards).toHaveLength(2);
    expect(group!.environmentCount).toBe(1);
  });

  it("titles identity-less projects by folder and shows hosts only on title clashes", () => {
    const groups = groupProjectsByRepository({
      environments: identities,
      projects: [
        card("plain", LOCAL, "C:\\work\\scratch", null),
        card("api-gh", LOCAL, "/a", "github.com/acme/api", "api"),
        card("api-gl", AI, "/b", "gitlab.com/acme/api", "api"),
      ],
    });
    expect(groups[0]).toMatchObject({ title: "scratch", host: null, showHost: false });
    expect(groups[1]).toMatchObject({ title: "api", host: "github.com", showHost: true });
    expect(groups[2]).toMatchObject({ title: "api", host: "gitlab.com", showHost: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/sidebar/repositoryView.logic.test.ts`
Expected: FAIL ("Failed to resolve import ./repositoryView.logic").

- [ ] **Step 3: Implement**

```ts
import type { EnvironmentId } from "@bibcode/contracts";

import { compareSidebarDisplayText, type SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  environmentLetterAvatar,
  isLocalRailCandidate,
  resolveEnvironmentRailStatus,
  type EnvironmentRailCandidate,
  type EnvironmentRailStatus,
} from "./environmentRail.logic";

export interface EnvironmentCardIdentity {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isLocal: boolean;
  readonly avatar: string;
  readonly status: EnvironmentRailStatus;
  readonly statusLabel: string;
  readonly available: boolean;
}

export interface RepositoryGroup {
  readonly key: string;
  readonly title: string;
  readonly host: string | null;
  readonly showHost: boolean;
  readonly environmentCount: number;
  readonly cards: readonly SidebarProjectSnapshot[];
}

function statusLabel(candidate: EnvironmentRailCandidate): string {
  switch (candidate.phase) {
    case "connected":
      return candidate.isPrimary ? "This device" : "Connected";
    case "connecting":
    case "reconnecting":
      return "Reconnecting";
    case "error":
      return "Connection error";
    default:
      return "Offline";
  }
}

export function buildEnvironmentCardIdentities(
  candidates: readonly EnvironmentRailCandidate[],
): ReadonlyMap<EnvironmentId, EnvironmentCardIdentity> {
  return new Map(
    candidates.map((candidate) => [
      candidate.environmentId,
      {
        environmentId: candidate.environmentId,
        label: candidate.isPrimary ? "Local" : candidate.label,
        isLocal: isLocalRailCandidate(candidate),
        avatar: environmentLetterAvatar(candidate.label),
        status: resolveEnvironmentRailStatus(candidate),
        statusLabel: statusLabel(candidate),
        available: candidate.phase === "connected",
      },
    ]),
  );
}

function folderName(workspaceRoot: string): string {
  return workspaceRoot.split(/[\\/]/).filter((segment) => segment.length > 0).at(-1) ?? workspaceRoot;
}

export function groupProjectsByRepository(input: {
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly environments: ReadonlyMap<EnvironmentId, EnvironmentCardIdentity>;
}): RepositoryGroup[] {
  const buckets = new Map<string, SidebarProjectSnapshot[]>();
  for (const project of input.projects) {
    const key = project.repositoryIdentity?.canonicalKey ?? project.projectKey;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(project);
    else buckets.set(key, [project]);
  }
  const isLocal = (project: SidebarProjectSnapshot) =>
    input.environments.get(project.environmentId)?.isLocal ?? false;
  const label = (project: SidebarProjectSnapshot) =>
    input.environments.get(project.environmentId)?.label ?? project.environmentId;
  const groups = [...buckets].map(([key, projects]) => {
    const identity = projects[0]!.repositoryIdentity ?? null;
    const cards = projects.toSorted(
      (left, right) =>
        Number(isLocal(right)) - Number(isLocal(left)) ||
        compareSidebarDisplayText(label(left), label(right)) ||
        compareSidebarDisplayText(left.workspaceRoot, right.workspaceRoot),
    );
    return {
      key,
      title: identity?.name ?? identity?.displayName ?? folderName(projects[0]!.workspaceRoot),
      host: identity ? (identity.canonicalKey.split("/")[0] ?? null) : null,
      environmentCount: new Set(cards.map((card) => card.environmentId)).size,
      cards,
    };
  });
  const titleCounts = new Map<string, number>();
  for (const group of groups) {
    const folded = group.title.toLowerCase();
    titleCounts.set(folded, (titleCounts.get(folded) ?? 0) + 1);
  }
  return groups.map((group) => ({
    ...group,
    showHost: group.host !== null && (titleCounts.get(group.title.toLowerCase()) ?? 0) > 1,
  }));
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/sidebar/repositoryView.logic.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/sidebar/repositoryView.logic.ts apps/web/src/components/sidebar/repositoryView.logic.test.ts
git commit -m "feat(web): group sidebar projects by repository"
```

---

### Task 8: Environment presentation of the existing project node

**Files:**
- Modify: `apps/web/src/components/sidebar/EnvironmentRail.tsx:28-57` (export the status dot)
- Create: `apps/web/src/components/sidebar/EnvironmentCardHeader.tsx`
- Modify: `apps/web/src/sidebarProjectGrouping.ts:18-31` (optional `sharedExpansionKey`)
- Modify: `apps/web/src/components/Sidebar.tsx:576-582` (expansion keys), `:1674-1715` (props), `:3239-3290` (header)
- Test: `apps/web/src/components/sidebar/EnvironmentCardHeader.test.tsx`, `apps/web/src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: Task 7 `EnvironmentCardIdentity`.
- Produces:
  - `export function EnvironmentStatusDot({ status, className }: { status: EnvironmentRailStatus; className?: string })` from `EnvironmentRail.tsx`
  - `export const EnvironmentCardHeader: (props: { identity: EnvironmentCardIdentity; workspaceRoot: string }) => JSX.Element` with `data-testid="environment-card-header-<environmentId>"`
  - `SidebarProjectSnapshot.sharedExpansionKey?: string`
  - `SidebarProjectItemProps.environmentCard?: EnvironmentCardIdentity | null`

- [ ] **Step 1: Write the failing tests**

`EnvironmentCardHeader.test.tsx`:

```tsx
import { EnvironmentId } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentCardHeader } from "./EnvironmentCardHeader";

describe("EnvironmentCardHeader", () => {
  it("names the environment, its state and the checkout path", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentCardHeader
        identity={{
          environmentId: EnvironmentId.make("env-ai"),
          label: "ai-server",
          isLocal: false,
          avatar: "AS",
          status: "connected",
          statusLabel: "Connected",
          available: true,
        }}
        workspaceRoot="/work/tripunkt/pathfinder-application-server"
      />,
    );
    expect(markup).toContain('data-testid="environment-card-header-env-ai"');
    expect(markup).toContain("ai-server");
    expect(markup).toContain("Connected");
    expect(markup).toContain("AS");
    expect(markup).toContain("/work/tripunkt/pathfinder-application-server");
  });
});
```

In `Sidebar.test.tsx`, beside "collapses a project but keeps the active thread row visible", add:

```tsx
  it("writes an environment card's expansion to the repository row's key too", () => {
    groupedScenario();
    h.uiStore.setState({ sidebarView: "repositories" });
    render(<Sidebar />);
    const header = mustFindProps(byTestId(`environment-card-header-${ENV_REMOTE}`), "card header");
    expect(header).toBeDefined();
    const toggle = mustFindProps(
      (props) =>
        props["aria-expanded"] !== undefined &&
        typeof props["onClick"] === "function" &&
        String(props["className"] ?? "").includes("group-hover/project-header"),
      "environment card toggle",
    );
    invoke(toggle, "onClick", mouseEvent());
    expect(h.spies.setProjectExpanded).toHaveBeenCalledWith(
      expect.arrayContaining(["github.com/acme/repo-a"]),
      false,
    );
  });
```

(`groupedScenario` uses the default `repository` grouping, so the Environments row's key is `github.com/acme/repo-a`. If `mustFindProps` returns the first match and that is the Local card, the assertion still holds because both cards share the repository key.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/sidebar/EnvironmentCardHeader.test.tsx src/components/Sidebar.test.tsx -t "environment"`
Expected: FAIL (module missing; `sidebarView` ignored).

- [ ] **Step 3: Export the status dot**

In `EnvironmentRail.tsx` replace `function StatusDot(...)` with:

```tsx
export function EnvironmentStatusDot({
  status,
  className = "absolute right-0.5 bottom-0.5",
}: {
  readonly status: EnvironmentRailStatus;
  readonly className?: string;
}) {
  return (
    <span
      data-status={status}
      className={cn("size-2 rounded-full border-2 border-sidebar", className, STATUS_DOT_CLASS[status])}
    />
  );
}
```

and rename the file's `<StatusDot` usages to `<EnvironmentStatusDot`.

- [ ] **Step 4: Create the header**

`EnvironmentCardHeader.tsx`:

```tsx
import { MonitorIcon } from "lucide-react";
import { memo } from "react";

import { EnvironmentStatusDot } from "./EnvironmentRail";
import type { EnvironmentCardIdentity } from "./repositoryView.logic";

/** Replaces the project favicon and name when a project node is shown inside a repository group. */
export const EnvironmentCardHeader = memo(function EnvironmentCardHeader({
  identity,
  workspaceRoot,
}: {
  readonly identity: EnvironmentCardIdentity;
  readonly workspaceRoot: string;
}) {
  return (
    <span
      className="flex min-w-0 flex-1 items-center gap-2"
      data-testid={`environment-card-header-${identity.environmentId}`}
    >
      <span className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-foreground">
        {identity.isLocal ? <MonitorIcon aria-hidden className="size-3.5" /> : identity.avatar}
        <EnvironmentStatusDot status={identity.status} className="absolute -right-0.5 -bottom-0.5" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground/90">{identity.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{identity.statusLabel}</span>
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground" title={workspaceRoot}>
          {workspaceRoot}
        </span>
      </span>
    </span>
  );
});
```

- [ ] **Step 5: Wire the presentation into the project node**

1. `sidebarProjectGrouping.ts` `SidebarProjectSnapshot`: add

```ts
  // Repositories view: the Environments row key that shares this card's expansion.
  sharedExpansionKey?: string;
```

2. `Sidebar.tsx` `projectExpansionPreferenceKeys`:

```ts
function projectExpansionPreferenceKeys(project: SidebarProjectSnapshot): string[] {
  return [
    project.projectKey,
    ...(project.sharedExpansionKey ? [project.sharedExpansionKey] : []),
    ...project.memberProjects.map((member) => member.physicalProjectKey),
    ...project.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
}
```

3. `SidebarProjectItemProps`: add `environmentCard?: EnvironmentCardIdentity | null;` and destructure `environmentCard = null` in `SidebarProjectItem`.

4. In the header JSX replace

```tsx
          <ProjectFavicon environmentId={project.environmentId} cwd={project.workspaceRoot} />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            …name and "N projects"…
          </span>
```

with

```tsx
          {environmentCard ? (
            <EnvironmentCardHeader identity={environmentCard} workspaceRoot={project.workspaceRoot} />
          ) : (
            <>
              <ProjectFavicon environmentId={project.environmentId} cwd={project.workspaceRoot} />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-[13px] font-medium text-foreground/90">
                  {project.displayName}
                </span>
                {project.groupedProjectCount > 1 ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {project.groupedProjectCount} projects
                  </span>
                ) : null}
              </span>
            </>
          )}
```

5. Dim unavailable environments: on the `<div className="group/project-header relative">` wrapper use
`className={`group/project-header relative ${environmentCard && !environmentCard.available ? "opacity-60" : ""}`}`.

6. Import `EnvironmentCardHeader` and the `EnvironmentCardIdentity` type.

(The `Sidebar.test.tsx` test passes only after Task 9 builds environment cards; keep it and confirm it in Task 9.)

- [ ] **Step 6: Run tests**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/sidebar src/components/Sidebar.test.tsx -t "EnvironmentCardHeader|EnvironmentRail|collapses"`
Expected: header and rail tests PASS; existing Sidebar tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/sidebar/EnvironmentRail.tsx apps/web/src/components/sidebar/EnvironmentCardHeader.tsx apps/web/src/components/sidebar/EnvironmentCardHeader.test.tsx apps/web/src/sidebarProjectGrouping.ts apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx
git commit -m "feat(web): environment presentation for sidebar project nodes"
```

---

### Task 9: The Repositories view, its toggle, and the hidden rail

**Files:**
- Create: `apps/web/src/components/sidebar/SidebarViewToggle.tsx`
- Create: `apps/web/src/components/sidebar/SidebarRepositoryGroup.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx` (default `Sidebar` pipeline `:4212-4500`, jump labels `:4713-4728`, `SidebarProjectsContent` props `:3905-3990` and list render `:4082-4190`, body `:4980-4990`)
- Modify: `apps/web/src/components/AppSidebarLayout.tsx:178-183`
- Modify: `apps/web/src/components/Sidebar.testHarness.tsx:213-223`
- Test: `apps/web/src/components/Sidebar.test.tsx`, `apps/web/src/components/AppSidebarLayout` test (existing file for the layout; create `AppSidebarLayout.rail.test.tsx` if none renders the rail)

**Interfaces:**
- Consumes: Tasks 6, 7, 8.
- Produces: `SidebarViewToggle` (no props), `SidebarRepositoryGroup` (`{ group: RepositoryGroup; expanded: boolean; onToggle: () => void; children: ReactNode }`).

- [ ] **Step 1: Extend the test harness**

In `Sidebar.testHarness.tsx` add to the fake `uiStore`:

```ts
    sidebarView: "environments" as "environments" | "repositories",
    repositoryGroupExpandedById: {} as Record<string, boolean>,
    setSidebarView: vi.fn((view: "environments" | "repositories") =>
      uiStore.setState({ sidebarView: view }),
    ),
    setRepositoryGroupExpanded: vi.fn((key: string, expanded: boolean) =>
      uiStore.setState({
        repositoryGroupExpandedById: {
          ...(uiStore.getState() as { repositoryGroupExpandedById: Record<string, boolean> })
            .repositoryGroupExpandedById,
          [key]: expanded,
        },
      }),
    ),
```

(If `makeStore`'s `setState` is not available inside its own initializer, declare the two spies on `spies` and update state in the test instead.)

- [ ] **Step 2: Write the failing tests**

In `Sidebar.test.tsx`:

```tsx
  it("groups every environment's checkout of a repository under one read-only card", () => {
    groupedScenario();
    h.uiStore.setState({ sidebarView: "repositories" });
    const markup = render(<Sidebar />);
    expect(markup.match(/data-testid="repository-group-github\.com\/acme\/repo-a"/g)).toHaveLength(1);
    expect(markup).toContain(`data-testid="environment-card-header-${ENV_MAIN}"`);
    expect(markup).toContain(`data-testid="environment-card-header-${ENV_REMOTE}"`);
    expect(markup).toContain("2 environments");
    expect(markup).toContain("Repositories · all environments");
    expect(markup).not.toContain('data-testid="sidebar-add-project-trigger"');
    expect(markup).not.toContain('data-testid="repository-group-actions"');
  });

  it("lists every environment's projects even when one environment is selected", () => {
    groupedScenario();
    h.state.activeEnvironmentId = ENV_REMOTE;
    h.uiStore.setState({ sidebarView: "repositories" });
    const markup = render(<Sidebar />);
    expect(markup).toContain(`data-testid="environment-card-header-${ENV_MAIN}"`);
  });

  it("hides a collapsed repository group's environment cards", () => {
    groupedScenario();
    h.uiStore.setState({
      sidebarView: "repositories",
      repositoryGroupExpandedById: { "github.com/acme/repo-a": false },
    });
    const markup = render(<Sidebar />);
    expect(markup).toContain('data-testid="repository-group-github.com/acme/repo-a"');
    expect(markup).not.toContain("environment-card-header-");
  });

  it("switches views from the toggle", () => {
    baseScenario();
    render(<Sidebar />);
    const repositories = mustFindProps(byAriaLabel("Repositories view"), "repositories toggle");
    invoke(repositories, "onClick", mouseEvent());
    expect(h.uiStore.getState().setSidebarView).toHaveBeenCalledWith("repositories");
  });
```

For the rail, add to the layout test file:

```tsx
  it("does not render the environment rail in the Repositories view", () => {
    useUiStateStore.setState({ sidebarView: "repositories" });
    const markup = renderLayout();
    expect(markup).not.toContain('aria-label="Environments"');
    useUiStateStore.setState({ sidebarView: "environments" });
    expect(renderLayout()).toContain('aria-label="Environments"');
  });
```

using that file's existing render helper (name it `renderLayout` only if no helper exists; check the rail's actual `aria-label` in `EnvironmentRail.tsx` and assert on it).

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/Sidebar.test.tsx -t "repository|toggle|environment card"`
Expected: FAIL (no repository groups rendered).

- [ ] **Step 4: Create the toggle and group components**

`SidebarViewToggle.tsx`:

```tsx
import { FolderGit2Icon, ServerIcon } from "lucide-react";
import { memo } from "react";

import { useUiStateStore, type SidebarView } from "../../uiStateStore";

const OPTIONS: ReadonlyArray<{ view: SidebarView; label: string; Icon: typeof ServerIcon }> = [
  { view: "environments", label: "Environments", Icon: ServerIcon },
  { view: "repositories", label: "Repositories", Icon: FolderGit2Icon },
];

export const SidebarViewToggle = memo(function SidebarViewToggle() {
  const sidebarView = useUiStateStore((state) => state.sidebarView);
  const setSidebarView = useUiStateStore((state) => state.setSidebarView);
  return (
    <div role="group" aria-label="Sidebar view" className="mx-2 mb-2 grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5">
      {OPTIONS.map(({ view, label, Icon }) => (
        <button
          key={view}
          type="button"
          aria-label={`${label} view`}
          aria-pressed={sidebarView === view}
          onClick={() => setSidebarView(view)}
          className={`flex h-7 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
            sidebarView === view ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Icon aria-hidden className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
});
```

`SidebarRepositoryGroup.tsx`:

```tsx
import { ChevronRightIcon, FolderGit2Icon } from "lucide-react";
import { memo, useId, type ReactNode } from "react";

import { SidebarMenuItem } from "../ui/sidebar";
import type { RepositoryGroup } from "./repositoryView.logic";

/** A read-only grouping: no menu, rename, remove or drag. */
export const SidebarRepositoryGroup = memo(function SidebarRepositoryGroup({
  group,
  expanded,
  onToggle,
  children,
}: {
  readonly group: RepositoryGroup;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  const listId = useId();
  return (
    <SidebarMenuItem className="rounded-[10px] border border-border/75 bg-muted/30 p-1">
      <section aria-label={`Repository ${group.title}`} data-testid={`repository-group-${group.key}`}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={onToggle}
          className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={`size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
          <FolderGit2Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
            {group.title}
            {group.showHost && group.host ? (
              <span className="font-normal text-muted-foreground"> · {group.host}</span>
            ) : null}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {group.environmentCount} {group.environmentCount === 1 ? "environment" : "environments"}
          </span>
        </button>
        {expanded ? (
          <ul id={listId} className="mt-1 flex flex-col gap-1.5">
            {children}
          </ul>
        ) : null}
      </section>
    </SidebarMenuItem>
  );
});
```

(Check the import path of `SidebarMenuItem` against `Sidebar.tsx`'s own import and match it.)

- [ ] **Step 5: Run the project pipeline over all environments in the Repositories view**

In the default `Sidebar()` component:

```tsx
  const sidebarView = useUiStateStore((store) => store.sidebarView);
  const repositoriesView = sidebarView === "repositories";
```

Change `projects` and `sidebarThreads` to skip the rail filter in the Repositories view:

```tsx
  const projects = useMemo(
    () =>
      repositoriesView || visibleEnvironmentIds === null
        ? allProjects
        : allProjects.filter((project) => visibleEnvironmentIds.has(project.environmentId)),
    [allProjects, repositoriesView, visibleEnvironmentIds],
  );
```

(same shape for `sidebarThreads` with `allSidebarThreads`). Add, next to `projectGroupingSettings` (`:4274`):

```tsx
  // One project node per environment checkout; repositories are grouped at render time.
  const effectiveGroupingSettings = useMemo(
    () =>
      repositoriesView
        ? { sidebarProjectGroupingMode: "separate" as const, sidebarProjectGroupingOverrides: {} }
        : projectGroupingSettings,
    [projectGroupingSettings, repositoriesView],
  );
```

Use `effectiveGroupingSettings` instead of `projectGroupingSettings` in `physicalToLogicalKey` and `sidebarProjects`. In `sidebarProjects`, add the shared expansion key in the Repositories view:

```tsx
  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(() => {
    const snapshots = buildSidebarProjectSnapshots({
      projects: orderedProjects,
      settings: effectiveGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      isDesktopLocalEnvironment: (environmentId) => desktopLocalEnvironmentIds.has(environmentId),
    });
    return repositoriesView
      ? snapshots.map((snapshot) => ({
          ...snapshot,
          sharedExpansionKey: deriveLogicalProjectKeyFromSettings(snapshot, projectGroupingSettings),
        }))
      : snapshots;
  }, [
    environmentLabelById,
    desktopLocalEnvironmentIds,
    effectiveGroupingSettings,
    orderedProjects,
    primaryEnvironmentId,
    projectGroupingSettings,
    repositoriesView,
  ]);
```

Build identities and groups after `sortedProjects`:

```tsx
  const environmentCardIdentities = useMemo(
    () =>
      buildEnvironmentCardIdentities(
        environments.map((environment) =>
          toEnvironmentRailCandidate({
            environmentId: environment.environmentId,
            label: environment.label,
            target: environment.entry.target,
            phase: environment.connection.phase,
            compat: resolveEnvironmentCompatVerdict(environment.serverConfig),
            updateAvailable: false,
          }),
        ),
      ),
    [environments],
  );
  const repositoryGroupExpandedById = useUiStateStore((store) => store.repositoryGroupExpandedById);
  const repositoryGroups = useMemo(
    () =>
      repositoriesView
        ? groupProjectsByRepository({ projects: sortedProjects, environments: environmentCardIdentities })
        : null,
    [environmentCardIdentities, repositoriesView, sortedProjects],
  );
  const visibleProjectsInOrder = useMemo(
    () =>
      repositoryGroups === null
        ? sortedProjects
        : repositoryGroups.flatMap((group) =>
            repositoryGroupExpandedById[group.key] === false ? [] : group.cards,
          ),
    [repositoryGroupExpandedById, repositoryGroups, sortedProjects],
  );
```

In `visibleSidebarThreadKeys` iterate `visibleProjectsInOrder` instead of `sortedProjects` (and update its dependency list). Pass `repositoryGroups`, `repositoryGroupExpandedById`, `environmentCardIdentities` and `repositoriesView` to `SidebarProjectsContent`.

- [ ] **Step 6: Render the groups**

In `SidebarProjectsContent` add the four props to its props interface. In the projects header:

```tsx
          <span className="text-xs font-medium text-muted-foreground">
            {repositoriesView ? "Repositories · all environments" : "Projects"}
          </span>
```

and wrap the add-project `<Tooltip>` in `{repositoriesView ? null : (…)}`.

Change the list to a three-way branch: `repositoryGroups !== null ? (…) : isManualProjectSorting ? (DndContext…) : (plain list…)`, where the new branch is:

```tsx
          <SidebarMenu className="gap-2" data-testid="sidebar-project-list">
            {repositoryGroups.map((group) => (
              <SidebarRepositoryGroup
                key={group.key}
                group={group}
                expanded={repositoryGroupExpandedById[group.key] !== false}
                onToggle={() =>
                  setRepositoryGroupExpanded(group.key, repositoryGroupExpandedById[group.key] === false)
                }
              >
                {group.cards.map((project) => (
                  <SidebarProjectListRow
                    key={project.projectKey}
                    project={project}
                    environmentCard={environmentCardIdentities.get(project.environmentId) ?? null}
                    isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                    activeRouteThreadKey={
                      activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                    }
                    moduleRouteActive={moduleRouteProjectKey === project.projectKey}
                    selectedProjectKey={selectedProjectKey}
                    selectProject={selectProject}
                    openCreateWorktreeDialog={openCreateWorktreeDialog}
                    archiveThread={archiveThread}
                    deleteThread={deleteThread}
                    threadJumpLabelByKey={threadJumpLabelByKey}
                    attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                    expandThreadListForProject={expandThreadListForProject}
                    collapseThreadListForProject={collapseThreadListForProject}
                    dragInProgressRef={dragInProgressRef}
                    suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                    suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
                    isManualProjectSorting={false}
                    dragHandleProps={null}
                  />
                ))}
              </SidebarRepositoryGroup>
            ))}
          </SidebarMenu>
```

with `const setRepositoryGroupExpanded = useUiStateStore((store) => store.setRepositoryGroupExpanded);` at the top of `SidebarProjectsContent`.

In the sidebar body (`:4986`) render the toggle and hide the context card in the Repositories view:

```tsx
          <SidebarViewToggle />
          {sidebarView === "repositories" ? null : <SidebarEnvironmentContextCard />}
```

(read `sidebarView` from `useUiStateStore` in that component).

- [ ] **Step 7: Hide the rail**

In `AppSidebarLayout.tsx`:

```tsx
  const sidebarView = useUiStateStore((state) => state.sidebarView);
  …
        <div className="flex h-full min-h-0 flex-row">
          {sidebarView === "repositories" ? null : <EnvironmentRail />}
```

- [ ] **Step 8: Run tests**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/Sidebar src/components/sidebar src/components/AppSidebarLayout src/uiStateStore.test.ts`
Expected: PASS, including Task 8's "writes an environment card's expansion…" test.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/sidebar/SidebarViewToggle.tsx apps/web/src/components/sidebar/SidebarRepositoryGroup.tsx apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/Sidebar.testHarness.tsx apps/web/src/components/AppSidebarLayout.tsx apps/web/src/components/AppSidebarLayout*.test.tsx
git commit -m "feat(web): Repositories view in the left panel"
```

---

### Task 10: Documentation, runbook and full validation

**Files:**
- Modify: `docs/architecture/overview.md` (Server component paragraph near `:49`)
- Modify: `docs/architecture/worktree-catalog.md:15,106-115`
- Modify: `docs/user/workspace-ui.md` (sidebar section near `:60-80`)
- Modify: `docs/testing/cross-platform-validation.md` (sidebar/environment checks)

- [ ] **Step 1: Architecture docs**

Add to `docs/architecture/overview.md`, after the sentence about the repository-key pin:

```markdown
  Each project also carries a server-authored `repositoryIdentity` derived from
  its checkout's `origin` remote: a canonical key of the lowercased host and the
  repository path without `.git`, plus the remote, name, owner, provider and
  checkout root. It lives in the rebuildable project projection and changes only
  through the server-internal `project.repository-identity.set` command, which
  emits `project.meta-updated` without changing `updatedAt`. The server sets it
  after project creation or a workspace move, in one startup backfill, and at
  most every five minutes per project after a healthy worktree-catalog scan; an
  unreadable or missing checkout keeps the stored value. Clients group projects
  by it but cannot set it. It is unrelated to the path-based repository-key pin,
  which fences worktree adoption on one machine.
```

Add a matching two-sentence note under the pin description in `docs/architecture/worktree-catalog.md` ("The pin is a local Git-common-directory hash; cross-environment grouping uses the separate `repositoryIdentity` described in the architecture overview.").

- [ ] **Step 2: User guide**

Add to `docs/user/workspace-ui.md` after the environment rail description:

```markdown
The **Environments | Repositories** switch at the top of the left panel picks
how projects are listed; the choice is remembered on this device.
**Environments** is the per-environment view described above. **Repositories**
hides the environment rail and lists one read-only card per Git repository,
matched by its `origin` remote, across every connected environment. Each card
holds one entry per checkout showing the environment, its connection state and
the folder path; that entry is the project itself, with the same menu, actions,
threads and worktrees. Projects without an `origin` get a card of their own
named after their folder. Unavailable environments appear dimmed.
```

- [ ] **Step 3: Validation runbook**

Add a step to `docs/testing/cross-platform-validation.md` in the sidebar section:

```markdown
Open one repository as a project on Local and on a remote environment. Switch
the left panel to **Repositories**: the environment rail disappears and one
card named after the repository lists both environments with their state and
path. Its `…` menu shows the normal project menu for that environment. Change
the remote checkout's `origin` with `git remote set-url` and, within five
minutes of the next catalog refresh, confirm the entry moves to its new card.
Switch back to **Environments** and confirm the rail returns with the same
environment selected.
```

- [ ] **Step 4: Full validation**

Run, from the repository root:

```bash
node scripts/run-local-vp.mjs check
node scripts/run-local-vp.mjs run -r --concurrency-limit 1 typecheck
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -j 2 -- -D warnings
cargo test -p bibcode-server --lib -j 2
cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/Sidebar src/components/sidebar src/composerDraftStore.test.ts src/uiStateStore.test.ts src/components/AppSidebarLayout && cd ../..
node scripts/run-local-vp.mjs run check:contracts
```

Expected: all pass; `check:contracts` reports no fixture diff (no contract schema changed).

Then review the changed React components and hooks against the `vercel-react-best-practices` skill and the changed UI against `UI.md` (toggle labels, read-only group, dimmed offline cards, hidden rail), as required by `AGENTS.md`.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/overview.md docs/architecture/worktree-catalog.md docs/user/workspace-ui.md docs/testing/cross-platform-validation.md
git commit -m "docs: document repository identity and the Repositories view"
```
