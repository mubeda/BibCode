# Sidebar Repositories view — design

Status: approved in conversation 2026-10-05; awaiting written-spec review.
Mockup: <https://claude.ai/artifact/HhWAtvCSxDfhNf7xmmmVar> (private to the
requester).

## Intent

Give the left panel a second way to see the whole working setup: organized by
repository across every environment instead of by environment. Today the
environment rail selects one environment and the panel lists that
environment's projects. The new view answers "where is this repository
checked out, and what is running there?" without switching environments.

What the user asked for:

- A toggle at the top of the left panel switches between the two views.
- In the second view each repository is a read-only group card named after the
  git project (example: `pathfinder-application-server`). It cannot be renamed,
  removed, or otherwise edited.
- Each group holds one card per environment that has the repository. The
  environment is easy to read on the card.
- An environment card is the original project node in a different
  presentation: it offers every project option the project has today.

Decisions made in review:

- "Same repository" means the same normalized `origin` remote URL (not the
  folder name).
- The server populates the existing `repositoryIdentity` project field, and
  both sidebar views use it. The Environments view's existing default grouping
  mode (`repository`) therefore starts merging same-origin projects within an
  environment. Users can still choose `separate`.

## Success criteria

1. With projects of one repository on Local and on a remote, the Repositories
   view shows one group with two environment cards, without switching the rail.
2. A project with no `origin` appears in its own folder-named group.
3. Every project action available in the Environments view (menu items, hover
   actions, thread cards, worktree discovery) is available from the
   environment card and acts on that environment's project.
4. The group card exposes no edit, menu, delete or drag affordance.
5. Changing `origin` on a checkout moves its card to the new group without a
   reload.
6. The view adds no client RPCs; grouping is derived from already loaded
   projects.

## Part 1 — Repository identity on the server

### Value

`repositoryIdentity` already exists in the contracts
(`packages/contracts/src/environment.ts` `RepositoryIdentity`, carried on
`OrchestrationProject`, `OrchestrationProjectShell`, `ProjectCreatedPayload`
and `ProjectMetaUpdatedPayload`). The server never sets it today. It will set:

| Field | Value |
| --- | --- |
| `canonicalKey` | `<host>/<repository path>`: host lowercased, path without a trailing `.git`, nested groups kept. SSH (`git@host:a/b.git`), `ssh://` (with or without port) and HTTPS forms of one remote yield the same key. Path case is preserved. |
| `locator` | `{ source: "git-remote", remoteName: "origin", remoteUrl: <raw url> }` |
| `rootPath` | The checkout's top level (`git rev-parse --show-toplevel`), not the common directory; required by the `repository_path` grouping mode. |
| `name` | Last path segment (`pathfinder-application-server`). |
| `owner` | Path before the last segment, when present. |
| `displayName` | Same as `name`. |
| `provider` | Kind from the existing provider detection (`github`, `gitlab`, `azure-devops`, `bitbucket`), omitted when unknown. |

A project whose checkout has no `origin` remote, or is not a Git repository,
has `repositoryIdentity: null`.

Normalization reuses `source_control::remote_host`,
`source_control::remote_repository_path`, `provider_from_remote` and
`GitRepository::origin_url`. No new URL parser is introduced.

### Storage and delivery

- New nullable `repository_identity_json` column on `projection_projects`
  (new migration). It is part of the rebuildable projection: the
  `project.created` and `project.meta-updated` projector paths write it, and
  event replay rebuilds it.
- `ProjectionProject` gains the field; `decode_project`, `upsert_project`, the
  projector SQL and every `ProjectionProject { .. }` literal are updated.
- `project_shell()` in `production/orchestration_rpc.rs` emits
  `repositoryIdentity`; both the WebSocket shell snapshot and the HTTP read
  model use it, and the snapshot stream already resends after each committed
  event, so connected clients receive changes immediately.
- The path-based project repository-key pin
  (`project_worktree_repository_pins`) is unchanged and remains the trusted
  fence for worktree adoption. It is a local hash of the Git common directory
  and cannot identify a repository across machines; the two values are
  independent.

### Computation triggers

1. Project creation: `prepare_project_create` returns the identity and the
   engine includes it in the `project.created` payload.
2. Startup backfill: one bounded pass over `list_projects()` after startup
   computes each identity and dispatches a server-resolved project meta update
   only when the stored value differs. A second startup emits nothing.
3. Worktree catalog scan of the primary checkout: recompute and dispatch an
   update only on change (for example after `git remote set-url`).

The read is one `git config --get remote.origin.url` plus `rev-parse
--show-toplevel` per project, bounded by the existing Git command limits and
cancellation. A failed read leaves the stored value unchanged (no update) and
is logged at debug level; it never clears a known identity.

### Trust boundary

`repositoryIdentity` is server-authored. Client `project.meta.update` commands
that contain it are rejected, as `worktreeDiscovery` already is
(`orchestration_rpc.rs`).

### Client compatibility

