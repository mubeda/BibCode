# Create pull/merge request options — design

Status: approved in conversation 2026-10-06; spec awaiting review.

## Goal

The shared create dialog should offer the options GitLab's "New merge request"
page offers, with the GitHub equivalents where they exist, so a request is
created complete from BiBCode instead of being finished on the provider's site.

What the user asked for: draft, assignee (with "assign to me"), reviewer,
milestone, labels, delete source branch, squash. Assumed: the GitLab instance in
use is a tier with one assignee and one reviewer per merge request (its page
shows singular fields).

## Scope

In scope, set at creation:

| Field | GitLab | GitHub |
| --- | --- | --- |
| Draft | `Draft:` title prefix | `gh pr create --draft` |
| Assignee(s) + Assign to me | one user, `assignee_ids` | several, `--assignee` |
| Reviewer(s) | one user, `reviewer_ids` | several users, `--reviewer` |
| Labels | several, `labels` | several, `--label` |
| Milestone | one, `milestone_id` | one, `--milestone <title>` |
| Delete source branch on merge | `remove_source_branch` | not offered (repository setting) |
| Squash on merge | `squash` | not offered (chosen at merge time) |

Out of scope: automatic merge when checks pass, GitLab "Merge can start"
(`merge_after`), GitHub team reviewers, GitHub projects, multiple assignees or
reviewers on GitLab tiers that allow them, remembering choices between dialogs,
moving creation into the Pull Requests module (`pullRequests.create`).

## Current flow (unchanged except where stated)

- Dialog: `apps/web/src/components/gitManager/provider/GitManagerCreatePullRequestDialog.tsx`
  with pure logic in `GitManagerPullRequestPanel.logic.ts`. Four entry points:
  Pull Requests panel, Source Control panel, Git Manager pull request pane, chat
  Git actions.
- Request: `git.runStackedAction` with `create_pr` or `commit_push_pr`; input
  `GitRunStackedActionInput` (`packages/contracts/src/git.ts`), server
  `run_stacked_action` (`apps/server/src/production/git_vcs.rs`), creation in
  `PullRequestService::create` (`apps/server/src/source_control/pull_request.rs`)
  through `gh pr create` or `glab api --method POST projects/:fullpath/merge_requests`.
- Picker data: `pullRequests.getVocabulary { cwd, kind, query }` (labels,
  milestones, users). Entry ids: GitLab users and milestones use numeric ids,
  GitHub users use logins and milestones their number with the title as label;
  labels use names on both. Web hooks and pickers:
  `apps/web/src/components/pullRequests/edit/usePullRequestsVocabulary.ts`,
  `PullRequestsPicker.tsx` (single and multiple selection).

## Dialog

Order follows GitLab's page: Repository, Source → Target, Title, **☐ Mark as
draft** ("Drafts can't be merged until marked ready."), Description,
**Assignee** + **Assign to me**, **Reviewer**, **Milestone**, **Labels** (with
colours), then on GitLab only **Merge options**: ☐ Delete source branch when
merge request is accepted, ☐ Squash commits when merge request is accepted.

- Defaults: draft off; assignee, reviewer, labels, milestone empty; merge
  options from the GitLab project's settings. A project whose squash setting is
  `always` or `never` shows the box locked with a note naming the project
  setting.
- GitLab assignee and reviewer pickers select one user; GitHub's select
  several.
- Pickers load when the dialog opens and search as the user types. A picker
  that fails to load shows "Couldn't load <field> · Retry" in place; every new
  field is optional, so creation still works.
- The body scrolls; the Create button stays visible at the bottom.
- Without the server capability the new fields are not rendered and the dialog
  behaves as before.

## Contracts (`packages/contracts`)

- `GitRunStackedActionInput.pullRequestOptions` (optional):
  `{ draft: boolean; assignees: string[]; reviewers: string[]; labels: string[];
  milestone: { id: string; title: string } | null;
  removeSourceBranch: boolean | null; squash: boolean | null }`.
  Identifiers are vocabulary entry ids. Bounds: at most 20 assignees, 20
  reviewers, 50 labels; ids and titles are trimmed non-empty strings of at most
  255 characters.
