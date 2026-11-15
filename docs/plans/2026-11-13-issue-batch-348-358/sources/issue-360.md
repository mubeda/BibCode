# #360 Git Manager: app crashes with React #185 after switching branch and fetching in a large repo

## Problem

(measured: owner's recollection) After adding a large private repo from the remote server through Environments, **Git Manager was open**. The owner thinks he switched branch and then clicked **Fetch**. The app showed **“Something went wrong.”** and **Minified React error #185**. Treat the order as a recollection, not an independently replayed recipe. The latest recollection supersedes the earlier assumption that the add dialog itself was the failing surface.

(measured: owner rebuilt v0.15.3 web bundle with hidden sourcemaps; hashes of dist-uFV5SP1K.js and react-U-MQsiqE.js matched the installed app) The symbolized stack is inside patched **@legendapp/list 3.3.10**: `ContainerLayoutCoordinator` layout effect → `measureContainersInLayoutEffect` / `getBoundingClientRect` → `updateItemSizesBatch` → `applyItemSize` → `updateOneItemSize` → `setSize` → `addTotalSize` → `set$` → store listener → React `forceStoreRerender` → layout effect again. No app frames identify the list instance.

(inferred) (supported: symbolized stack points at it; no test has flipped it) The failure is a synchronous LegendList measurement/update chain. **The leading application trigger is the Git Manager branch list retained beneath a closed, hidden popover, then updated with refs.** This combines a concrete hidden-container caller with an unguarded measurement path matching upstream reports. The actual failing instance and its 0×0 measurements still require a controlled capture; the stack alone does not prove that particular instance.

(measured) Static trace baseline is **main `a9938193b843c15b8870d39c0ee9ed63275702b5`**. Source citations below use that SHA unless explicitly marked v0.15.3. The v0.15.3 annotated tag object is `ed10daf86226847c8ba2eb46eb37df08ac3948d2`; its peeled commit is **`3d3a08efd0dd054c1c7a205d87dc875fe28171a7`**. The original client-web build ambiguity is resolved by the owner’s hash-matched v0.15.3 rebuild; exact desktop package metadata is still not independently inspected.

## Triage proposal (mstack-backlog-triage)

- (inferred) Type: **bug**. Priority: **P1/high**. Labels: **bug, needs-triage, size:M**.
- (inferred) Size: **M**. The likely correction is small, but the shared library patch, two web bundle formats, retained popup lifecycle and composed browser/native regression need validation; no broad redesign is justified.
- (inferred) Release view: **proposed blocker for the next release**, pending isolated confirmation and regression coverage, because the failure replaces the whole application UI with the error boundary.
- (inferred) Diagnosis gate: the symbolized mechanism is supported; the exact list instance and a controlled failure flip remain unconfirmed.

## Expected vs Actual

- (inferred) Expected: opening Git Manager, selecting a branch and fetching keeps the UI usable, whether the branch picker is open or closed and regardless of supported repository/ref counts. Closed lists must not collapse their cached sizes from invisible geometry.
- (measured: reporter statement) Actual: the global route error boundary replaces the usable application with “Something went wrong.” and React #185.
- (inferred) This is loss of the application UI, not evidence that Tauri or the server process exited, or that an already completed Git operation was rolled back.

## Environment and supplied evidence

| Observation              | Evidence                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform / server        | (measured: ai-server profiler data, per BibCode Bot) macOS desktop connected to BibCode 0.15.3 server on ai-server.                                                                                                                                                                                                                 |
| Repository scale         | (measured: ai-server profiler data, per BibCode Bot) A large private repo: about 17 GB on disk, 12.26 GiB pack, about 603k objects, 52,232 tracked files, 290 KB packed-refs; 19→20 registered worktrees between 10:47:05 and 10:52:05 ART. No private repository was opened or inspected in this diagnosis.                        |
| Server health            | (measured: ai-server profiler data, per BibCode Bot) No server errors, timeouts, hangs, rpc.slow or push burst; subscribeVcsStatusSummary stayed around 1.6–2.1/s.                                                                                                                                                                  |
| Last client batch        | (measured: ai-server profiler data, per BibCode Bot) 10:47:06–10:47:16 ART: filesystem.browse ×2; orchestration.dispatchCommand ×2, 7/15 ms; projects.listEntries ×1, about 59 ms round trip; server.getProviderCapabilities 1,175 ms server-side, 304 KB. Client then silent; process-diagnostics polling stopped around 10:47:26. |
| File-list outlier        | (measured: ai-server profiler data, per BibCode Bot) One projects.listEntries response was 2,770,896 B; prior max 37,757 B. (inferred: supplied count-based association) It may be the response received immediately before the crash; aggregate counts do not establish its exact client/stack ordering.                           |
| Git Manager reads/action | (measured: ai-server profiler data, per BibCode Bot) getRefs: two messages, max 591,715 B; getCommits: max 133,820 B; one runOperation. (inferred: supplied correlation) The operation likely corresponds to master→develop around 10:47:24.                                                                                        |
| Client telemetry         | (measured: ai-server profiler data, per BibCode Bot) Batches showed zero stalls, zero interactions, null jsHeapBytes. (inferred) Those samples do not exclude the owner-symbolized synchronous frontend failure.                                                                                                                    |

(inferred) The healthy server and symbolized client stack favor a client measurement failure. Do not infer that Fetch definitely reached the server: only one operation is reported, and batch windows, the recollected Fetch click, and the 10:47:24 checkout association are not a complete ordered event trace.

## Steps to reproduce — candidates, not yet run

1. (inferred) In a fresh isolated userdata directory and browser profile, connect to a fresh isolated server port with the v0.15.3 web client, then repeat on the stated main SHA.
2. (inferred) Add a synthetic large repo through Environments, or directly open a previously registered fixture: about 50k tracked files, thousands of branches/tags, about 500 KB packed-refs, and about 20 worktrees. Compare a small control repository.
3. (inferred) Open **Git Manager**. Let refs arrive with the branch picker closed; then open the picker and select another clean branch. The selection closes the picker before the checkout starts.
4. (inferred) Click **Fetch**. Capture ref refresh and the closed picker’s geometry; also test first refs arrival while never opened, open→close without checkout, and data refresh after close. Preserve the distinction between clicking Fetch and sending its RPC.
5. (inferred) Repeat with History and Changes selected, with the stash pane closed/open, and with the branch picker visible. Only after these primary cases, test Files/composer/model-picker alternatives independently.

## Static trace and likely cause

### Git Manager caller and hidden branch list

- (measured) [apps/web/src/routes/_chat.project.$environmentId.$projectId.git.tsx:14–38](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/web/src/routes/_chat.project.$environmentId.$projectId.git.tsx#L14-L38) mounts `GitManagerPanel` on a project route. `GitManagerPanel.tsx:1311–1465` resolves project/checkout/status/catalog/signal and renders its toolbar and content. Adding the repository does not by itself force this route; the owner's new recollection establishes Git Manager involvement.
- (measured) [apps/web/src/components/gitManager/GitManagerToolbar.tsx:238–248](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/web/src/components/gitManager/GitManagerToolbar.tsx#L238-L248) reads `gitManagerEnvironment.getRefs`; `:687–704` passes local/remote branch arrays to `toolbar/GitManagerBranchDropdown.tsx`. That component memoizes grouping and flattened rows (`:326–354`), but its popup/list JSX is **not gated by the open flag** (`:450–504`).
- (measured) Shared [apps/web/src/components/ui/popover.tsx:39](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/web/src/components/ui/popover.tsx#L39) uses **`PopoverPrimitive.Portal keepMounted`**. Installed/locked Base UI 1.9.0's `popover/portal/PopoverPortal.js:27–35` retains children; `popover/positioner/PopoverPositioner.js:104` sets `hidden: !mounted`; `utils/usePositioner.js:29–35` forwards that DOM attribute. These facts are dependency-source observations, not captured browser geometry.
- (inferred) A closed branch popup can therefore keep its LegendList mounted under an element excluded from layout. Full refs arriving or being replaced after checkout/Fetch can update that hidden list.
- (measured) Branch selection explicitly closes the popup before invoking the parent (`GitManagerBranchDropdown.tsx:379–384`). The list uses estimate **30px**, draw distance **360px**, height **15rem**, and **no `getFixedItemSize`** (`:37–38`, `:496–504`). Headers and rows have `h-[30px]`; names/reasons truncate and worktree badges remain inside that wrapper (`:198–230`, `:419–420`).
- (inferred) Thus the hidden-zero mechanism fits better than normal text wrapping. A CSS 30px row still measures 0×0 beneath a hidden ancestor. Ahead/behind primarily changes the toolbar sync state (`GitManagerToolbar.tsx:269–288`), not an unbounded multiline branch row.

### Checkout and Fetch revalidate the retained list

- (measured) `GitManagerToolbar.tsx:444–454` handles branch selection; `:390–438` issues `branch-checkout` and stores the selected ref after success. Dirty-worktree handling is explicit, including optional stash. `:560–592` handles sync actions; Fetch sends `_tag:"fetch"` at `:567–568`.
- (measured) Both use `executeOperation` (`:338–372`) → [apps/web/src/state/gitManager.ts:35–51](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/web/src/state/gitManager.ts#L35-L51) → typed `gitManager.runOperation` stream. Its terminal result calls `revalidateRefs` at toolbar `:359`. `GitManagerPanel.tsx:359–393` also refreshes refs when a remembered signal generation changes/recovery occurs; these are bounded event-driven triggers, not a measured push storm.
- (measured) Client query families are [packages/client-runtime/src/state/gitManager.ts:69–135](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/packages/client-runtime/src/state/gitManager.ts#L69-L135). Server registration is [apps/server/src/production/git_manager_rpc.rs:1215–1259](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/server/src/production/git_manager_rpc.rs#L1215-L1259), read handlers `:593–613`; mutations finish shared ownership and invalidate repository state in [apps/server/src/git/manager/operations.rs:1022–1094](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/server/src/git/manager/operations.rs#L1022-L1094).
- (measured) History consumes first/next/retained commit pages and refreshes on signal/repository generations ([apps/web/src/components/gitManager/history/GitManagerHistoryView.tsx:297–417](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/web/src/components/gitManager/history/GitManagerHistoryView.tsx#L297-L417)), guarding processed responses and stale generations (`:457–535`). The Changes view gets full VCS status, refs, and one latest commit (`changes/GitManagerChangesView.tsx:279–302`).
- (measured) The add-existing-folder path registers/opens project/thread with initialization disabled ([apps/web/src/components/add-project/addProjectOperations.ts:130–185](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/web/src/components/add-project/addProjectOperations.ts#L130-L185), `useAddProjectWorkflow.ts:1083–1153`); no `gitManager.runOperation` or automatic branch checkout was found there. (inferred) Manual selection is the better explanation of the observed operation; do not invent an automatic checkout after add.

### Ranked causes after the new evidence

1. **(inferred) H-hidden: closed Git Manager branch picker measures zero-sized containers.** (supported: symbolized stack points at it; no test has flipped it) The overall LegendList chain is supported; the branch instance is the leading inference from its retained hidden popup, refs updates and the owner’s Git Manager recollection. The concrete cycle is: hidden row measures 0×0 → stored item/total size falls → the calculated visible/buffered range admits more rows → new container layout work increments the layout epoch → another synchronous layout effect measures more zero rows → React’s nested-update limit is reached. A sufficiently long finite list can cross that limit without any row oscillating forever or new server traffic.
2. **(guess) H-unstable-row-height: visible Git list geometry alternates.** (measured) The size path rounds measurements to integer pixels and accepts differences >0.1 (`apps/web/node_modules/@legendapp/list/react.mjs:5010–5028`). (inferred) Scrollbar width, scale transitions or a half-pixel boundary could produce alternating integer sizes; tiny jitter remaining in one rounding bucket cannot. Fixed CSS heights, truncation and fixed-size callbacks in other Git lists weaken this hypothesis. Confirm with nonzero alternating measurements before proposing epsilon changes.
3. **(guess) A different hidden/dynamic LegendList participates.** (measured) The model picker, timeline, PR lists and pipeline lists also use LegendList, but no mapped app frame identifies one of them here. (inferred) Test only if component ownership contradicts the branch lead; the directory picker and project file tree are not themselves LegendList consumers. The earlier generic selector/snapshot hypotheses are superseded by the symbolized measurement chain.

### Why scale matters — and why payload latency alone does not

(inferred) H-hidden depends on **list row count**, not repository bytes: accepting zero-height rows successively expands the render range, adding synchronous commit rounds. Thousands of refs can expose it where a short list settles before the depth limit. A 592 KB refs result includes tags/worktrees/metadata too, so it does not directly establish how many branch rows rendered.

(inferred) One late response can arrive after a popup closes, making timing relevant. Rendering slowly does not itself make a dependency unstable, and a large array does not automatically create an infinite effect. This candidate needs neither an uncached snapshot nor an app effect loop: the library’s layout-effect/store feedback supplies the updates.

### Other large payloads and their actual consumers

- (measured) `projects.listEntries` returns `{entries:[{path,kind,ignored?}], truncated}` with no cursor. Input limit is optional, max 200 ([packages/contracts/src/project.ts:16–42](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/packages/contracts/src/project.ts#L16-L42); [apps/server/src/workspace/rpc.rs:555–571](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/server/src/workspace/rpc.rs#L555-L571)). Omitting limit returns the whole **bounded** snapshot ([apps/server/src/workspace/search.rs:289–300](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/server/src/workspace/search.rs#L289-L300)): **25,000 entries**, **16 MiB estimated internal memory**, **4,096 bytes/path** (`:88–103`), recursive directory traversal subject to those bounds/ignore/symlink/cancellation rules (`:814–873`, `:917–971`). These limits are verified on v0.15.3 too.
- (inferred) The 52,232 tracked files are repository population, not response rows. 2,770,896 B divided by 25,000 is about 111 B/entry, plausible with path strings and JSON fields; actual returned count/truncated status were not supplied. The internal memory budget is not a serialized-wire-size limit.
- (measured) The full-list caller is [apps/web/src/components/files/projectFilesQueryState.ts:33–35](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/web/src/components/files/projectFilesQueryState.ts#L33-L35), read by the Files panel and ProjectFilesPreloader (`:168–184`, `:216–245`; `ProjectFilesPreloader.tsx:15–16`). `FileBrowserPanel.tsx:251–269` memoizes paths/kinds/expanded directory inputs; `:756–818` constructs/synchronizes the file-tree model; `:1046–1050` renders FileTree. It uses a separate tree renderer, not LegendList. Empty composer path search calls bounded listEntries; nonempty search uses searchEntries ([apps/web/src/state/queries.ts:61–96](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/web/src/state/queries.ts#L61-L96)). Those are the production UI call paths found; the refresh command uses the same RPC ([packages/client-runtime/src/state/projectCommands.ts:192–199](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/packages/client-runtime/src/state/projectCommands.ts#L192-L199)).
- (measured) getRefs returns full branch/tag/worktree vectors without API pagination ([apps/server/src/git/manager/refs.rs:84–99](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/server/src/git/manager/refs.rs#L84-L99), `:300–354`; [apps/server/src/git/repository.rs:807–829](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/server/src/git/repository.rs#L807-L829)). Consumers are Toolbar, Panel, ChangesView, SourceControlPanel, and the open Create Pull Request dialog. getCommits is paged at ≤100, with a 1 MiB JSON target and at least one retained commit ([packages/contracts/src/gitManager.ts:408–413](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/packages/contracts/src/gitManager.ts#L408-L413); [apps/server/src/git/manager/graph.rs:18–27](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/server/src/git/manager/graph.rs#L18-L27), `:228–247`). Both baselines have those commit bounds. History accumulates pages; Changes/PR defaults request one commit.
- (measured) getProviderCapabilities contains **slashCommands, skills, agents, issues**, not the model catalog ([packages/contracts/src/server.ts:113–125](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/packages/contracts/src/server.ts#L113-L125)). [apps/web/src/state/providerCapabilities.ts:9–33](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/web/src/state/providerCapabilities.ts#L9-L33) → `ChatComposer.tsx:867–900`, `:1162–1171`, `:2809–2810` feeds composer suggestions/editor metadata. Model options are separate (`ChatComposer.tsx:857–865`, `:2899–2919`). (inferred) Its 304 KB response is timing context, not evidence that the branch/model list received 304 KB of models.

(measured) The file-tree reset effect first checks `previousTreePathsRef.current === treePaths`; it preserves expansion/selection and depends on memoized path/kind inputs (`FileBrowserPanel.tsx:785–818`). This is not an established fresh-array setter loop. Its renderer imports are `@pierre/trees/react` at `FileBrowserPanel.tsx:15–16`.

### LegendList coverage and mount behavior

(measured) There are **14 production `<LegendList>` JSX sites in each baseline**, not 16; imports, refs and test-only lists are excluded. The path prefix below is `apps/web/src/components/`; the table summarizes props, row styling and visibility; the detailed source inventory was retained with the static investigation. Main/tag line numbers are shown when they differ.

| List                         | Main / tag line                                       | Relevant exposure and row sizing                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (measured) Git branch picker | `gitManager/toolbar/GitManagerBranchDropdown.tsx:496` | (measured) Closed retained popover; estimate/CSS 30px, no fixed callback. (inferred) Highest risk.                                                                                                      |
| (measured) Git commits/graph | `gitManager/history/GitManagerCommitList.tsx:324`     | (measured) Fixed 50px, maintain-visible positioning; History only when active. (inferred) Lower hidden/wrapping risk.                                                                                   |
| (measured) Git changes       | `gitManager/changes/GitManagerChangesList.tsx:90`     | (measured) Fixed 29px, recycling, row identity stabilization; inactive tab normally unmounts.                                                                                                           |
| (measured) Commit files      | `gitManager/history/GitManagerCommitDetail.tsx:212`   | (measured) Fixed 29px; selected history detail.                                                                                                                                                         |
| (measured) Stash list        | `gitManager/stash/GitManagerStashList.tsx:266`        | (measured) Fixed 29px, recycling; pane mounts only when opened.                                                                                                                                         |
| (measured) Stash files       | `gitManager/stash/GitManagerStashDiff.tsx:233`        | (measured) Fixed 29px; same conditional pane.                                                                                                                                                           |
| (measured) Timeline          | `chat/MessagesTimeline.tsx:743 / 737`                 | (measured) Dynamic rows, estimate 90, recycling off, sticky item types; new empty idle thread has no list.                                                                                              |
| (measured) Model picker      | `chat/ModelPickerContent.tsx:567`                     | (measured) Also in a kept-mounted popover; estimate48, dynamic description rows, no fixed callback; model options are separate from capabilities. (inferred) Lower incident priority than Git branches. |
| (measured) Pipelines list    | `pipelines/list/PipelinesListView.tsx:246`            | (measured) Fixed-size callback; separate route/view.                                                                                                                                                    |
| (measured) Job log           | `pipelines/log/JobLog.tsx:547 / 536`                  | (measured) Wrapping permits dynamic heights; separate job view.                                                                                                                                         |
| (measured) PR conversation   | `pullRequests/detail/PullRequestsConversation.tsx:81` | (measured) Estimate 220, recycling off; separate PR detail.                                                                                                                                             |
| (measured) PR file tree      | `pullRequests/detail/PullRequestsFiles.tsx:380`       | (measured) Fixed estimate 56; separate PR Files view.                                                                                                                                                   |
| (measured) PR diffs          | `pullRequests/detail/PullRequestsFiles.tsx:400`       | (measured) Dynamic estimate 300; adjacent split pane, not a branch row.                                                                                                                                 |
| (measured) PR list           | `pullRequests/list/PullRequestsListView.tsx:227`      | (measured) Fixed estimate 56; separate PR list view.                                                                                                                                                    |

(measured) Git Manager tabs are **not** a proven kept-mounted hidden subtree: `ui/tabs.tsx:37–40` does not set keepMounted, Base UI defaults it false, and History/Tags additionally gate their children (`GitManagerPanel.tsx:1220`, `:1244`). Stashes mount conditionally (`:1138`). Tags/remotes/worktree selectors use mapped sections/ordinary controls, with no additional LegendList instance. The retained **branch popover** is the concrete difference.

### Patch / upstream finding

(measured) `patches/@legendapp__list@3.3.10.patch` is identical across both revisions. Its ten mirrored CJS/ESM hunks handle scroll ownership, end-anchor corrections, viewability and cancellation; none changes row measurement, setSize/addTotalSize, rounding, or either zero-size gap. All ten hunk pairs were inspected; none adds the direct or deferred-shrink 0×0 guard.

(measured) Installed `react.mjs:5036–5057` reads rect→baseline→size batch without a 0×0 check; `:5061–5074` invokes it in the coordinator layout effect. `:234–245` synchronously notifies listeners, and `:1068–1105` publishes total size. ResizeObserver already ignores 0×0 at `:5442`; deferred shrink confirmation at `:5526–5542` also lacks the guard. Item sizes use Math.round and >0.1 comparison, not unlimited subpixel sensitivity (`:5010–5028`).

(measured) Upstream [#567](https://github.com/LegendApp/legend-list/issues/567) describes the matching hidden-list chain; [PR #559](https://github.com/LegendApp/legend-list/pull/559) proposes guards for direct measurement and deferred shrink. Both are open. Older [#376](https://github.com/LegendApp/legend-list/issues/376) is closed and concerns an earlier beta report.

(measured) Published 3.3.10 and 3.7.2 were read without installing; both still read rect then set the baseline without the direct 0×0 guard (published ESM 5024–5025 and 5628–5629). (inferred) An upgrade to 3.7.2 alone does not close the measured gap.

## Requirements (EARS) and scenarios

### R1. Keep branch selection and Fetch usable [Must]

(inferred) WHEN a user selects a branch or fetches in Git Manager, BiBCode SHALL complete or explain the Git operation without replacing the application with a React update-depth error.

- (inferred) **Given** a large refs fixture, **When** its branch popup is closed and refs arrive or refresh, **Then** the UI stays usable and the list’s total size/mounted-container count settles without continued updates after fixture emissions stop.
- (inferred) **Given** that fixture, **When** the user opens the picker, selects a branch, and clicks Fetch, **Then** the accepted branch and resulting refs remain visible when the picker reopens, with no duplicate mutation sent.

### R2. Do not treat invisible geometry as row content size [Must]

(inferred) WHILE a list container is hidden or detached with a 0×0 rectangle, the web virtualizer SHALL preserve its valid row-size state and SHALL avoid synchronous range expansion based on that invalid measurement.

- (inferred) **Given** a visible populated list subsequently hidden, **When** a direct layout effect or deferred shrink callback sees 0×0, **Then** it does not record a zero baseline/size and recursively admit more rows.
- (inferred) **Given** the same list revealed again, **When** valid geometry becomes available, **Then** rows measure and scroll normally without stale blank space or lost selection.
- (inferred) **Given** genuine visible row growth/shrink, **When** geometry changes, **Then** the virtualizer still accepts valid sizes and maintains intended scrolling; the correction must not freeze all measurements.

### R3. Bound the caller lifecycle and preserve existing behavior [Must]

(inferred) WHILE the Git branch picker is closed, BiBCode SHALL avoid active measurement work for its invisible list while preserving stored filter and selection state.

- (inferred) **Given** a filter/selection, **When** the picker closes, receives refreshed refs and reopens, **Then** it shows current authoritative branches with the retained applicable filter and no error.
- (inferred) **Given** hidden list protection in both patched web formats, **When** timeline, History, Changes and model-picker regression cases run, **Then** navigation/scroll/selection still work and hidden-to-visible transitions settle.

(inferred; proposed implementation direction) Extend the existing patch with the upstream-style 0×0 skip **before** baseline mutation in the direct path and a corresponding check in deferred shrink confirmation; gate the closed branch list or opt it out of keepMounted. Test library and caller corrections independently before combining them. Fixed row sizing may be appropriate but is not a substitute for visibility-safe measurement. No patch is implemented or approved here.

## CONFIRMATION PLAN — future isolated work only

(measured) Nothing in this plan was executed. Static-only restrictions remain in force for this investigation.

1. (inferred) Use a disposable implementation checkout, a fresh `BIBCODE_HOME` beneath an isolated fixture root, a fresh browser userdata/profile directory, and verified unused server/web ports. Never use production userdata or ports. Prefer unminified React development mode; alternatively enable matching source maps (`BIBCODE_WEB_SOURCEMAP=hidden`, `apps/web/vite.config.app.mjs:37–40,181`) while collecting React component ownership in a development/profiling build. Source maps alone do not turn production React into development React.
2. (measured) `scripts/dev-runner.ts:559–608` supports `--home-dir`, `--host`, `--port`, `--dev-url`; `BIBCODE_PORT_OFFSET` wires separate web/server ports. Server flags include `--base-dir`, not `--state-dir`. Desktop data root honors BIBCODE_HOME ([apps/desktop/src-tauri/src/config.rs:147–175](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/desktop/src-tauri/src/config.rs#L147-L175)). (inferred) Resolve the exact isolated ports first, then run only the fixture server/client. For macOS native confirmation use a disposable OS account/VM and its fresh app/WebKit state as well as BIBCODE_HOME; do not assume that the server directory alone isolates every webview cache.
3. (inferred) Generate large/small fixtures with the sketch below. Record actual counts/packed-ref size; do not recreate a 17 GB private pack merely to exercise list cardinality. The no-checkout worktrees exercise catalog counts without duplicating all files; hydrate selected worktrees separately if that behavior matters.
4. (inferred) Capture the **first unminified #185 component stack**, the LegendList instance and its owning popup, open/mounted/hidden/connectivity state, ancestor geometry, item count, measured rect, previous/new size, totalSize, range and layout epoch. Use React Profiler/why-did-you-render on GitManagerBranchDropdown and relevant rows, plus bounded temporary library counters. Stop external fixture emissions and assert counters settle; avoid logging repository content or private paths.
5. (inferred) Measure raw/decoded response bytes, entry count and truncated for listEntries, plus actual branch/tag/worktree counts for getRefs; correlate response completion, picker close, checkout completion and Fetch click/RPC. Large payloads are factors, not identities of the failing list.
6. (measured) Existing [apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.test.tsx:10–34](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/web/src/components/gitManager/toolbar/GitManagerBranchDropdown.test.tsx#L10-L34) mocks both LegendList and Popover; [apps/web/src/components/chat/MessagesTimeline.itemTypes.test.tsx:49–101](https://github.com/mubeda/BibCode/blob/a9938193b843c15b8870d39c0ee9ed63275702b5/apps/web/src/components/chat/MessagesTimeline.itemTypes.test.tsx#L49-L101) offers a real-library measurement-stub precedent but not hidden-popup coverage. (inferred) Add a **real-library browser/component regression**: mount the actual branch popup with thousands of refs; hide it through the real Base UI keepMounted lifecycle; replace refs; assert no boundary/error and stable total size/container count; reopen and verify visible rows/scrolling. A mocked LegendList test cannot cover this failure.
7. (inferred) Add a focused virtualizer regression with controlled measurements: visible 30px rows → hidden 0×0 → data update → reveal. Include the deferred-shrink frame followed by hiding. Compare short and long lists, patched ESM and CJS artifacts where the harness supports them. Separately alternate nonzero heights/scrollbar-width-dependent wrapping to test H-unstable; use deterministic measurement sequencing and assert a stable final total size, not just absence of a console message.
8. (inferred) Run the same exact failing fixture unchanged except for the proposed guard, then unchanged except for caller gating, then together. A red→green result on the reported chain upgrades the cause to confirmed. Finally qualify macOS WebKit with the actual Git Manager branch-switch/Fetch flow and small-repo control; do not infer that a DOM-only mock proves the native renderer.

(inferred) Synthetic fixture script sketch follows; **not run**. All generated data is disposable and synthetic. It creates about 50k tracked files, 4k branches plus 4k tags (approximately 500 KB packed refs; print actual bytes), 20 worktree records including the primary, and a local bare remote so Fetch has no external account dependency.

```python
# (inferred) Future confirmation fixture sketch ONLY. Not executed in this investigation.
# (inferred) Uses synthetic content and local disposable bare remotes; no private data.
from pathlib import Path
import os
import subprocess
import tempfile

case = Path(tempfile.mkdtemp(prefix='confirmation-', dir=tempfile.gettempdir()))
env = os.environ.copy()
env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')

def git(repo, *args, text=None):
    return subprocess.check_output(
        ['git', '-C', str(repo), '-c', 'user.name=Fixture', '-c', 'user.email=fixture',
         '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', *args],
        input=text, text=True, env=env,
    ).strip()

def make_repo(name, files, ref_pairs, linked_worktrees):
    repo = case / name
    repo.mkdir()
    git(repo, 'init', '-b', 'master')
    for i in range(files):
        path = repo / f'src/group-{i // 100:04d}/synthetic-file-{i:06d}.txt'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'fixture {i}\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'synthetic master')
    master = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'switch', '-c', 'develop')
    (repo / 'src/group-0000/synthetic-file-000000.txt').write_text('develop fixture\n')
    git(repo, 'commit', '-am', 'synthetic develop')
    develop = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'switch', 'master')
    commands = []
    for i in range(ref_pairs):
        tip = master if i % 2 == 0 else develop
        commands += [f'create refs/heads/branch-{i:05d} {tip}',
                     f'create refs/tags/tag-{i:05d} {tip}']
    git(repo, 'update-ref', '--stdin', text='\n'.join(commands) + '\n')
    # Main + 19 linked worktrees = 20 records without copying 50k files 20 times.
    for i in range(linked_worktrees):
        git(repo, 'worktree', 'add', '--no-checkout', '-b', f'wt-{i:02d}',
            str(case / f'{name}-wt-{i:02d}'), 'master')
    git(repo, 'pack-refs', '--all')
    remote = case / f'{name}-remote.git'
    git(repo, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', '-u', 'origin', 'master', 'develop')
    git(repo, 'fetch', 'origin')
    packed_bytes = (repo / '.git/packed-refs').stat().st_size
    tracked = len([x for x in git(repo, 'ls-files', '-z').split('\0') if x])
    worktrees = sum(line.startswith('worktree ') for line in
                    git(repo, 'worktree', 'list', '--porcelain').splitlines())
    print(name, 'tracked=', tracked, 'packed_refs_bytes=', packed_bytes,
          'worktrees=', worktrees, 'path=', repo)
    return repo

large = make_repo('large', 50_000, 4_000, 19)
small = make_repo('small', 30, 4, 0)
(case / 'userdata').mkdir()
(case / 'browser-profile').mkdir()
print('Fresh fixture root:', case)
# (inferred) Add more commits or hydrate a linked worktree only for a separate graph/worktree case.
# (inferred) Do not run app/tests or cleanup from this sketch. Future session owns those actions.
```

## Non-goals

- (inferred) No Git status/performance rewrite, larger server limits, branch truncation or generic memoization campaign; none targets the measured library path.
- (inferred) No copying/private-repo access, production instrumentation, process restart, database/log access, or executing this confirmation plan in the current read-only diagnosis.
- (inferred) No changes to branch/stash preservation, authentication, worktree ownership, mutation ordering, or the existing timeline scroll fixes.
- (inferred) The profiler/error-boundary reporting gap is a separate follow-up below, not acceptance scope for this bug.

## Related and duplicate check

(measured) Immediately before filing, open-issue searches `185 in:title,body` and `Git Manager crash` (limit 20) both returned zero results.

(measured) Prior five all-state searches (`185`, `Environments`, `maximum update depth`, `add repository`, `React error`) returned 61 unique results, with no capped search. Follow-up searches `React error`, `Git Manager`, `branch fetch` returned 26, 21 and 4 results respectively, all below limit 50. Relevant complete bodies/comments were read. (inferred) No same-flow BiBCode duplicate was identified; search wording cannot prove absence.

- (measured) [BiBCode #228](https://github.com/mubeda/BibCode/issues/228) CLOSED: timeline update-depth failure with long replies. (inferred) Related library/error class, different trigger; sticky item-type/size-bucket correction already present, not this hidden-popup guard.
- (measured) [#85](https://github.com/mubeda/BibCode/issues/85) CLOSED: slow getRefs server overhead; [#345](https://github.com/mubeda/BibCode/issues/345) CLOSED: status waits behind a Git mutation; [#137](https://github.com/mubeda/BibCode/issues/137) CLOSED: branch switch mishandles untracked changes. (inferred) Related Git surfaces, different failure mechanisms; none establishes a duplicate of this client layout crash.
- (measured) Upstream #567/#559 are linked above as the matching mechanism and pending correction, not duplicate BiBCode tracker entries. The patch still lacks those guards in both investigated versions.

## Open questions

- (inferred) Owner: implementing engineer. Confirm the exact failing LegendList instance and whether its rect is 0×0; symbolization identifies the library chain but no app owner. This must be resolved before claiming confirmation.
- (inferred) Owner: fixture author. Determine the smallest branch-row count and exact visibility/data sequence that fails; distinguish initial closed mount, popup close, branch mutation refresh and Fetch refresh.
- (inferred) Owner: triage. Correlate the supplied batch windows and one runOperation with the recollected Fetch click; do not silently turn those into two observed server mutations.
- (inferred) Owner: implementing engineer. The most useful confirmation is bounded synthetic component/geometry evidence and a one-variable failure flip. RPC timing/subscription metadata may correlate arrival but cannot establish hidden geometry. No further production log or profiler access is required by this issue.

## Related follow-up (not part of this bug)

(measured: supplied investigation finding) The profiler has no event type for React exceptions caught by the error boundary. (inferred) Suggested separate issue title: **“Diagnostics: record React errors caught by the application error boundary”**. This reporting gap neither causes nor fixes the LegendList loop and adds no requirement or label to this bug.

## Evidence and decision record

- (measured) Followed mstack-diagnose for evidence separation, mstack-write-specs adapted to the supplied issue format, and mstack-backlog-triage for this single draft. Runtime steps were explicitly excluded; the repository owner subsequently authorized filing this one issue. Supported mechanism is not a confirmed fix; no test has flipped it.
- (measured) Evidence was read using committed main/tag source, Git history/diffs, existing installed dependencies, published package source, and read-only issue/PR pages. No install, app, tests, database, production profile/log, secret or process operation was used. No scratch worktree was created.
- (measured) Main vs tag: branch popup, toolbar, panel, shared popover, LegendList patch and core measurement code are unchanged; affected Git Manager row files differ only in presentation classes. There is no evidence that PR #349 introduced this mechanism.
- (inferred; agent's call) Type bug; priority P1/high; size M; labels bug, needs-triage, size:M. Recommend holding the next release until this UI-wide failure has isolated confirmation and passing regression coverage; this is a triage proposal, not a release action. The triage proposal above records the diagnosis gate.
- (measured) No `vp check`, `vp run typecheck`, Rust checks, browser tests, or native validation ran; they were prohibited for this diagnosis. Profiler coverage: no runtime implementation or instrumentation changed. The separate reporting follow-up remains out of scope.
