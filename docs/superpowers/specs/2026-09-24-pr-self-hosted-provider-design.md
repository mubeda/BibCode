# Pull Requests: self-hosted provider detection, context reuse, and faster lists

Status: **Approved by the user on 2026-09-24** (D1 option (a), D2, D3, D4).
The implemented refinements below distinguish review rulings from the
round-3/4/5 rewrites that still await user confirmation.

## Problem and evidence

User report (macOS client, remote Linux server, self-hosted GitLab
`luna.tripunkt.de`): the Pull Requests panel renders slowly, also when the
branch combo changes, and **New merge request** opens a dialog that says
"Repository: Not detected" with "No supported source-control provider was found
for this repository's remote." Reproduced on an isolated dev server with a clone
of `https://luna.tripunkt.de/mubeda/sourcecontroltest.git`, a local-only branch,
and a PATH shim timing every `glab`/`gh`/`git` call:

- `provider_info` in `apps/server/src/git/repository.rs` recognises GitLab only
  when the origin URL contains the substring `gitlab`, with a hard-coded
  `https://gitlab.com` base URL. Status, sidebar summaries, the Git Manager
  pane and the create dialog therefore see no provider for `luna.tripunkt.de`,
  while the Pull Requests module resolves it from the CLIs' configured hosts.
  Changing only the origin URL to a host containing `gitlab` flips the dialog to
  "GitLab · https://gitlab.com".
- `git.runStackedAction` pushes before it resolves the provider, so creating a
  request for such a host would publish the branch and then fail with
  "Pull-request creation is unavailable for this provider."
- Every `glab` call to the host costs about 0.85 s. Before the contained
  2026-09-24 fixes the first render made 13 sequential processes (9.6 s: context
  5.6 s, then list 3.5 s); a worktree switch took 9.9 s and a filter change
  4.7 s. After running independent reads together and reusing discovery's login
  answer: first render 3.6–3.9 s, worktree switch 3.6–3.7 s, filter change
  1.35 s. What remains is structural: `getContext` clears every cache (it is
  Rescan), the client requests the list only after the context arrives, and
  each list re-reads three repository-wide totals.

## Alternatives for provider detection (D1)

The status path runs on every live refresh, so it cannot spawn `glab auth
status`/`gh auth status` (0.8–1.2 s, network), and the product promises no
background provider traffic.

- **(a) Server-owned host observation (chosen).** Hosts learned by explicit
  probes that already run are kept in memory and read without spawning. One
  policy for every surface; costs a new cache with explicit invalidation.
- **(b) Create through the Pull Requests module**, which already knows the
  provider, host and default branch. Smallest user-visible fix, but needs a new
  action or RPC and leaves status, sidebar summaries and the Git Manager pane
  wrong.
- **(c) Provider hint on `GitRunStackedActionInput`,** validated on the server.
  Crosses the client-trust boundary and duplicates detection.

## Decisions

### D1: `ProviderHosts` (`apps/server/src/source_control/hosts.rs`)

A map from lower-cased host to GitHub or GitLab, owned by `source_control`,
shared by the production `GitRepository`, the Pull Requests runner and Settings
discovery. In memory only, at most 64 hosts (the oldest entry is dropped).

Classification (`ProviderHosts::identify`, used by status and scope resolution)
replaces both `git::provider_info`
and the name-only path: well-known host names first (`github.com` and its
subdomains, a host containing `gitlab`, `dev.azure.com`/`visualstudio.com`,
`bitbucket`), then recorded hosts. Only the host counts, never a path segment.
Remotes parse as URLs or as Git's scp-like `[user@]host:path`, with or without
the user. GitLab hosts and recorded GitHub hosts get `https://<host>` as base
URL; `github.com` keeps `https://github.com`.

Invalidation rules:

1. **Record** only from explicit probes: Pull Requests scope resolution records
   the origin host when its name is not well known and discovery (the
   `gh auth status --json hosts` and `glab auth status` probes, fresh or from
   their 30 s cache) lists it as authenticated.
2. **Replace** recorded hosts from provider discovery. The implemented
   restriction to explicit Settings discovery via the new `recordHosts` wire
   field is a round-3 rewrite of the approved rule; its details are in the
   pending-confirmation list below, not part of the original approval.
