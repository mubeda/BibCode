# Pull Requests / Phase 00 — Contracts, capabilities, scopes, fixtures, client atoms

> **For agentic workers:** this phase is implemented by Codex (`codex:rescue`) and reviewed by the coordinating Claude session. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go. Work red → green: write the failing test, run it, implement, run it again.

**Goal:** Wire the entire feature's typed boundary once: the `PullRequests*` schemas, the ten `pullRequests.*` RPCs registered in every place the repository gates, the two capability flags, the client setting, the client-runtime atom family, and the fixture counts — so every later phase only fills in behaviour.

**Architecture:** `packages/contracts/src/pullRequests.ts` holds every schema from the plan's § Contracts verbatim. `rpc.ts` gains ten `Rpc.make` constants added to `WsRpcGroup`. The server registers the same ten names in `ACTIVE_RPC_METHODS` and `required_scope`, advertises `pullRequestsReads` / `pullRequestsMutations`, and the typed-failure fixtures are regenerated with both hard-coded counts bumped. No handler exists yet: a registration tripwire test in Phase 01 will fail until then, which is expected.

**Tech Stack:** effect `Schema` (contracts), Rust (`apps/server/src/rpc/methods.rs`, `auth/scope.rs`, `production/control.rs`), Vitest, cargo test, the fixture export script `packages/contracts/scripts/export-rust-rpc-fixtures.ts`.

---

## Files

- **Create:** `packages/contracts/src/pullRequests.ts` — every schema in the plan § Contracts
- **Create:** `packages/contracts/src/pullRequests.test.ts` — decode/round-trip tests
- **Modify:** `packages/contracts/src/index.ts` — `export * from "./pullRequests.ts";`
- **Modify:** `packages/contracts/src/rpc.ts` — `WS_METHODS` block, ten `Rpc.make`, `WsRpcGroup` members
- **Modify:** `packages/contracts/src/environment.ts:30-53` — `pullRequestsReads`, `pullRequestsMutations`
- **Modify:** `packages/contracts/src/settings.ts` — `pullRequestsEnabled` in `ClientSettingsSchema` (default `true`) and `ClientSettingsPatch`
- **Modify:** `packages/shared/src/testSupport.ts` — the two flags default `false`
- **Modify:** `packages/contracts/scripts/export-rust-rpc-fixtures.ts` — counts `121 → 131`, `278 → N` (measured)
- **Modify (generated):** `packages/contracts/fixtures/rpc-wire/manifest.json`, `fixtures/rpc-wire/typed-failures/pullRequests__*-00.json`
- **Modify:** `apps/server/src/rpc/methods.rs` — ten entries in `ACTIVE_RPC_METHODS`
- **Modify:** `apps/server/src/auth/scope.rs` — eight read + two operate arms, and the test arrays at the bottom
- **Modify:** `apps/server/src/production/control.rs` — capability literal (~~:2152) and the descriptor test list (~~:5044)
- **Modify:** `apps/server/tests/rpc_wire.rs` — `121 → 131`, `278 → N` (measured)
- **Create:** `packages/client-runtime/src/state/pullRequests.ts` — `createPullRequestsEnvironmentAtoms`
- **Modify:** `packages/client-runtime/package.json` — export `"./state/pull-requests"`

## Dependencies

None. First phase.

## Owner Agent

Codex via `codex:rescue` (implementer). Reviewer: coordinator.

## Risk / Effort

Risk: Medium (five registration sites and two count gates must agree). Effort: ~3 h.

---

## Discipline

- Read `AGENTS.md` at the repository root first; it governs pre-work, evidence, and completion.
- Red → green for every schema and every registration: a test fails, then passes.
- Before marking complete, run every command in § Verification and paste the results into `tasks.md`.
- Never hand-edit anything under `packages/contracts/fixtures/rpc-wire/`; regenerate with `vp run --filter @bibcode/contracts generate:rust-rpc-fixtures`.

## Documents to Read

- `docs/plans/pull-requests/pull-requests-spec.md` — § 2 hard constraints, § 6 availability, § 7 permissions shape (the field list is binding)
- `docs/plans/pull-requests/pull-requests-plan.md` — § Contracts (this phase implements it verbatim), § Global Constraints
- `docs/plans/pull-requests/research/bibcode-integration-surface.md` — § 4 (contracts), § 8 (gating)
- `docs/architecture/rpc-and-orchestration.md` — protocol and scope rules a new method must satisfy
- `packages/contracts/src/gitManager.ts` and the Git Manager block of `packages/contracts/src/rpc.ts` — the style to copy