- `GitRunStackedActionResult.pr.warning` (optional string): set when the
  request exists but an option was not applied.
- New read `pullRequests.getCreateDefaults { cwd }` →
  `{ viewer: { id: string; label: string } | null;
  squash: "never" | "always" | "default_on" | "default_off" | null;
  removeSourceBranch: boolean | null }`. GitHub returns `null` for the last two.
- Capability `pullRequestCreateOptions` (decodes as false for older servers).

## Server

- `validate_stacked_action_input` accepts `pullRequestOptions` only on
  `create_pr` and `commit_push_pr`, refuses `removeSourceBranch`/`squash` for
  GitHub, and enforces the bounds.
- `CreatePullRequestInput` gains the options.
  - GitHub: append `--draft`, one `--assignee`, `--reviewer` and `--label` per
    value, and `--milestone <title>`.
  - GitLab: send a JSON body (the transport the revert path already uses) with
    `assignee_ids`, `reviewer_ids`, `labels` (comma-joined names),
    `milestone_id`, `remove_source_branch`, `squash`. Draft adds `Draft: ` to
    the title unless it already starts with a `Draft:`/`[Draft]` marker.
- `pullRequests.getCreateDefaults` reuses the Pull Requests scope resolution:
  viewer from the existing current-user read; on GitLab one
  `projects/:path` read for `squash_option` and
  `remove_source_branch_after_merge`.
- Descriptor capability `pullRequestCreateOptions: true` in both descriptor
  builders, auth scope and method registration like the other Pull Requests
  reads.

## Client

- Dialog state holds the options; `createPullRequestAction()` adds
  `pullRequestOptions` only when the capability is present and an option is set.
- The client runtime refuses to send `pullRequestOptions` to a session without
  the capability (same check style as `gitPullRequestBranchSelection`).
- Pickers reuse `usePullRequestsVocabulary` and `PullRequestsPicker` keyed by
  the dialog's `cwd`; defaults come from `pullRequests.getCreateDefaults`.

## Errors

- GitLab create failure: nothing is created; the dialog shows the provider
  message and Retry resends with the choices intact.
- GitHub partial failure: if `gh pr create` exits non-zero but its output holds
  a pull request URL, the result is `created` with `warning` naming what was not
  applied; it is never retried, so no duplicate is made. Without a URL it is a
  failure as today.
- Existing open request for the branch: `opened_existing` as today, with
  `warning` saying the new options were not applied.
- Defaults read failure: merge options start unchecked and unlocked; creation
  is unaffected.
- Push-first and commit-push-create flows are unchanged; options apply only at
  the create step.

## Testing

- Contracts: decode tests for `pullRequestOptions`, `warning`, the defaults
  read and the capability; regenerate RPC fixtures and pinned counts.
- Server: `gh` argument building; GitLab JSON body (ids, labels, milestone,
  merge options, draft prefix added once); GitLab-only fields refused for
  GitHub; bounds; defaults read for both providers with the fake CLI pattern;
  GitHub non-zero exit with URL → created with warning; existing request
  ignores options with a warning.
- Client runtime: options withheld from sessions without the capability.
- Web: fields hidden without the capability; GitLab vs GitHub variants (single
  vs multiple people, merge options GitLab-only); locked squash note; Assign to
  me; picker Retry; exact payload; warning rendered after a partial create.
- Reviews: `vercel-react-best-practices` and `UI.md` for the dialog.

## Documentation

Update `docs/integrations/source-control-providers.md` (dialog fields),
`docs/architecture/rpc-and-orchestration.md` (options, defaults read,
capability), `docs/user/workspace-ui.md`, and step 11 of
`docs/testing/cross-platform-validation.md` for GitLab and GitHub.

## Risks

- `gh` failure output for metadata steps varies by version; the URL-detection
  rule must be tested against the installed `gh`.
- GitLab tiers allowing several assignees or reviewers get the single-user
  picker until a follow-up detects the tier.
- The stacked create path still does not pin the Git host (existing behaviour);
  options inherit that.
