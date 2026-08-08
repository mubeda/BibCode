# Claude Local Authentication Observer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BiBCode observe Claude CLI authentication as fresh read-only local state, while making explicit usage refreshes and Claude re-enable refreshes deterministic.

**Architecture:** `apps/server` remains the usage-network owner but stops caching, refreshing, or writing Claude credentials. The typed provider-usage RPC distinguishes throttled background work from forced user work, and `apps/web` uses that distinction for the status bar and Settings → Agents re-enable flow.

**Tech Stack:** Rust 1.97/Tokio/Reqwest/Serde/SHA-256, Effect Schema and Effect RPC, React 19, Vite+/Vitest.

## Global Constraints

- Modify BiBCode only; never edit `/Users/admin/projects/orca`.
- Preserve Settings → Agents and the installed local Claude CLI account model.
- Do not add or extend AI Provider Account management.
- The Claude CLI is the sole writer and refresher of its local credentials.
- Never put credential values in logs, command arguments, RPC payloads, or UI state.
- Keep background usage refreshes throttled at 30 seconds and let explicit user refreshes bypass only that throttle.
- Preserve provider refresh generation ownership, cancellation, timeout, stale-result, and last-good-snapshot behavior.
- Use the existing typed WebSocket RPC boundary; do not add a desktop bridge path.

---

### Task 1: Add Explicit Forced Provider-Usage Refresh

**Files:**

- Modify: `packages/contracts/src/providerUsage.ts:60`
- Modify: `packages/contracts/src/providerUsage.test.ts`
- Modify: `apps/server/src/provider_usage/mod.rs:306`
- Modify: `apps/server/src/production/server_terminal.rs:247`
- Modify: `apps/server/tests/provider_usage_domain.rs:495`
- Modify: `apps/server/tests/production_server_terminal_rpc.rs:1070`

**Interfaces:**

- Consumes: existing `ServerProviderUsageRefreshInput`, `ProviderUsageService`, and `server.refreshProviderUsage` handler.
- Produces: optional wire field `force?: boolean` and public Rust method `ProviderUsageService::refresh_forced(selected_providers)`.

- [ ] **Step 1: Write failing contract tests for `force`**

Add literal decode cases to `packages/contracts/src/providerUsage.test.ts`:

```ts
const forced = Schema.decodeUnknownSync(ServerProviderUsageRefreshInput)({
  providers: ["claude"],
  force: true,
});
expect(forced.force).toBe(true);
expect(decodes(ServerProviderUsageRefreshInput, { force: "true" })).toBe(false);
```

The production change that makes this test pass is adding an optional boolean field; a string must remain invalid.

- [ ] **Step 2: Run the contract test and observe RED**

Run: `vp test run packages/contracts/src/providerUsage.test.ts`

Expected: FAIL because `force` is an excess property or is not represented by the schema.

- [ ] **Step 3: Add the schema field**

Change the input schema to:

```ts
export const ServerProviderUsageRefreshInput = Schema.Struct({
  providers: Schema.optional(Schema.Array(ServerProviderUsageProvider)),
  force: Schema.optional(Schema.Boolean),
});
```

- [ ] **Step 4: Run the contract test and observe GREEN**

Run: `vp test run packages/contracts/src/providerUsage.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing Rust domain coverage for forced refresh**

Keep the existing throttled boundary test and add a second test in `provider_usage_domain.rs` that calls a wished-for public API:

```rust
#[tokio::test]
async fn forced_refresh_bypasses_the_background_refresh_throttle() {
    let now = fixed_time();
    let calls = Arc::new(AtomicUsize::new(0));
    let service = ProviderUsageService::new(
        vec![fetcher(ProviderUsageProvider::Claude, {
            let calls = calls.clone();
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async move { Ok(snapshot(ProviderUsageProvider::Claude, now)) }
            }
        })],
        Arc::new(move || now),
    );

    service.refresh(Some(vec![ProviderUsageProvider::Claude])).await;
    service
        .refresh_forced(Some(vec![ProviderUsageProvider::Claude]))
        .await;

    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