3. **Forget** a host when Pull Requests `getContext` runs with `rescan: true`
   for a checkout whose origin is that host (before resolving; discovery
   re-records it if it is still configured); when scope resolution answers
   `unknown_host` (which matters when another probe recorded the host during
   this read) or its login check answers `not_authenticated`; and when the
   host's context read fails authentication. Other reads that fail
   authentication trigger the client's auth recovery, which rescans.
4. Nothing is written by status reads, summaries, background discovery reads
   (the publish dialog's), the create dialog, or timers; a server restart
   starts empty.

`GitRepository::remote_provider` (status streams, the create dialog, sidebar
summaries and the Git Manager pane) reads the observation without spawning a
provider CLI. Pull Requests scope resolution skips discovery for a recorded
host while its `auth status` probe (30 s cache) stays the freshness check. Context and list
reads overlap that check with the host read once the provider is identified;
an authentication failure cancels and awaits the host read before discarding
its result, and retains error precedence. Context and list share that helper
and, after a successful login check, recheck checkout availability before
accepting either the host result or its error.
A new status subscription reads fresh local status and publishes a changed provider to
existing subscribers; other live subscriptions pick it up at their next
refresh.

Create path: when `git.runStackedAction` includes a pull request, it resolves
the provider from fresh local status **before** creating a branch, committing
or pushing, and uses that provider for the existing-request check and
creation. No origin or an unidentified host fails without side effects, also
for `commit_push_pr` with a feature branch. The error starts with "Nothing was
published." A created request is reported to the Pull Requests service through
`CreatedRequestObserver`, which invalidates that repository's cached totals.

### D2: `rescan` on `pullRequests.getContext`

Additive optional `rescan: boolean` in the payload (`PullRequestsGetContextInput`;
Rust `#[serde(default)]`). `rescan: true` keeps today's behaviour (clear probe,
host-context and totals caches) and forgets the origin host (D1 rule 3). Absent
or false reuses the bounded 30 s probe and host-context caches; the origin is
still read on every call and unavailable answers still invalidate. The client
keeps `{ cwd }` as the query key: only the Rescan buttons and auth recovery
register a one-shot rescan for that input. Executions send it until one is
answered (success or the server's typed failure); an interrupted read or a lost
connection keeps it for the next execution. Mount, worktree switch and stale
revalidation never send it.

### D3: first list page in parallel with the context

While the context is pending, the panel mounts the first-page list query for
the stored filters and sort when the stored tab is `open` or `closed` (valid for
both hosts); `merged`/`all` wait because GitHub folds them into `closed`. The
panel selects one typed input, null unless the context is pending, built with
the list view's own selectors, and retains a separate `environmentRpcKey`.
The list view
reuses that query and treats it as fresh on its first open only; the marker ends once
the list opened, on a detail route, or when the context settles unavailable or
fails. Any other open refreshes a cached value or failure and hides it until
the new read answers. The panel adjusts its state during render when the
prefetch key changes or a retained page must be discarded, without writing a
ref during render. The fresh-page key is passed as a value. After the list
commits, its acknowledgement effect calls the panel's callback, which uses
the panel's state setter to clear the consumed key. StrictMode and suspended
renders cannot consume the handoff or trigger a duplicate first-page request. The panel keeps
its skeleton until the context arrives; the list never shows an empty state
before its page settles.

### D4: repository-wide totals reuse (GitLab)

GitLab's three totals are cached per host and repository for 30 s (the
existing bounded cache: 32 entries, successful answers only; a partial failure
is not cached). Filter changes, tab switches and later pages reuse them while
each page's rows are read fresh. Invalidation: Rescan and authentication or
permission failures clear them with the other context caches; any successful
`pullRequests.runAction` clears them, and so does a request created through
`git.runStackedAction` for its repository; an explicit list Refresh (including the
refresh after the create dialog settles) sends the additive
`refreshTotals: true` for the first page, which re-reads and replaces them; and
they expire after 30 s. GitHub already returns its totals with the page.

### Refined after approval (rounds 3–5), approved by the user on 2026-09-25

These rewrites of approved text describe the current implementation;
review requested them, but did not constitute user approval of the revised
design. The first five entries originated in round 3:

- **D1 rule 2:** host replacement now requires the new `recordHosts: true`
  field on `server.discoverSourceControl`, sent only by Settings → Source
  Control and its Rescan. For GitHub and GitLab separately, a recognized host
  list replaces that provider's recorded hosts with exactly its authenticated
  hosts under one write lock. A missing CLI or unrecognized answer keeps its
  entries. Background discovery, including the publish dialog's, no longer
  replaces hosts. This restriction and additive wire field still require user
  confirmation; the related full-logout handling is listed below.
- **D2:** the bypass is sent until answered, including after interruption or
  reconnect, rather than consumed when execution starts.
- **D3:** the fresh-page marker lasts only through the first list open and is
  discarded on detail navigation or unavailable context; later opens also
  re-read a cached failure.
- **D4:** a create through the stacked action clears the repository's totals.
- **Hinted dialog:** a provider/host supplied by the Pull Requests panel no
  longer blocks creation while status has no provider; the server validates it.
- **Unknown-provider copy (round 4):** an explicit `unknown` provider now says
  "change request" instead of the approved "pull request". A missing provider
  still uses "pull request"; identified GitLab uses "merge request".
- **D1 login ordering (rounds 4–5):** once the host is identified, its login
  check runs alongside context/list reads rather than before them. Round 4
  awaited both and gave a failed login precedence. That avoids a successful
  read waterfall, but waiting for both can delay a known login failure until a
  slow page read finishes. Round 5's J-e uses one helper to cancel the read's
  supervised provider child on login failure and then await its cleanup before
  returning the login error. A read may start before authentication is known;
  it is discarded on failure, and mutations retain sequential authentication.
  Both context and list also recheck checkout availability after successful
  authentication, including when the host read itself failed.
- **D1 rule 2 logout (round 4):** the recognized full-logout `glab` response
  now supplies an empty host list, so an explicit Settings scan forgets all
  recorded GitLab hosts. Unrecognized output remains Unknown and retains the
  observation instead of treating every empty parse as logout.
- **D3 handoff (rounds 4–5):** the fresh page changed from a render-mutated
  marker to a value acknowledged after the list commits, protecting the first
  open under StrictMode and Suspense. Round 5 replaces the panel's effect-based
  state update with a guarded adjustment during render when the key changes
  or the page is discarded, and uses the shared `environmentRpcKey` in panel,
  list and tests. Establishing the handoff writes no ref during render; the
  list's acknowledgement effect calls the panel's setter to consume it after
  commit.

## UI copy (create dialog, `UI.md`)

- Vocabulary follows the detected provider: GitLab uses "merge request" and
  `!N`; other supported providers or a missing provider use "pull request" and
  `#N`; an explicit `unknown` provider uses "change request" and `#N`, following
  `packages/shared/src/sourceControl.ts`. This covers the
  title, description, primary button ("Publish and create merge request"),
  progress, results, blocked reasons and the "Open merge request" link. The
  publication panel text has no request noun and is unchanged.
- Unknown provider: the Repository cell reads "Not identified yet" and the
  reason is "BiBCode hasn't identified this repository's host yet. Open Pull
  Requests for this project or run Rescan in Settings → Source Control." Without
  an origin remote: "Add an origin remote to create a pull request."
- Opened from Pull Requests, the dialog receives the panel's provider and host
  as a hint. While status has not named the host (cold or stale), the
  Repository cell shows the hinted host ("GitLab · https://luna.tripunkt.de")
  and creation is not blocked; the server validates the provider. Without a
  hint a missing provider keeps "pull request" wording.
- A disabled primary button explains itself: a wrapper carries the tooltip and
  the button's `aria-describedby` names the reason.
- The server's create error for an unidentified host starts with "Nothing was
  published.", names the host and gives the same two next steps.

## Review rulings

- Explicit-only discovery: only `recordHosts: true` replaces recorded hosts;
  an unrecognised `glab` answer has no host list and replaces nothing. This is
  the pending D1 rule 2 rewrite above, not user approval of that rewrite.
- One identification rule (`identify`, named then recorded); `hosts.rs` builds
  providers with the shared constructor; one `From` conversion between the Git
  and source-control provider kinds replaces the mirror `match`.
- Settings discovery writes the `ProviderHosts` it was given, the same `Arc`
  as status and Pull Requests, not one reached through the repository.
- `getContext` takes `ContextRead::{Open, Rescan}` internally; the provider is
  always resolved when the stacked action creates a request (no fallback).