---

## Pre-execution check

- [x] **Step 00.0: Claim the phase.** Open `../tasks.md`. Change Phase 00 row → `Status = in_progress`, `Agent = codex-00`, `Started = YYYY-MM-DD HH:MM`. Append `- YYYY-MM-DD HH:MM — picked up` under the Phase 00 Detailed Progress section.

## Atomic steps

- [x] **Step 00.1: Locate and record every registration site and today's counts.**

  ```bash
  rg -n 'WS_METHODS = \{|RpcGroup.make|WsGitManagerListPullRequestsRpc' packages/contracts/src/rpc.ts
  rg -n 'ACTIVE_RPC_METHODS' apps/server/src/rpc/methods.rs
  rg -n 'gitManager\.' apps/server/src/auth/scope.rs
  rg -n 'Expected 121|Expected 70|278' packages/contracts/scripts/export-rust-rpc-fixtures.ts
  rg -n 'assert_eq!\(rust_methods.len|typed_failure_fixtures.len|stream_shape_fixtures.len' apps/server/tests/rpc_wire.rs
  rg -n 'gitManagerPullRequests' packages/contracts/src/environment.ts apps/server/src/production/control.rs packages/shared/src/testSupport.ts
  ```

  Record the counts in `tasks.md`. At decomposition time: **121 methods, 20 stream methods, 70 stream shapes, 278 typed failures**. After this phase: **131 methods, 20 stream methods, 70 stream shapes, and the typed-failure count the generator reports (Step 00.9).** If the working tree disagrees, the working tree wins; note it.

- [x] **Step 00.2: Author the first failing contracts test.** Path: `packages/contracts/src/pullRequests.test.ts`

  ```ts
  import { Schema } from "effect/schema";
  import { describe, expect, it } from "vitest";
  import {
    PullRequestsActionRequest,
    PullRequestsContext,
    PullRequestsListPage,
    PullRequestsOperationError,
    PullRequestsPermissions,
  } from "./pullRequests.ts";

  const permission = (allowed: boolean, reason: string | null = null) => ({ allowed, reason });

  describe("PullRequests contracts", () => {
    it("decodes an unavailable context with an actionable auth command", () => {
      const context = Schema.decodeUnknownSync(PullRequestsContext)({
        status: "unavailable",
        code: "not_authenticated",
        message: "glab is not authenticated for git.acme.example.",
        provider: "gitlab",
        host: "git.acme.example",
        installHint: null,
        authCommand: "glab auth login --hostname git.acme.example",
      });
      expect(context.status).toBe("unavailable");
    });

    it("keeps every permission as {allowed, reason} and merge with its methods", () => {
      const base = Object.fromEntries(
        [
          "comment",
          "editOwnComment",
          "deleteOwnComment",
          "minimizeComment",
          "react",
          "resolveThreads",
          "review",
          "approve",
          "requestChanges",
          "revokeApproval",
          "removeOwnChangeRequest",
          "dismissReview",
          "rerequestReview",
          "applySuggestion",
          "editPullRequest",
          "editReviewers",
          "editAssignees",
          "editLabels",
          "editMilestone",
          "lock",
          "unlock",
          "mergeBypass",
          "enableAutoMerge",
          "disableAutoMerge",
          "markReady",
          "convertToDraft",
          "close",
          "reopen",
          "delete",
          "revert",
          "checkout",
        ].map((key) => [key, permission(false, "not now")]),
      );
      const decoded = Schema.decodeUnknownSync(PullRequestsPermissions)({
        ...base,
        updateBranch: { allowed: true, reason: null, methods: ["merge", "rebase"] },
        merge: {
          allowed: false,
          reason: "Merging is blocked: 1 approving review required",
          methods: ["squash"],
          defaultMethod: "squash",
          deleteBranchDefault: true,
        },
      });
      expect(decoded.merge.methods).toEqual(["squash"]);
      expect(decoded.approve.reason).toBe("not now");
    });

    it("decodes a GitHub cursor page and a GitLab numbered page the same way", () => {
      const page = Schema.decodeUnknownSync(PullRequestsListPage)({
        rows: [],
        nextCursor: "2",
        totalCount: 67,
        counts: { open: 67, closed: 783, merged: null },
      });
      expect(page.nextCursor).toBe("2");
    });

    it("rejects an action with an unknown tag and accepts a review submission", () => {
      expect(() =>
        Schema.decodeUnknownSync(PullRequestsActionRequest)({
          cwd: "/repo",
          number: 1,
          action: "explode",
        }),
      ).toThrow();
      const review = Schema.decodeUnknownSync(PullRequestsActionRequest)({
        cwd: "/repo",
        number: 14,
        action: "submitReview",
        event: "request_changes",
        body: "Please fix",
        headSha: "56f329c8d73023c9b3712e4e8699e6e1a030f0f1",
        comments: [{ path: "src/a.ts", line: 10, startLine: null, side: "right", body: "nit" }],
      });
      expect(review.action).toBe("submitReview");
    });

    it("carries host detail and retryability on the error", () => {
      const error = new PullRequestsOperationError({
        operation: "merge",
        code: "stale_head",
        message: "The pull request changed since you loaded it.",
        hostDetail: null,
        retryable: false,
      });
      expect(error._tag).toBe("PullRequestsOperationError");
    });
  });
  ```