```

The mutation caught is routing a user refresh through `RefreshPolicy::Throttled`.

- [ ] **Step 6: Run the Rust domain test and observe RED**

Run: `cargo test -p bibcode-server --test provider_usage_domain forced_refresh_bypasses_the_background_refresh_throttle -- --nocapture`

Expected: compile failure because `refresh_forced` does not exist.

- [ ] **Step 7: Add the forced service method**

Add next to `refresh`:

```rust
pub async fn refresh_forced(
    &self,
    selected_providers: Option<Vec<ProviderUsageProvider>>,
) -> ProviderUsageResult {
    self.refresh_with_policy(selected_providers, RefreshPolicy::Forced)
        .await
}
```

Do not alter the existing throttled `refresh` method.

- [ ] **Step 8: Add failing RPC decoding/routing coverage**

Extend `RefreshProviderUsageInput` coverage so missing `force` decodes to false and `force: true` selects the forced method. Use the production RPC fixture with a counting fetcher and send two same-time requests: the first without `force`, the second with `force: true`; assert two fetches occurred. Also assert `force: "true"` yields `RpcRequestInvalid`.

- [ ] **Step 9: Run the focused RPC tests and observe RED**

Run: `cargo test -p bibcode-server --test production_server_terminal_rpc refresh_provider_usage -- --nocapture`

Expected: FAIL because the Rust payload does not accept or route `force`.

- [ ] **Step 10: Implement RPC routing**

Change the Rust payload and handler:

```rust
#[derive(Deserialize)]
struct RefreshProviderUsageInput {
    providers: Option<Vec<String>>,
    #[serde(default)]
    force: bool,
}
```

```rust
let result = if input.force {
    usage.refresh_forced(providers).await
} else {
    usage.refresh(providers).await
};
Ok(provider_usage_to_wire(result))
```

- [ ] **Step 11: Verify Task 1**

Run:

```bash
vp test run packages/contracts/src/providerUsage.test.ts
cargo test -p bibcode-server --test provider_usage_domain forced_refresh_bypasses_the_background_refresh_throttle -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc -- --nocapture
```

Expected: all pass.

- [ ] **Step 12: Commit Task 1**

```bash
git add packages/contracts/src/providerUsage.ts packages/contracts/src/providerUsage.test.ts apps/server/src/provider_usage/mod.rs apps/server/src/production/server_terminal.rs apps/server/tests/provider_usage_domain.rs apps/server/tests/production_server_terminal_rpc.rs
git commit -m "fix: support forced provider usage refresh"
```

---

### Task 2: Make Claude Credential Observation Fresh and Read-only

**Files:**

- Modify: `apps/server/src/provider_usage/mod.rs:24-920`

**Interfaces:**

- Consumes: `CLAUDE_CONFIG_DIR`, `BIBCODE_CLAUDE_KEYCHAIN_ACCESS`, macOS `/usr/bin/security`, and Anthropic's OAuth usage endpoint.
- Produces: ordered `ClaudeCredentialStore` values that are reread on each fetch, `claude_keychain_services(config_dir)`, and a read-only usage request with 401-only source fallback.

- [ ] **Step 1: Write a failing test that local expiry is advisory**

Change the expired-token test to require the existing access token:

```rust
#[test]
fn claude_oauth_token_uses_access_token_after_local_expiry() {
    let token = select_claude_oauth_token(
        None,
        Some(r#"{"claudeAiOauth":{"accessToken":"server-valid-token","refreshToken":"refresh-token","expiresAt":1}}"#),
    );
    assert_eq!(token.as_deref(), Some("server-valid-token"));
}
```

The mutation caught is rejecting a token solely from local `expiresAt` and entering BiBCode's refresh writer.

- [ ] **Step 2: Run the token test and observe RED**

Run: `cargo test -p bibcode-server claude_oauth_token_uses_access_token_after_local_expiry -- --nocapture`

Expected: FAIL with `None` instead of `server-valid-token`.

- [ ] **Step 3: Make token selection read-only**

Replace `claude_oauth_access_token(credentials, now)` with a helper that only trims and returns `/claudeAiOauth/accessToken`. Remove the time parameter from token-selection callers. Do not consult `expiresAt`.

- [ ] **Step 4: Write a failing end-to-end read-only file test**

Replace `expired_claude_credentials_are_refreshed_persisted_and_used_for_usage` with a test that:

1. writes a literal credential JSON containing `accessToken: "externally-owned-token"`, `refreshToken: "must-not-be-used"`, and `expiresAt: 1`;
2. starts only a local usage HTTP fixture and asserts `Authorization: Bearer externally-owned-token`;
3. calls `fetch_claude_usage_from_store` without an OAuth token URL argument;
4. asserts the snapshot is `Ok` and the credential file bytes exactly equal the bytes written before the call.

The production changes caught are any OAuth refresh request or credential-file write.

- [ ] **Step 5: Run the read-only file test and observe RED**

Run: `cargo test -p bibcode-server expired_claude_credentials_are_used_without_mutating_the_store -- --nocapture`

Expected: compile or runtime failure because the current path refreshes and persists credentials.

- [ ] **Step 6: Remove BiBCode credential refresh and persistence**

Delete these provider-usage-only elements:

- `CLAUDE_OAUTH_TOKEN_URL` and `CLAUDE_OAUTH_CLIENT_ID`;
- `refresh_claude_oauth_credentials`;
- `ClaudeCredentialStore::persist`;
- `ClaudeCredentialCache::persist_and_replace_with`;
- `claude_keychain_write_command` and `write_claude_keychain_credentials`.

Make `fetch_claude_usage_from_credentials` accept an immutable `Value`, extract the current access token, and call only the usage endpoint. Preserve the credential JSON unchanged.

- [ ] **Step 7: Write a failing fresh-read test for the current Keychain cache seam**

Change the cache read test expectation from one loader call to two and rename it to describe external replacement:

```rust
#[tokio::test]
async fn claude_credential_reads_observe_external_replacement() {
    let reader = ClaudeCredentialCache::default();
    // First loader returns token-a; second loader returns token-b.
    // Assert the second returned payload contains token-b and read_calls == 2.
}
```

The mutation caught is restoring process-lifetime credential reuse.

- [ ] **Step 8: Run the fresh-read test and observe RED**

Run: `cargo test -p bibcode-server claude_credential_reads_observe_external_replacement -- --nocapture`

Expected: FAIL because the second loader is skipped and token-a is returned.

- [ ] **Step 9: Remove the process-lifetime credential cache**

Remove `ClaudeCredentialCache` from `claude_fetcher`, `fetch_claude_usage`, and the Keychain store variant. A Keychain store contains only `account` and `service`; every `load()` executes `read_claude_keychain_credentials(account, service)`.

- [ ] **Step 10: Write failing macOS service-order tests**

Add platform-gated literal assertions:

```rust
#[cfg(target_os = "macos")]
#[test]
fn claude_keychain_services_try_scoped_then_legacy() {
    assert_eq!(
        claude_keychain_services(Some("/Users/admin/.claude")),
        vec![
            "Claude Code-credentials-95be5075".to_owned(),
            "Claude Code-credentials".to_owned(),
        ],
    );
}
```

Before finalizing the literal, calculate it independently with `printf %s /Users/admin/.claude | shasum -a 256`; use the first eight hex characters in the assertion. Add a command-spec assertion proving the selected service and account appear in arguments and no credential JSON appears.

- [ ] **Step 11: Run service-order tests and observe RED**

Run: `cargo test -p bibcode-server claude_keychain_services_try_scoped_then_legacy -- --nocapture`

Expected: compile failure because service derivation is absent.

- [ ] **Step 12: Implement ordered fresh credential sources**

Use `sha2::{Digest, Sha256}` to derive the scoped service from the exact UTF-8 config-dir string. Build stores in scoped Keychain, legacy Keychain, file order; deduplicate service names. Permit Keychain for explicit `CLAUDE_CONFIG_DIR` when access is enabled. Keep the file source on every platform.

Add an internal usage-attempt error carrying `status: Option<u16>`. Continue to the next credential store only for HTTP 401; return other HTTP, JSON, and transport errors immediately. If all present tokens receive 401, return the last bounded 401 error. Never log token contents.

- [ ] **Step 13: Verify Task 2**

Run:

```bash
cargo test -p bibcode-server claude_ -- --nocapture
cargo test -p bibcode-server --test provider_usage_domain -- --nocapture
```

Expected: all pass, including the read-only byte comparison and external replacement coverage.

- [ ] **Step 14: Commit Task 2**

```bash
git add apps/server/src/provider_usage/mod.rs
git commit -m "fix: observe Claude credentials without mutation"
```

---

### Task 3: Separate Manual Status-Bar Refresh from Background Polling

**Files:**

- Modify: `apps/web/src/components/status-bar/AppStatusBar.tsx:120-390`
- Modify: `apps/web/src/components/status-bar/AppStatusBar.test.tsx:258`
- Modify: `apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx`
- Modify: `apps/web/src/components/status-bar/AppStatusBar.rerender.test.tsx:600`

**Interfaces:**

- Consumes: `serverEnvironment.refreshProviderUsage` with optional `force`.
- Produces: `createStatusBarRefreshHandler(input)(force)`; background calls use false and manual calls use true.

- [ ] **Step 1: Write failing handler tests for the wire payload**

Change the handler test to call `await handler(true)` and assert:

```ts
expect(refreshProviderUsage).toHaveBeenCalledWith({
  environmentId,
  input: { providers: ["claude", "codex"], force: true },
});
```

Add a second call with `false` and assert `force: false`. The mutation caught is losing the user/background distinction before RPC.

- [ ] **Step 2: Run the focused component test and observe RED**

Run: `vp test run apps/web/src/components/status-bar/AppStatusBar.test.tsx`

Expected: FAIL because the handler accepts no force argument and omits the field.

- [ ] **Step 3: Add force to the handler**

Change the command input type to include `readonly force: boolean`, return `async (force: boolean)`, and send:

```ts
input: { providers: ["claude", "codex"], force },
```

- [ ] **Step 4: Write a failing overlap regression test**

In the real rerender test, start an unresolved automatic refresh, click the rendered refresh button, and assert the command was invoked twice: once with `force: false` and once with `force: true`. Keep the existing repeated-button test asserting two manual clicks still create one forced request.

The mutation caught is routing the click through `refreshFlightsRef`, which joins the background request.

- [ ] **Step 5: Run the overlap test and observe RED**

Run: `vp test run apps/web/src/components/status-bar/AppStatusBar.rerender.test.tsx`

Expected: FAIL with one command invocation because manual refresh joins the background flight.

- [ ] **Step 6: Implement distinct flight ownership**

Make `performRefresh(force)` call the handler. Keep `refresh()` as the background single-flight wrapper around `performRefresh(false)`. In `handleRefresh`, keep `manualRefreshPendingRef` as the manual single-flight guard but call `performRefresh(true)` directly instead of `refresh()`. This permits one forced request to overlap a background request while preventing repeated manual activation.

- [ ] **Step 7: Verify Task 3**

Run:

```bash
vp test run apps/web/src/components/status-bar/AppStatusBar.test.tsx
vp test run apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx
vp test run apps/web/src/components/status-bar/AppStatusBar.rerender.test.tsx
vp test run apps/web/src/components/status-bar/AppStatusBar.settings-rerender.test.tsx
```

Expected: all pass.

- [ ] **Step 8: Commit Task 3**

```bash
git add apps/web/src/components/status-bar/AppStatusBar.tsx apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx apps/web/src/components/status-bar/AppStatusBar.rerender.test.tsx
git commit -m "fix: force manual provider usage refresh"
```

---

### Task 4: Refresh Claude Usage after Re-enabling the Local Agent

**Files:**

- Modify: `apps/web/src/components/settings/SettingsPanels.tsx:1250-1730`
- Modify: `apps/web/src/components/settings/SettingsPanels.test.tsx:1229-1900`

**Interfaces:**

- Consumes: successful `useUpdatePrimarySettings`, `serverEnvironment.refreshProviderUsage`, and the environment-scoped provider-usage query.
- Produces: one forced Claude-only usage refresh after a disabled-to-enabled Claude transition, followed by a query refresh.

- [ ] **Step 1: Extend the settings test harness**

Expose distinct command doubles for `serverEnvironment.refreshProviderUsage` and a provider-usage query refresh. Configure the settings update double to return a deferred `AsyncResult` so ordering is observable.

- [ ] **Step 2: Write the failing successful re-enable test**

Render a disabled default Claude instance, invoke its `onUpdate` with `enabled: true`, and assert no usage refresh before the settings promise resolves. Resolve with `AsyncResult.success`, flush, then assert:

```ts
expect(h.refreshProviderUsageCommand).toHaveBeenCalledWith({
  environmentId: ENVIRONMENT_ID,
  input: { providers: ["claude"], force: true },
});
expect(h.providerUsageQueryRefresh).toHaveBeenCalledTimes(1);
```

The mutation caught is refreshing before persistence/probe completion or omitting the usage refresh entirely.

- [ ] **Step 3: Write failing negative-path tests**

Use literal separate cases proving no forced usage refresh after:

- a rejected Claude enable settings result;
- a Claude enabled-to-disabled transition;
- an edit that leaves Claude enabled;
- a disabled-to-enabled Codex transition.

- [ ] **Step 4: Run the settings tests and observe RED**

Run: `vp test run apps/web/src/components/settings/SettingsPanels.test.tsx`

Expected: FAIL because Settings does not issue or expose a usage refresh.

- [ ] **Step 5: Implement the post-success Claude refresh**

In `EnvironmentScopedProviderSettingsPanel`:

1. create the environment-scoped provider-usage query with `useEnvironmentQuery`;
2. create the provider-usage command with `useAtomCommand(..., { reportFailure: false })`;
3. add `refreshClaudeUsage` that sends `{ providers: ["claude"], force: true }` and calls the query's `refresh()` in `finally` after the command settles;
4. extend `updateProviderInstance` options with `onSuccess?: () => void | Promise<void>`;
5. invoke `onSuccess` only when the settings command settles without `isSettingsUpdateFailure`;
6. pass `refreshClaudeUsage` only when `row.driver === "claudeAgent"`, the prior envelope was disabled, and the next envelope is enabled.

Do not refresh on disable, unrelated edits, or another provider. Do not add provider-account state.

- [ ] **Step 6: Verify Task 4**

Run: `vp test run apps/web/src/components/settings/SettingsPanels.test.tsx`

Expected: all settings panel tests pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/SettingsPanels.test.tsx
git commit -m "fix: refresh Claude usage after re-enable"
```

---

### Task 5: Align Living Documentation and Run Full Verification

**Files:**

- Modify: `docs/providers/claude.md`
- Modify: `docs/architecture/providers.md`
- Modify: `docs/architecture/rpc-and-orchestration.md`

**Interfaces:**

- Consumes: the shipped behavior from Tasks 1-4.
- Produces: current documentation of credential ownership, source order, forced refresh semantics, and independent auth/usage state.

- [ ] **Step 1: Update living documentation**

Document these exact invariants:

- BiBCode reads Claude OAuth credentials for usage but never refreshes or writes them.
- The installed Claude CLI owns login and credential rotation.
- macOS reads scoped Keychain, legacy Keychain, then the legacy file; `BIBCODE_CLAUDE_KEYCHAIN_ACCESS=disabled` disables Keychain reads.
- automatic usage refresh is throttled; explicit refresh and Claude re-enable are forced.
- `claude auth status --json` controls the Agents authentication state independently from usage endpoint errors.

- [ ] **Step 2: Run focused affected tests**

Run:

```bash
vp test run packages/contracts/src/providerUsage.test.ts
vp test run apps/web/src/components/status-bar/AppStatusBar.test.tsx apps/web/src/components/status-bar/AppStatusBar.behavior.test.tsx apps/web/src/components/status-bar/AppStatusBar.rerender.test.tsx apps/web/src/components/status-bar/AppStatusBar.settings-rerender.test.tsx
vp test run apps/web/src/components/settings/SettingsPanels.test.tsx
cargo test -p bibcode-server claude_ -- --nocapture
cargo test -p bibcode-server --test provider_usage_domain -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc -- --nocapture
```

Expected: all pass.

- [ ] **Step 3: Run broader package and repository checks**

Run:

```bash
vp test run --project unit packages/contracts apps/web
cargo test -p bibcode-server
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: all commands exit zero. If workspace dependencies are absent, run `vp install --frozen-lockfile` once and repeat the Vite+ commands; report any external installation failure exactly.

- [ ] **Step 4: Perform security and scope inspection**

Run:

```bash
rg -n "CLAUDE_OAUTH_TOKEN_URL|refresh_claude_oauth_credentials|write_claude_keychain_credentials|claude_keychain_write_command|persist_and_replace_with" apps/server/src/provider_usage
rg -n "DEBUG-|accessToken|refreshToken" apps/server/src/provider_usage apps/web/src/components/status-bar apps/web/src/components/settings
git diff --check
git diff --stat
git status --short
```

Expected: the removed writer symbols have no matches; credential field names may remain only in bounded parsing/tests, never logs or command arguments; no debug instrumentation; no Orca paths in the diff.

- [ ] **Step 5: Review the final diff against every success criterion**

Confirm from source and test output:

1. every forced refresh rereads local Claude credentials;
2. provider usage contains no credential write or OAuth refresh path;
3. manual refresh bypasses the 30-second throttle and does not join background work;
4. successful Claude re-enable refreshes usage after settings persistence/probing;
5. provider inventory authentication remains independent from usage errors;
6. only BiBCode files changed and no AI Provider Account code changed.

- [ ] **Step 6: Commit documentation and any final test-only adjustments**

```bash
git add docs/providers/claude.md docs/architecture/providers.md docs/architecture/rpc-and-orchestration.md
git commit -m "docs: define local Claude credential ownership"
```

- [ ] **Step 7: Re-run final proof after the last commit**

Run:

```bash
vp check
vp run typecheck
cargo fmt --all --check
cargo test -p bibcode-server
cargo clippy -p bibcode-server --all-targets -- -D warnings
git status --short
```

Expected: every check exits zero and the worktree is clean.