- The GitHub context's `user`, repository and GraphQL reads run together; the
  error order stays `user`, then repository, then GraphQL.
- Noun, provider-name and `#`/`!` policy belongs to
  `packages/shared/src/sourceControl.ts`; the PR UI uses that shared presentation
  and number formatter. The duplicate web helper is removed.
- `packages/shared/src/git.ts::toLocalStatusPart` preserves `defaultRefName`
  when a remote-status update rebuilds the local part. Otherwise a resolved
  base such as `master` vanished after the initial snapshot and the create
  dialog fell back to `main`. The shared Git test "keeps the resolved default
  ref when the remote part follows a snapshot" covers absent and present
  remote updates.

## Validation

- Server: `ProviderHosts` rules and classification (named, recorded GitLab and
  GitHub Enterprise hosts, base URLs, scp remotes without a user); local status
  with a recorded host; scope resolution records, skips discovery, and forgets
  on `not_authenticated`, rescan and `unknown_host`, each proven on its own;
  `getContext` process counts with and without `rescan`; GitHub context reads
  run together and keep the error order; totals reuse and each invalidation,
  including a stacked-action create; only `recordHosts` replaces; the create
  path refuses an unidentified host before any branch, commit or push,
  including `commit_push_pr` with a feature branch.
- Round 4/5 server regressions: recognized full logout (the byte-for-byte
  `glab` capture and normalized phrase variants) clears hosts while unknown
  output preserves them; concurrent login/read execution preserves auth-error
  precedence; context and list cancel and await a slow provider read on login
  failure and reject a checkout removed during the read; unsupported providers
  cannot select a GitLab adapter; production discovery and VCS share the same
  `ProviderHosts` observation.
- Client runtime and web: a bypass is sent until answered; Rescan and auth
  recovery send `rescan`; the prefetch runs only for `open`/`closed`, serves the
  list's first open only, and is dropped when the context settles unavailable;
  a cached failure is re-read on open; Settings sends `recordHosts`; dialog copy
  for GitLab, GitHub, unknown, hinted and no-origin; the disabled-reason tooltip.
- Round 4/5 web/shared regressions: StrictMode plus a suspended list consumes
  the first page without a second list request; panel/list keys use the shared
  environment RPC identity; shared provider presentation controls the Git
  Manager toggle, heading, status messages, GitLab `!N` and **Create merge request**;
  GitHub retains pull-request wording and `#N`. Detail behavior
  branches on provider kind rather than presentation text. A deliberately
  inconsistent compatibility vocabulary supplies different singular and plural
  server nouns together and proves the UI ignores both `pullRequest` and
  `pullRequests`. The neutral shared permission button
  retains disabled reasons and accessible descriptions for both consumers.
- Contracts: `vp run check:contracts`. Live: Loop 1 shows
  "GitLab · https://luna.tripunkt.de"; Loop 2 before/after timings.

## Documentation to update

`docs/integrations/source-control-providers.md` (configured hosts on every
surface, caching, dialog wording), `docs/architecture/rpc-and-orchestration.md`
(Pull Requests flow), `docs/architecture/overview.md` (module ownership and
caches), `docs/user/workspace-ui.md` (Rescan versus opening, dialog wording),
and a review of `docs/testing/cross-platform-validation.md`.

## Residuals

- After a server restart a custom host stays unidentified until the Pull
  Requests panel or Settings discovery runs; creation fails early with guidance
  in that window.
- Live status subscriptions show a changed provider only at their next refresh
  unless a new subscription triggers a fresh read.
- A non-rescan context can be up to 30 s old (account, repository policy);
  mutations re-read fresh policy. Totals can be up to 30 s old after changes made
  outside BiBCode until Refresh.
- Mixed versions: the three additive fields are `rescan`, `refreshTotals`, and
  `recordHosts`. An older client's Rescan/Refresh sends no bypass, so a newer
  server may use its 30 s caches; its Settings scan never records hosts. An
  older server ignores all three new fields.
- The observation trusts the CLI host lists; a host configured in `glab` is
  treated as GitLab even when unreachable (the auth probe then reports it).
- A hinted dialog trusts the panel's context for display only. If the server
  lost the recorded host (restart) before the create, it refuses with the
  "Nothing was published." guidance.
- The dialog's Cancel button, disabled only while a create runs, still carries
  its reason as a plain `title`.