- [x] **Step 00.3: Run it; expect FAIL** (module missing).

  ```bash
  vp test run packages/contracts/src/pullRequests.test.ts
  ```

- [x] **Step 00.4: Create `packages/contracts/src/pullRequests.ts`** with every schema from `pull-requests-plan.md` § Contracts, in this order: common → context/vocabulary → list → detail → timeline → commits/checks/files → actions → checkout → error. Use `Schema.Struct`, `Schema.Literals`, `Schema.NullOr`, `Schema.Array`, `Schema.Union`, `TrimmedNonEmptyStringSchema` for names/ids/titles (import it the way `gitManager.ts` does), plain `Schema.String` for bodies (may be empty), `Schema.Number` for counts. Export a `type X = typeof X.Type` after every struct. The action union is a `Schema.Union` of structs each with `action: Schema.Literal("comment")` etc.; the discriminator field name is `action`. The error class:

  ```ts
  export class PullRequestsOperationError extends Schema.TaggedError<PullRequestsOperationError>()(
    "PullRequestsOperationError",
    {
      operation: TrimmedNonEmptyStringSchema,
      code: TrimmedNonEmptyStringSchema,
      message: TrimmedNonEmptyStringSchema,
      hostDetail: Schema.NullOr(Schema.String),
      retryable: Schema.Boolean,
    },
  ) {}
  ```

  Add `export * from "./pullRequests.ts";` to `packages/contracts/src/index.ts` next to the gitManager line.

- [x] **Step 00.5: Run Step 00.2; expect PASS.**

- [x] **Step 00.6: Register the ten RPCs in `packages/contracts/src/rpc.ts`.** Add a `// Pull Requests methods` block to `WS_METHODS` after the Git Manager block with the exact keys and names from the plan table (`pullRequestsGetContext: "pullRequests.getContext"`, … `pullRequestsCheckout: "pullRequests.checkout"`). Add ten `Rpc.make` constants named `WsPullRequestsGetContextRpc` … `WsPullRequestsCheckoutRpc` after `WsSubscribeGitManagerSignalRpc`, each `{ payload, success, error: PullRequestsOperationError }` with the payload/success pairs from the plan table, none streaming. Append all ten to `WsRpcGroup = RpcGroup.make(...)` after `WsSubscribeGitManagerSignalRpc`. Add a test to `pullRequests.test.ts`:

  ```ts
  import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
  it("registers the ten pullRequests methods in the RPC group", () => {
    const tags = [...WsRpcGroup.requests.keys()];
    for (const key of Object.keys(WS_METHODS).filter((k) => k.startsWith("pullRequests"))) {
      expect(tags).toContain(WS_METHODS[key as keyof typeof WS_METHODS]);
    }
    expect(tags.filter((t) => t.startsWith("pullRequests.")).length).toBe(10);
  });
  ```

- [x] **Step 00.7: Capability flags and client setting.** In `environment.ts` add after `gitManagerPullRequests`:

  ```ts
  pullRequestsReads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  pullRequestsMutations: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ```

  In `settings.ts` add to `ClientSettingsSchema` (alphabetical position near `providerModelPreferences`) `pullRequestsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)))` and the matching optional field in `ClientSettingsPatch`. In `packages/shared/src/testSupport.ts` add `pullRequestsReads: false, pullRequestsMutations: false`. Run `vp run typecheck` — every exhaustive object literal of `ExecutionEnvironmentCapabilities` in tests will now fail to compile; fix each by adding the two fields (search `gitManagerPullRequests:` across `apps/web` and `packages`).