- Older servers keep omitting the field; clients treat it as absent.
- The `repositoryIdentity` capability flag is unchanged (already advertised).
- Composer drafts are keyed by logical project key
  (`composerDraftStore.ts`, `logicalProjectKey`). When a project gains an
  identity its logical key changes from the physical key to the canonical key.
  Lookups must find a draft stored under the project's previous physical key:
  resolve by canonical key first, then fall back to each member's physical
  key, and move the draft to the canonical key on first write. Verify whether
  existing migrations already cover this before adding code.

## Part 2 — Repositories view on the client

### Toggle

- A segmented control **Environments | Repositories** below the sidebar
  header, before the environment context card.
- The choice is a per-device preference in the persisted UI-state store
  (`uiStateStore`), default **Environments**. It is not a server setting.

### Data and grouping

- Source: every project from every connected environment
  (`useProjects()`), without the rail filter
  (`selectRailVisibleEnvironmentIds`).
- Group key: `repositoryIdentity.canonicalKey` across environments; a project
  without one forms its own group keyed by its physical key and titled by its
  folder name.
- Group title: `repositoryIdentity.name`. When two groups share a title, each
  adds its host as muted text (`api · github.com`).
- The view does not use `sidebarProjectGroupingMode`; it always groups by
  repository across environments. The Environments view keeps honoring the
  setting.
- Pure grouping logic lives in a `.logic.ts` module beside the existing
  `sidebarProjectGrouping.ts`, recomputed only when projects or environments
  change.

### Group card (read-only)

- Chevron, repository icon, name, and `N environment(s)`.
- No menu, rename, remove, drag, or hover actions.
- Expanded state is remembered per canonical key in the UI-state store
  (default expanded).
- Rendered as a labelled region: "Repository <name>".

### Environment card

- The existing project node (`SidebarProjectItem` and its thread list) with an
  environment presentation variant. It is not a copy: the menu
  (`buildProjectHeaderMenu`), hover actions (project actions, new worktree, Git
  Manager, Pull Requests), primary card, worktree cards, discovery section,
  show more/less and collapse use the existing code paths.
- The header replaces favicon and project name with: environment badge (Local
  monitor icon or the rail's letter avatar, with the rail's status dot),
  environment label, connection state text (Connected, This device,
  Reconnecting, Offline), and the project folder path in monospace, truncated.
- Expanded state reuses the project's existing expansion keys, so the same
  project collapses or expands consistently in both views.
- One environment with two checkouts of the repository shows two cards,
  distinguished by path.
- Unavailable environments: the card is dimmed and its actions behave as they
  do in the Environments view for that environment (disabled with the existing
  explanation).

### Order

- Groups follow the project sort setting, using the most recent activity among
  their cards; name sort uses the group title.
- Within a group: Local (primary, then desktop-local environments) first, then
  remotes by label.
- Manual project drag ordering is available only in the Environments view.

### Rail and header

- The rail stays visible for status, Add server and Manage remote servers. In
  the Repositories view no rail entry is selected; activating one switches to
  the Environments view with that environment selected.
- The environment context card is not shown in the Repositories view.
- The Projects header reads "Repositories · all environments"; sort stays and
  "Add project" is hidden (adding needs a target environment).
- Thread jump labels follow the visible order of the current view. Search is
  unchanged.

## Failure, lifecycle and performance

- Identity changes arrive through the snapshot stream; cards regroup without a
  reload and keep their expansion state.
- Grouping is recomputed from each snapshot, never accumulated, so duplicate or
  partial snapshots cannot leave stale cards.
- A removed environment's cards disappear; empty groups disappear.
- The view issues no requests. Server identity reads happen only at creation,
  startup backfill and existing catalog scans.

## Testing

Server (Rust):

- Normalization table: SSH, `ssh://` with port, HTTPS, nested GitLab groups,
  `.git` suffix, host case, IPv6 host, missing origin.
- `project.created` carries the identity; the shell snapshot emits it.
- Startup backfill sets missing identities and is idempotent.
- Catalog scan emits exactly one update after an origin change and none
  without a change; a failed read does not clear the value.
- Client meta updates containing `repositoryIdentity` are rejected.
- Migration adds the column; projection replay reproduces it.

Client:

- Grouping logic: cross-environment grouping, same-name repositories on
  different hosts, identity-less projects, two checkouts in one environment,
  ordering rules.
- Toggle persistence; rail activation from the Repositories view switches back
  with that environment selected.
- Environment card renders badge, label, state and path, and its menu equals the
  project menu for that environment.
- Shared expansion state between views; offline cards dimmed with disabled
  actions.
- Drafts created before a project gained an identity are still found.

## Documentation

Update in the same change: `docs/architecture/overview.md` and
`docs/architecture/worktree-catalog.md` (server-authored identity, how it is
computed, contrast with the path-based pin), `docs/user/workspace-ui.md` (the
toggle and the Repositories view), and
`docs/testing/cross-platform-validation.md` (manual check with one repository
on two environments). Regenerate contract fixtures only if a contract schema
changes (not expected).

## Out of scope

- Editing, renaming or ordering repository groups.
- Adding a project from the Repositories view.
- Grouping by remotes other than `origin`.
- Cross-environment actions (for example, one action applied to every
  environment of a repository).
