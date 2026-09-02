# Source Control Integrations

BiBCode uses Git for local repository operations and provider-specific tools for
hosted repository and pull-request operations. Authentication belongs on the
machine running the BiBCode server.

## Current capability matrix

| Operation                             | GitHub           | GitLab           | Bitbucket        | Azure DevOps     |
| ------------------------------------- | ---------------- | ---------------- | ---------------- | ---------------- |
| Clone a supplied Git URL              | Yes, through Git | Yes, through Git | Yes, through Git | Yes, through Git |
| Look up a repository by provider/name | Yes, `gh`        | Yes, `glab`      | No               | No               |
| Publish a local repository natively   | **Yes, `gh`**    | No               | No               | No               |
| Resolve the current PR/MR             | Yes              | Yes              | Yes              | Yes              |
| Read checks in Git Manager            | Yes, `gh`        | No               | No               | No               |
| Create a PR/MR                        | Yes              | Yes              | Yes              | Yes              |
| Open or prepare a PR branch locally   | Yes              | Yes              | Yes              | Yes              |

“Clone from URL” is a generic Git clone. It does not require BiBCode to identify
the hosting provider, but the URL's normal SSH or HTTPS credentials must work on
the server.

Native repository publishing is implemented only for GitHub. The server rejects
publish requests for GitLab, Bitbucket, and Azure DevOps as unavailable, even if
a UI control happens to list those providers.

## Add an existing project

Open the Command Palette (`Cmd/Ctrl+K`) and choose **Add Project**. You can:

- browse to one existing project folder;
- clone a Git URL into a chosen destination; or
- create one new local Git repository.

Selecting a folder adds that folder as one project. The dialog does not scan a
parent directory for nested repositories or import multiple projects at once.

## Publish a local repository

GitHub publishing uses `gh repo create`, adds the selected remote, and pushes the
current branch. Install and authenticate GitHub CLI first, then use the publish
flow in the chat-header Git actions control:

```bash
gh auth login
```

The right-panel Source Control surface currently renders publish actions as
disabled; publishing is not wired there.

## Pull requests and merge requests

From the Git actions or Source Control UI, BiBCode can:

- detect an open PR/MR for the current branch;
- generate proposed title and description text;
- push and create a PR/MR;
- open the hosted review in a browser; and
- switch to the review branch or create a worktree for it.

Provider terminology follows the host: GitLab uses merge requests, while the
other supported hosts use pull requests.

Passive workspace summaries publish their fresh Git/provider base before the
optional PR lookup. While that lookup is pending or fails, a same-branch and
same-provider PR completed in the previous producer cycle may appear for one
cycle with its original observation time and `stale` state. It expires in the
following cycle unless the provider refreshes it; fresh local base fields are
not replaced by the prior whole summary.

The project-scoped Git Manager has a narrower on-demand provider pane. Its
current pull-request read supports GitHub, GitLab, and Azure DevOps; Bitbucket
returns unavailable on this surface even though the existing Source Control
integration can resolve and create Bitbucket pull requests elsewhere. Check
reads use `gh pr view <number> --json statusCheckRollup` and are available only
for GitHub in this pass. That command reports an open pull request without
checks as an empty collection with a zero exit, so the pane renders the pull
request with no check rows; `gh pr checks` cannot distinguish that case from a
missing pull request or rejected credentials, which all exit 1 with empty
output. Rollup entries fold the way `gh pr checks` folds them: newest run per
check-run name and workflow or per status context, with the state taken from
the context state, else the completed conclusion, else the run status.

Git Manager pull-request and check data refresh only on explicit user action,
never on a timer. Opening the pane or leaving it idle issues no provider call;
choosing **Refresh** invokes the environment-scoped RPC, whose server handler
runs the configured provider CLI when that provider is supported.

**Create pull request** in the Git Manager pane opens a review dialog that
reads local status only: it shows the detected provider, base and head
branches, whether the branch must be published first, and a title and
description seeded from the latest commit. Nothing is pushed or created until
the dialog's primary action runs the existing `git.runStackedAction`
`create_pr` route with the reviewed `pullRequestTitle` and `pullRequestBody`.
The dialog reports publishing and creation as separate phases, keeps a
published branch visible when creation fails, and offers Retry; a retry never
duplicates a pull request because the server resolves an existing open pull
request for the branch (`opened_existing`) before creating one. The Source
Control right-panel menu still creates a pull request directly from its
existing action path.

## Source Control panel

The right-panel Source Control surface manages the active project or worktree:

- The primary action commits staged files, stages all when nothing is staged,
  and exposes available pull, push, and PR states for clean trees.
- The dropdown remains visible and shows unavailable actions as disabled.
- Changes are grouped into Staged Changes, Changes, and Untracked Files with
  per-file status badges.
- The per-file checkbox stages or unstages normally. **Select** mode chooses
  arbitrary files for bulk discard, delete, or ignore actions.
- Hover actions can stage, unstage, discard, restore a deleted file, or delete an
  untracked file. Destructive actions require confirmation.
- Context menus can view a file, copy its path, open it externally, or add ignore
  rules for its name or parent folder when available.
- Commit history and AI commit-message generation are available.

The panel intentionally has no stash or amend action. A staged row also does not
yet open a true `git diff --cached` view.

## Provider setup

### GitHub

Install [GitHub CLI](https://cli.github.com/) and authenticate:

```bash
gh auth login
```

GitHub supports provider lookup, native publish, and pull-request operations.
Open **Settings → Source Control** and rescan to verify the server-side CLI and
account.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli) and authenticate:

```bash
glab auth login
```

GitLab supports provider lookup and merge-request operations. Native repository
publishing is not implemented.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), add
the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

BiBCode invokes `az repos pr` with repository auto-detection for pull-request
operations. Native repository lookup and publishing are not implemented.

### Bitbucket

Bitbucket pull-request operations use its REST API directly. Configure either a
bearer access token:

```bash
export BIBCODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

or an Atlassian email/API-token pair:

```bash
export BIBCODE_BITBUCKET_EMAIL="you@example.com"
export BIBCODE_BITBUCKET_API_TOKEN="your-api-token"
```

Restart the server after changing its environment. The `origin` remote must be a
recognizable Bitbucket URL so BiBCode can identify the workspace and repository.
Each Bitbucket REST operation has one 30-second deadline spanning request and
response-body work. Response bodies are capped at 1 MiB before JSON decoding;
both declared and chunked oversized responses fail with a typed provider error.

The current Source Control discovery screen does not probe these environment
variables; it always reports Bitbucket as missing/unknown. That status is not a
credential test. Attempting a Bitbucket PR operation returns a specific error if
credentials are absent.

## Troubleshooting

- Confirm `git` and the relevant provider CLI are on the BiBCode server's
  `PATH`, not only on the browser machine.
- Rescan **Settings → Source Control** after installing or authenticating `gh`,
  `glab`, or `az`.
- Check whether the remote uses SSH or HTTPS and whether that transport's Git
  credentials work in a server-side shell.
- For Bitbucket, verify the server process inherited the environment variables
  and restart it after changes.