- [x] **Step 00.8: Server registration.** In `apps/server/src/rpc/methods.rs` add to `ACTIVE_RPC_METHODS`, keeping the file's grouping style:

  ```rust
  read_unary("pullRequests.getContext"),
  read_unary("pullRequests.getVocabulary"),
  read_unary("pullRequests.list"),
  read_unary("pullRequests.get"),
  read_unary("pullRequests.getTimeline"),
  read_unary("pullRequests.getCommits"),
  read_unary("pullRequests.getChecks"),
  read_unary("pullRequests.getFiles"),
  mutation_unary("pullRequests.runAction"),
  mutation_unary("pullRequests.checkout"),
  ```

  In `apps/server/src/auth/scope.rs` add the eight read names to the `SCOPE_ORCHESTRATION_READ` arm and the two mutation names to the `SCOPE_ORCHESTRATION_OPERATE` arm, and extend the test arrays at the bottom of the file the same way (the test `every_active_method_has_exactly_one_scope`, or whatever it is named there, must keep passing). In `apps/server/src/production/control.rs` add `"pullRequestsReads": true, "pullRequestsMutations": true,` to the capabilities literal and the two names to the descriptor test's capability list.

- [x] **Step 00.9: Regenerate fixtures and bump counts.** The typed-failure count is **not** one per method (the Git Manager added 36 fixtures for 20 methods, because union-error schemas fan out). Do not guess it. Edit `packages/contracts/scripts/export-rust-rpc-fixtures.ts`: `121 → 131` (check and message). Run:

  ```bash
  vp run --filter @bibcode/contracts generate:rust-rpc-fixtures
  ```

  It will fail with `Expected 278 typed failure fixtures, found N`. Set `278 → N` in the script and in `apps/server/tests/rpc_wire.rs` (`typed_failure_fixtures.len()`), re-run the generator, then:

  ```bash
  git status --short packages/contracts/fixtures
  ```

  Expect new `typed-failures/pullRequests__*.json` files and an updated `manifest.json`; record `N` in `tasks.md` § Counts. Set `rpc_wire.rs` `rust_methods.len()` to 131.

- [x] **Step 00.10: Client-runtime atoms.** Create `packages/client-runtime/src/state/pullRequests.ts`:

  ```ts
  import { WS_METHODS } from "@bibcode/contracts";
  import { Atom } from "effect/unstable/reactivity";

  import type { EnvironmentRegistry } from "../connection/registry.ts";
  import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
  import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

  export function createPullRequestsEnvironmentAtoms<R, E>(
    runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  ) {
    return {
      getContext: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:get-context",
        tag: WS_METHODS.pullRequestsGetContext,
        staleTimeMs: 60_000,
      }),
      getVocabulary: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:get-vocabulary",
        tag: WS_METHODS.pullRequestsGetVocabulary,
        staleTimeMs: 60_000,
      }),
      list: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:list",
        tag: WS_METHODS.pullRequestsList,
        staleTimeMs: 5_000,
      }),
      get: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:get",
        tag: WS_METHODS.pullRequestsGet,
        staleTimeMs: 5_000,
      }),
      getTimeline: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:get-timeline",
        tag: WS_METHODS.pullRequestsGetTimeline,
        staleTimeMs: 5_000,
      }),
      getCommits: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:get-commits",
        tag: WS_METHODS.pullRequestsGetCommits,
        staleTimeMs: 30_000,
      }),
      getChecks: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:get-checks",
        tag: WS_METHODS.pullRequestsGetChecks,
        staleTimeMs: 5_000,
      }),
      getFiles: createEnvironmentRpcQueryAtomFamily(runtime, {
        label: "environment-data:pull-requests:get-files",
        tag: WS_METHODS.pullRequestsGetFiles,
        staleTimeMs: 30_000,
      }),
      runAction: createEnvironmentRpcCommand(runtime, {
        label: "environment-data:pull-requests:run-action",
        tag: WS_METHODS.pullRequestsRunAction,
        scheduler: vcsCommandScheduler,
        concurrency: vcsCommandConcurrency,
      }),
      checkout: createEnvironmentRpcCommand(runtime, {
        label: "environment-data:pull-requests:checkout",
        tag: WS_METHODS.pullRequestsCheckout,
        scheduler: vcsCommandScheduler,
        concurrency: vcsCommandConcurrency,
      }),
    };
  }
  ```

  Match the exact option names `createGitManagerEnvironmentAtoms` uses (re-read `gitManager.ts`; if `createEnvironmentRpcCommand` takes different keys, follow the file, not this snippet). Add to `packages/client-runtime/package.json` `exports` next to `./state/git-manager`: `"./state/pull-requests": { "types": "./src/state/pullRequests.ts", "default": "./src/state/pullRequests.ts" }`. Add a test next to the Git Manager atoms test (find it with `rg -l createGitManagerEnvironmentAtoms packages/client-runtime/src`) asserting the ten atom keys exist.

- [x] **Step 00.11: Full gate.**

  ```bash
  vp run --filter @bibcode/contracts test
  vp run --filter @bibcode/client-runtime test
  vp run --filter @bibcode/shared test
  vp run typecheck
  vp check
  cargo fmt --all --check
  cargo clippy -p bibcode-server --all-targets -- -D warnings
  cargo test -p bibcode-server --test rpc_wire -j 2
  cargo test -p bibcode-server scope -j 2
  cargo test -p bibcode-server environment_descriptor -j 2
  ```

  Expected: all green. `production/git_manager_rpc.rs`'s "registers every method" test is untouched. **Known and expected:** `apps/server/src/rpc/session.rs` `validate_complete` (or its equivalent startup check) may fail at runtime start because ten methods have no handler; Phase 01 registers them. If a _test_ asserts completeness against `ACTIVE_RPC_METHODS`, register temporary `not_implemented` handlers in a new `apps/server/src/production/pull_requests_rpc.rs` with a `register_pull_requests_rpc(registry, PullRequestsRpcServices)` function called from `production/runtime.rs` right after `register_git_manager_rpc`, returning `not_implemented_error(&request.tag)` for all ten — Phase 01 replaces them.

- [x] **Step 00.12: TDD proof.** Remove one `Rpc.make` from `WsRpcGroup`; confirm the Step 00.6 test and the fixture export fail; restore. Remove one `pullRequests.*` arm from `required_scope`; confirm the scope test fails; restore.

- [x] **Step 00.13: Mark phase complete** in `tasks.md` with the final counts, the list of files, the test count, and any deviation.

> **No commit step.** Phases are commit-free; the coordinator decides on commits.

---

## Verification

- [x] `packages/contracts/src/pullRequests.ts` contains every schema named in the plan § Contracts with the exact field names; `index.ts` exports it.
- [x] `WS_METHODS`, ten `Rpc.make`, `WsRpcGroup`, `ACTIVE_RPC_METHODS`, `required_scope` (+ its test arrays), fixtures + manifest, both counts (131 / the measured N) all agree; `rpc_wire` passes.
- [x] `pullRequestsReads` / `pullRequestsMutations` exist in contracts (default false), `control.rs` (true, both sites), `testSupport.ts` (false).
- [x] `pullRequestsEnabled` client setting decodes to `true` by default.
- [x] `@bibcode/client-runtime/state/pull-requests` resolves and exposes ten atoms.
- [x] `vp check`, `vp run typecheck`, `cargo fmt --check`, clippy `-D warnings` clean; contracts, client-runtime, shared and the three server test filters green.
- [x] `git diff --stat` shows no dependency or lockfile change.
- [x] TDD proof performed and described in `tasks.md`.

> All Step 00.11 commands ran. Full network-dependent gate success remains unverified because this sandbox denies TCP listeners; exact failures and passing parity/authorization/descriptor checks are in `../tasks.md`.

## Notes for downstream phases

- Wire names, `WS_METHODS` keys, schema symbol names, and the `action` discriminator values are fixed here; later phases add **variants and fields only** through the same file and regenerate fixtures each time (`generate:rust-rpc-fixtures`, then bump the typed-failure count only if a new _method_ is added — never for new variants).
- The client atom object is `createPullRequestsEnvironmentAtoms(runtime)` with keys `getContext, getVocabulary, list, get, getTimeline, getCommits, getChecks, getFiles, runAction, checkout`.
- The capability flags are read by Phase 02's `pullRequestsAvailability.ts`; nothing else reads `serverConfig` for this feature.
- The temporary `not_implemented` handlers (if created in Step 00.11) live in `apps/server/src/production/pull_requests_rpc.rs`; Phase 01 replaces that file's body and keeps the function name `register_pull_requests_rpc`.
