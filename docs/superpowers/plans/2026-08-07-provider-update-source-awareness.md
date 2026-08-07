# Source-Aware Provider Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenCode, Codex, Claude, and Cursor update checks and actions follow the installation that owns each resolved provider executable on Windows, macOS, Linux, and WSL.

**Architecture:** Keep update scheduling, caching, execution, and publication in the Rust server, but split version-source/parsing policy and installation-source classification into focused child modules. Capabilities carry a closed latest-version source, comparison scheme, displayed command, and separately executable allowlisted action; the existing RPC advisory shape remains unchanged.

**Tech Stack:** Rust 2024, Tokio, reqwest streaming responses, serde/serde_json, semver, Axum HTTP fixtures, React/Vitest behavioral verification, Vite+ workspace commands.

## Global Constraints

- Do not add a production Node.js runtime, desktop helper, dependency, persisted setting, RPC method, or public schema field.
- Do not execute fetched installer content, interpolated shell strings, `sudo`, `apt`, `dnf`, or `apk`.
- Latest-version URLs and parsers must be closed Rust enums with compile-time production endpoints.
- HTTP checks retain a four-second timeout, enforce a 256 KiB response-body limit, cache only successful results for one hour, and retry failures on the next probe.
- Manual refresh must advance every latest-source generation; checks for the same source/generation remain single-flight while different sources remain concurrent.
- Resolved and canonical executable paths outrank the configured command name; an unrecognized resolved path must never fall back to npm.
- Privileged Linux package commands may populate `updateCommand`, but `canUpdate` must remain `false` and `server.updateProvider` must reject them.
- Unknown/custom installations expose no latest source, no displayed command, and no executable action.
- Provider inventory/readiness data must survive source-discovery, network, decoding, and update failures unchanged.
- Every production behavior change follows RED-GREEN-REFACTOR and receives a focused test that was observed failing for the intended reason.

---

## File Structure

- Create `apps/server/src/production/provider_maintenance/latest.rs`: closed latest-version source identities, response parsing, semantic/Cursor comparison, and version-advance decisions.
- Create `apps/server/src/production/provider_maintenance/source.rs`: provider installation classification, Claude local channel/repository discovery, displayed commands, and executable actions.
- Modify `apps/server/src/production/provider_maintenance.rs`: maintenance state, bounded HTTP fetching, source-keyed cache/single-flight behavior, snapshot enrichment, and command execution integration.
- Modify `apps/server/src/production/control.rs`: capture the pre-update installed version, force post-command metadata refresh, and compute truthful final update state.
- Modify `apps/server/tests/production_control.rs`: exercise a recognized Cursor installation whose updater advances its installed version.
- Modify `docs/architecture/providers.md`: document source-aware maintenance ownership and failure guarantees.
- Modify `docs/providers/opencode.md`, `docs/providers/codex.md`, `docs/providers/claude.md`, and `docs/providers/cursor.md`: document supported update sources, channels, commands, and manual-only boundaries.
- Verify existing web behavior in `apps/web/src/components/ProviderUpdateLaunchNotification.logic.test.ts`, `apps/web/src/components/settings/providerStatus.test.ts`, and `apps/web/src/components/settings/ProviderInstanceCard.test.tsx`; no web production edit is expected because the existing contract already separates `updateCommand` from `canUpdate`.

---

### Task 1: Provider Version Schemes and Response Parsers

**Files:**
- Create: `apps/server/src/production/provider_maintenance/latest.rs`
- Modify: `apps/server/src/production/provider_maintenance.rs:1392-1411`

**Interfaces:**
- Consumes: provider-reported version strings and bounded HTTP response bytes.
- Produces: `LatestVersionSource`, `VersionScheme`, `advisory_status`, `version_advanced`, and `parse_latest_response` for later source resolution and fetching tasks.

- [ ] **Step 1: Write failing parser and comparison tests**

Create the child module with a `#[cfg(test)]` section first. Use hand-derived literals so these mutations fail: treating Cursor as semver, ordering same-day hashes lexically, accepting inconsistent installer identifiers, or accepting a downgrade.

```rust
#[test]
fn compares_cursor_release_dates_without_ordering_same_day_builds() {
    assert_eq!(
        advisory_status(
            VersionScheme::CursorRelease,
            Some("2026.06.19-20-24-33-653a7fb"),
            Some("2026.08.04-aaa8809"),
        ),
        "behind_latest"
    );
    assert_eq!(
        advisory_status(
            VersionScheme::CursorRelease,
            Some("2026.08.04-aaaa"),
            Some("2026.08.04-bbbb"),
        ),
        "unknown"
    );
    assert!(!version_advanced(
        VersionScheme::CursorRelease,
        Some("2026.08.04-aaaa"),
        Some("2026.08.04-bbbb"),
    ));
}

#[test]
fn parses_matching_cursor_installer_release_identifiers() {
    let script = br#"DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.08.04-aaa8809/${OS}/${ARCH}/agent-cli-package.tar.gz"
FINAL_DIR="$HOME/.local/share/cursor-agent/versions/2026.08.04-aaa8809""#;
    assert_eq!(
        parse_latest_response(LatestVersionSource::CursorInstaller, script),
        Ok("2026.08.04-aaa8809".to_owned())
    );
}

#[test]
fn rejects_mismatched_cursor_installer_release_identifiers() {
    let script = br#"DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.08.04-aaa8809/${OS}/${ARCH}/agent-cli-package.tar.gz"
FINAL_DIR="$HOME/.local/share/cursor-agent/versions/2026.08.05-bbb9910""#;
    assert_eq!(
        parse_latest_response(LatestVersionSource::CursorInstaller, script),
        Err(LatestVersionFailure::InvalidVersion)
    );
}

#[test]
fn parses_npm_and_claude_channel_responses() {
    assert_eq!(
        parse_latest_response(
            LatestVersionSource::Npm("@openai/codex"),
            br#"{"version":"0.148.0"}"#,
        ),
        Ok("0.148.0".to_owned())
    );
    assert_eq!(
        parse_latest_response(
            LatestVersionSource::Claude(ClaudeReleaseChannel::Stable),
            b"2.1.220\n",
        ),
        Ok("2.1.220".to_owned())
    );
}
```

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::latest::tests -- --nocapture
```

Expected: compilation fails because the source identities, parsers, and comparison functions do not exist yet.

- [ ] **Step 3: Implement the closed source and comparison model**

Add `mod latest;` to the parent and implement these exact public-to-parent types:

```rust
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum ClaudeReleaseChannel {
    Stable,
    Latest,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum LatestVersionSource {
    Npm(&'static str),
    Claude(ClaudeReleaseChannel),
    CursorInstaller,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum VersionScheme {
    Semver,
    CursorRelease,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum LatestVersionFailure {
    InvalidUrl,
    Request,
    HttpStatus,
    ResponseTooLarge,
    InvalidUtf8,
    InvalidJson,
    MissingVersion,
    InvalidVersion,
}
```

`parse_latest_response` must validate a semantic version for npm/Claude after trimming. For Cursor, scan only `DOWNLOAD_URL=` and `FINAL_DIR=` lines, extract the identifier following `/lab/` and `/versions/`, require both identifiers, require equality, and validate the identifier by parsing three numeric date components plus a non-empty suffix. Do not add a regex dependency.

Implement `advisory_status` so semantic versions preserve the current behavior and Cursor dates use this table:

```rust
match compare_versions(scheme, current, latest) {
    Some(std::cmp::Ordering::Less) => "behind_latest",
    Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater) => "current",
    None => "unknown",
}
```

Implement `version_advanced` as `matches!(compare_versions(scheme, before, after), Some(Ordering::Less))`.

- [ ] **Step 4: Route the existing semantic advisory through the new module**

Replace the parent `parse_version` and `advisory_status` bodies with imports from `latest`. Keep all existing semantic advisory call sites on `VersionScheme::Semver` so this task does not change exposed provider behavior.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::latest::tests -- --nocapture
cargo test -p bibcode-server --lib production::provider_maintenance::tests::compares_release_and_prerelease_versions -- --nocapture
```

Expected: all selected tests pass with no warnings.

- [ ] **Step 6: Commit the version model**

```bash
git add apps/server/src/production/provider_maintenance.rs apps/server/src/production/provider_maintenance/latest.rs
git commit -m "refactor(server): model provider release versions"
```

---

### Task 2: Source-Keyed, Bounded Latest-Version Fetching

**Files:**
- Modify: `apps/server/src/production/provider_maintenance.rs:777-1329`
- Test: `apps/server/src/production/provider_maintenance.rs:200-560`

**Interfaces:**
- Consumes: `LatestVersionSource` and `parse_latest_response` from Task 1.
- Produces: a cache and fetcher keyed by complete source identity, plus injectable test endpoints used by later provider-classification tasks.

- [ ] **Step 1: Write failing HTTP fixture tests**

Add one Axum fixture with these literal routes and counters. Register the npm
handler as a wildcard because Axum decodes the percent-encoded slash in a
scoped package before route matching:

```rust
.route("/claude/stable", get(|| async { "2.1.220\n" }))
.route("/claude/latest", get(|| async { "2.1.224\n" }))
.route("/cursor/install", get(|| async {
    "DOWNLOAD_URL=\"https://downloads.cursor.com/lab/2026.08.04-aaa8809/${OS}/${ARCH}/agent-cli-package.tar.gz\"\nFINAL_DIR=\"$HOME/.local/share/cursor-agent/versions/2026.08.04-aaa8809\""
}))
.route("/{*path}", get(|| async { Json(json!({ "version": "0.148.0" })) }))
```

Add tests named:

```rust
#[tokio::test]
async fn caches_claude_stable_and_latest_as_distinct_sources() { }

#[tokio::test]
async fn fetches_and_parses_cursor_installer_metadata() { }

#[tokio::test]
async fn rejects_latest_version_responses_larger_than_256_kib() { }
```

The first test must request both Claude channels twice and assert one request per channel. The second must assert the exact Cursor identifier. The third must serve `256 * 1024 + 1` bytes and assert `LatestVersionCheck::Failed` without a cache entry.

- [ ] **Step 2: Run the HTTP tests and verify RED**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::tests::caches_claude_stable_and_latest_as_distinct_sources -- --nocapture
cargo test -p bibcode-server --lib production::provider_maintenance::tests::fetches_and_parses_cursor_installer_metadata -- --nocapture
cargo test -p bibcode-server --lib production::provider_maintenance::tests::rejects_latest_version_responses_larger_than_256_kib -- --nocapture
```

Expected: compilation fails because maintenance still accepts only npm package names and has no endpoint bundle.

- [ ] **Step 3: Replace package-name cache keys with source identities**

Introduce:

```rust
const LATEST_RESPONSE_LIMIT: usize = 256 * 1024;

#[derive(Clone, Debug)]
struct LatestVersionEndpoints {
    npm_registry_base_url: Url,
    claude_release_base_url: Url,
    cursor_installer_url: Url,
}
```

Production defaults are exactly:

```text
https://registry.npmjs.org/
https://downloads.claude.ai/claude-code-releases/
https://cursor.com/install
```

Change `latest_versions` and `latest_version_locks` to use `LatestVersionSource` keys. Replace the test-only registry constructor with `with_version_endpoints`, while keeping `with_registry_base_url` as a thin npm-only convenience for existing tests.

- [ ] **Step 4: Implement bounded streaming fetches**

Build the request URL by matching the closed source enum. For npm, percent-encode the package and append `/latest`; for Claude append `stable` or `latest`; for Cursor clone the exact installer URL.

Read the response through `bytes_stream()` and stop before appending a chunk that would exceed `LATEST_RESPONSE_LIMIT`:

```rust
let mut body = Vec::new();
let mut stream = response.bytes_stream();
while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(|_| LatestVersionFailure::Request)?;
    if body.len().saturating_add(chunk.len()) > LATEST_RESPONSE_LIMIT {
        return Err(LatestVersionFailure::ResponseTooLarge);
    }
    body.extend_from_slice(&chunk);
}
parse_latest_response(source, &body)
```

Keep the four-second request timeout, successful-only cache insertion,
generation check, per-source lock, and warning log. Log a stable source label,
not provider environment values or full local paths.

- [ ] **Step 5: Run source fetch tests and the existing reliability suite**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::tests -- --nocapture
```

Expected: all provider-maintenance tests pass, including manual refresh, retry-after-failure, cache expiry, same-source single-flight, and cross-source concurrency.

- [ ] **Step 6: Commit bounded multi-source fetching**

```bash
git add apps/server/src/production/provider_maintenance.rs apps/server/src/production/provider_maintenance/latest.rs
git commit -m "feat(server): fetch provider release metadata by source"
```

---

### Task 3: Fail-Closed OpenCode and Codex Installation Classification

**Files:**
- Create: `apps/server/src/production/provider_maintenance/source.rs`
- Modify: `apps/server/src/production/provider_maintenance.rs:713-742,1100-1245,1334-1563`
- Test: `apps/server/src/production/provider_maintenance.rs:20-190`

**Interfaces:**
- Consumes: `LatestVersionSource`, `VersionScheme`, `ProviderMaintenanceTarget`, resolved path, and canonical path.
- Produces: `ProviderMaintenanceCapabilities { latest, version_scheme, display_command, update }` and re-exported `ProviderUpdateCommand` for the control layer.

- [ ] **Step 1: Replace the mapping audit with failing literal expectations**

Change the existing table-driven path test so it includes and asserts these breaks:

```rust
(
    "codex",
    "codex",
    Some("/home/me/.local/bin/codex"),
    Some("/home/me/.codex/packages/standalone/current/bin/codex"),
    Some("/home/me/.local/bin/codex update"),
),
(
    "codex",
    "codex",
    Some("C:/Users/me/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe"),
    None,
    Some("C:/Users/me/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe update"),
),
(
    "codex",
    "codex",
    Some("/opt/homebrew/bin/codex"),
    Some("/opt/homebrew/Caskroom/codex/0.148.0/codex"),
    Some("brew upgrade --cask codex"),
),
(
    "codex",
    "codex",
    Some("/srv/tools/codex"),
    None,
    None,
),
```

Add a request-count test proving an enabled installed Codex custom wrapper has
`status: "unknown"`, `updateCommand: null`, `canUpdate: false`, and performs
zero HTTP requests. Retain existing OpenCode Windows npm, native, and Homebrew
cases.

- [ ] **Step 2: Run the classifier tests and verify RED**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::tests::resolves_cross_platform_installation_sources -- --nocapture
cargo test -p bibcode-server --lib production::provider_maintenance::tests::unknown_custom_installations_do_not_check_npm -- --nocapture
```

Expected: standalone Codex selects npm, the custom bare command selects npm, and the new zero-request assertion fails.

- [ ] **Step 3: Implement the capability shape and closed command constructors**

In `source.rs`, define:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderUpdateCommand {
    pub(crate) display: String,
    pub(crate) executable: String,
    pub(crate) args: Vec<String>,
    pub(crate) lock_key: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderMaintenanceCapabilities {
    pub(crate) latest: Option<LatestVersionSource>,
    pub(crate) version_scheme: VersionScheme,
    pub(crate) display_command: Option<String>,
    pub(crate) update: Option<ProviderUpdateCommand>,
}
```

Use one constructor for executable actions that derives `display_command` from
the executable/argument vector, one constructor for display-only commands, and
`ProviderMaintenanceCapabilities::unknown()` with no latest source or command.
Re-export the two types from the parent module so `control.rs` keeps its current
import boundary.

- [ ] **Step 4: Implement exact OpenCode and Codex source rules**

Classify package-manager paths from resolved and canonical paths. A path is
Homebrew only when its canonical target contains `/cellar/` or `/caskroom/`;
`/opt/homebrew/bin` or `/usr/local/bin` alone is insufficient.

Codex standalone is recognized only when the canonical target contains
`/.codex/packages/standalone/` or the resolved Windows path contains
`/appdata/local/programs/openai/codex/bin/`. Its action invokes the resolved
binary with `update` and lock key `codex-standalone`.

Keep these source/action pairs exact:

```text
OpenCode native -> npm opencode-ai -> <resolved> upgrade -> opencode-native
Codex standalone -> npm @openai/codex -> <resolved> update -> codex-standalone
Vite+ -> npm provider package -> vp i -g <package> -> vite-plus
Bun -> npm provider package -> bun i -g <package>@latest -> bun
pnpm -> npm provider package -> pnpm add -g <package>@latest -> pnpm
npm -> npm provider package -> npm install -g <package>@latest -> npm
OpenCode Homebrew -> npm opencode-ai -> brew upgrade anomalyco/tap/opencode -> homebrew
Codex Homebrew -> npm @openai/codex -> brew upgrade --cask codex -> homebrew
```

When a resolved path exists and no exact rule matches, return unknown. Remove
the bare-command npm fallback completely.

- [ ] **Step 5: Integrate source capabilities into snapshot enrichment**

Resolve capabilities asynchronously as today, then fetch only
`capabilities.latest`. Compute status with `capabilities.version_scheme`. Encode
the advisory using:

```rust
"updateCommand": capabilities.display_command,
"canUpdate": capabilities.update.is_some(),
```

Checks-disabled and unknown-source snapshots remain unexplained `unknown`
advisories. Recognized-source lookup failures keep the existing visible retry
message.

- [ ] **Step 6: Run classifier, enrichment, and command tests**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::tests -- --nocapture
```

Expected: all tests pass and the former custom-wrapper npm expectation is gone.

- [ ] **Step 7: Commit fail-closed source classification**

```bash
git add apps/server/src/production/provider_maintenance.rs apps/server/src/production/provider_maintenance/source.rs
git commit -m "fix(server): match Codex and OpenCode update sources"
```

---

### Task 4: Claude Channels, WinGet, Homebrew, and Manual Linux Packages

**Files:**
- Modify: `apps/server/src/production/provider_maintenance/source.rs`
- Modify: `apps/server/src/production/provider_maintenance.rs`

**Interfaces:**
- Consumes: provider `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE`, direct environment values, resolved/canonical paths, and bounded local settings/repository files.
- Produces: Claude source hints and capabilities for native stable/latest, npm-family, both Homebrew casks, WinGet, apt, dnf, apk, and unknown paths.

- [ ] **Step 1: Write failing pure channel and repository parser tests**

Add literal tests for:

```rust
#[test]
fn managed_claude_channel_overrides_user_channel() {
    let hints = claude_hints_from_documents(
        Some(br#"{"autoUpdatesChannel":"latest"}"#),
        [br#"{"autoUpdatesChannel":"stable"}"#.as_slice()],
    );
    assert_eq!(hints.channel, Some(ClaudeReleaseChannel::Stable));
}

#[test]
fn claude_disable_updates_removes_only_the_executable_action() {
    let hints = ClaudeSourceHints {
        channel: Some(ClaudeReleaseChannel::Latest),
        updates_disabled: true,
        linux_package: None,
        invalid_managed_channel: false,
    };
    let capabilities = capabilities_for_paths_with_claude_hints(
        "claudeAgent",
        "claude",
        Some(Path::new("/home/me/.local/bin/claude")),
        Some(Path::new("/home/me/.local/share/claude/versions/2.1.224")),
        &hints,
    );
    assert_eq!(capabilities.latest, Some(LatestVersionSource::Claude(ClaudeReleaseChannel::Latest)));
    assert_eq!(capabilities.display_command, Some("/home/me/.local/bin/claude update".to_owned()));
    assert!(capabilities.update.is_none());
}

#[test]
fn parses_claude_linux_repository_channels() {
    assert_eq!(
        parse_claude_repository_marker(
            "deb https://downloads.claude.ai/claude-code/apt/stable stable main"
        ),
        Some((LinuxPackageManager::Apt, ClaudeReleaseChannel::Stable))
    );
    assert_eq!(
        parse_claude_repository_marker(
            "baseurl=https://downloads.claude.ai/claude-code/rpm/latest"
        ),
        Some((LinuxPackageManager::Dnf, ClaudeReleaseChannel::Latest))
    );
}
```

Add path table cases for native Windows, `claude-code` and
`claude-code@latest` Caskroom targets, WinGet link/package paths, marked
`/usr/bin/claude`, and an unmarked `/usr/bin/claude` that must be unknown.
Add a `#[cfg(windows)]` async command test that creates `winget.cmd` and
`npm.cmd` in a temporary target `PATH`, runs each selected action through the
real provider update runner, and asserts exit code zero plus the literal
arguments captured by the shims. This catches a regression that bypasses the
existing `.cmd` launch wrapper.

- [ ] **Step 2: Run Claude tests and verify RED**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::source::tests::managed_claude_channel_overrides_user_channel -- --nocapture
cargo test -p bibcode-server --lib production::provider_maintenance::source::tests::resolves_claude_installation_sources -- --nocapture
```

Expected: compilation fails because Claude source hints and source-specific capabilities do not exist.

- [ ] **Step 3: Implement bounded local Claude settings discovery**

Read no more than 64 KiB from each settings or repository file. Resolve the
provider configuration directory from `CLAUDE_CONFIG_DIR`, otherwise
`HOME/.claude` or `USERPROFILE/.claude`, with target environment values
overriding ambient values.

Read user `settings.json` plus file-managed settings at:

```text
macOS: /Library/Application Support/ClaudeCode/managed-settings.json
Linux/WSL: /etc/claude-code/managed-settings.json
Windows: %ProgramFiles%/ClaudeCode/managed-settings.json
```

Also read sorted `*.json` entries in the adjacent `managed-settings.d`
directory. Merge only the scalar `autoUpdatesChannel` and the
`env.DISABLE_UPDATES` value, with later managed files overriding earlier files
and managed values overriding user values. Accept only `stable` and `latest`;
an invalid managed channel sets `invalid_managed_channel`.

Direct provider environment `DISABLE_UPDATES=1` also disables execution.
`DISABLE_AUTOUPDATER` must not disable the explicit action.

- [ ] **Step 4: Implement Claude repository marker discovery**

For a Claude executable resolved under `/usr/bin`, read the standard files
below and accept a source only when one contains an exact Anthropic repository
URL with one unambiguous channel:

```text
/etc/apt/sources.list.d/claude-code.list
/etc/yum.repos.d/claude-code.repo
/etc/apk/repositories
```

Conflicting stable/latest markers or an absent marker produce unknown source.

- [ ] **Step 5: Implement source-specific Claude capabilities**

Use these exact actions and source channels:

```text
native -> configured stable/latest -> <resolved> update -> claude-native
Homebrew Caskroom/claude-code -> stable -> brew upgrade --cask claude-code -> homebrew
Homebrew Caskroom/claude-code@latest -> latest -> brew upgrade --cask claude-code@latest -> homebrew
WinGet -> latest -> winget upgrade Anthropic.ClaudeCode -> winget
apt -> marked channel -> display sudo apt update && sudo apt upgrade claude-code -> no executable action
dnf -> marked channel -> display sudo dnf upgrade claude-code -> no executable action
apk -> marked channel -> display apk update && apk upgrade claude-code -> no executable action
```

Run package-manager path detection before native user-local detection only when
the canonical path proves npm/pnpm/Bun/Vite+ ownership. For an invalid managed
channel, retain the native displayed/action command but set no latest source so
BiBCode cannot claim a release channel.

- [ ] **Step 6: Run all Claude and maintenance tests**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::source::tests -- --nocapture
cargo test -p bibcode-server --lib production::provider_maintenance::tests -- --nocapture
```

Expected: all tests pass; stable/latest HTTP counters remain isolated; manual
commands have `canUpdate: false`; on Windows, npm and WinGet shims receive the
exact allowlisted arguments.

- [ ] **Step 7: Commit Claude source awareness**

```bash
git add apps/server/src/production/provider_maintenance.rs apps/server/src/production/provider_maintenance/source.rs
git commit -m "fix(server): respect Claude installation channels"
```

---

### Task 5: Cursor Release Detection and Safe Native Action

**Files:**
- Modify: `apps/server/src/production/provider_maintenance/source.rs`
- Modify: `apps/server/src/production/provider_maintenance.rs`
- Test: `apps/server/src/production/provider_maintenance.rs`

**Interfaces:**
- Consumes: `LatestVersionSource::CursorInstaller` and `VersionScheme::CursorRelease` from Tasks 1-2.
- Produces: recognized official Cursor capabilities and ordinary `behind_latest` snapshots that the existing web candidate logic already understands.

- [ ] **Step 1: Write failing Cursor source and advisory tests**

Add these cases:

```rust
#[test]
fn recognizes_only_official_cursor_release_paths() {
    let official = capabilities_for_paths(
        "cursor",
        "cursor-agent",
        Some(Path::new("/home/me/.local/bin/cursor-agent")),
        Some(Path::new("/home/me/.local/share/cursor-agent/versions/2026.06.19-653a7fb/cursor-agent")),
    );
    assert_eq!(official.latest, Some(LatestVersionSource::CursorInstaller));
    assert_eq!(official.version_scheme, VersionScheme::CursorRelease);
    assert_eq!(official.display_command.as_deref(), Some("/home/me/.local/bin/cursor-agent update"));
    assert!(official.update.is_some());

    let wrapper = capabilities_for_paths(
        "cursor",
        "cursor-agent",
        Some(Path::new("/srv/tools/cursor-agent")),
        None,
    );
    assert_eq!(wrapper, ProviderMaintenanceCapabilities::unknown());
}
```

Add an async enrichment test with installed
`2026.06.19-20-24-33-653a7fb` and fixture latest
`2026.08.04-aaa8809`; assert `behind_latest`, exact latest version, resolved
update command, and `canUpdate: true`.

- [ ] **Step 2: Run Cursor tests and verify RED**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::source::tests::recognizes_only_official_cursor_release_paths -- --nocapture
cargo test -p bibcode-server --lib production::provider_maintenance::tests::enriches_cursor_snapshot_from_installer_metadata -- --nocapture
```

Expected: the official path has no latest source and the wrapper is incorrectly executable.

- [ ] **Step 3: Implement exact Cursor path capabilities**

Recognize Cursor only when the canonical path contains
`/.local/share/cursor-agent/versions/` and ends in `/cursor-agent` or
`/cursor-agent.exe`. Also accept the exact resolved `/.local/bin/cursor-agent`
launch link when its canonical target has that release-tree identity. The
action invokes the resolved binary with `update` and lock key `cursor-agent`.

All other Cursor paths return unknown instead of exposing the configured binary
as an updater.

- [ ] **Step 4: Verify the existing web behavior without changing production UI**

Run:

```bash
vp test run apps/web/src/components/ProviderUpdateLaunchNotification.logic.test.ts apps/web/src/components/settings/providerStatus.test.ts apps/web/src/components/settings/ProviderInstanceCard.test.tsx
```

Expected: all tests pass. The existing suites already prove that a
`behind_latest` provider becomes a candidate, `canUpdate: false` disables
one-click execution, and a command remains copyable when no run handler exists.

- [ ] **Step 5: Run the complete maintenance suite and commit**

Run:

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::tests -- --nocapture
```

Then commit:

```bash
git add apps/server/src/production/provider_maintenance.rs apps/server/src/production/provider_maintenance/source.rs
git commit -m "fix(server): detect Cursor CLI releases"
```

---

### Task 6: Post-Update Version-Advance Verification

**Files:**
- Modify: `apps/server/src/production/control.rs:89-97,598-790,1960-1990`
- Modify: `apps/server/tests/production_control.rs:1010-1060`

**Interfaces:**
- Consumes: `latest::version_advanced`, the provider driver, the pre-command installed version, and the refreshed provider snapshot.
- Produces: `succeeded` only for a current advisory or a provably advanced installed version; unchanged/downgrade/ambiguous results remain `unchanged`.

- [ ] **Step 1: Write failing post-update outcome tests**

Replace the current status-only unit test with literal snapshots containing
driver and version. Cover:

```rust
assert_eq!(
    post_update_status(&[cursor_unknown("2026.08.04-aaa8809")], "cursor", Some("2026.06.19-653a7fb")),
    "succeeded"
);
assert_eq!(
    post_update_status(&[cursor_unknown("2026.08.04-bbbb")], "cursor", Some("2026.08.04-aaaa")),
    "unchanged"
);
assert_eq!(
    post_update_status(&[codex_unknown("0.146.0")], "codex", Some("0.147.0")),
    "unchanged"
);
```

Keep cases proving an advisory `current` succeeds, `behind_latest` remains
unchanged even if the version changed, an absent target remains unchanged, and
an unchanged semantic version remains unchanged.

- [ ] **Step 2: Change the Cursor integration fixture to advance its version**

Place the fixture executable under a temporary official-looking canonical tree:

```text
<temp>/.local/share/cursor-agent/versions/2026.06.19-653a7fb/cursor-agent
```

Give it a version-state file. `about` reads and emits that file as
`{"cliVersion":"<value>"}`; `update` writes
`2026.08.04-aaa8809`. Configure checks off so the test specifically exercises
the before/after fallback without external HTTP. Rename the integration test to
`provider_update_succeeds_when_cursor_installed_version_advances` and expect:

```rust
assert_eq!(provider["version"], "2026.08.04-aaa8809");
assert_eq!(provider["updateState"]["status"], "succeeded");
assert_eq!(provider["updateState"]["message"], "Provider updated.");
```

- [ ] **Step 3: Run unit and integration tests and verify RED**

Run:

```bash
cargo test -p bibcode-server --lib production::control::tests::post_update_verification_distinguishes_success_and_unchanged -- --nocapture
cargo test -p bibcode-server --test production_control provider_update_succeeds_when_cursor_installed_version_advances -- --nocapture
```

Expected: unknown advisories remain unchanged and the renamed integration test does not yet report success.

- [ ] **Step 4: Implement pre-version capture and version-advance fallback**

Before publishing `running`, read the target instance's current published
version into an owned `Option<String>`. After a zero exit, call
`begin_latest_version_refresh()` before the target refresh.

Change `post_update_status` to:

```rust
fn post_update_status(
    providers: &[Value],
    instance_id: &str,
    before_version: Option<&str>,
) -> &'static str {
    let Some(provider) = providers
        .iter()
        .find(|provider| provider["instanceId"] == instance_id)
    else {
        return "unchanged";
    };
    match provider["versionAdvisory"]["status"].as_str() {
        Some("current") => "succeeded",
        Some("behind_latest") => "unchanged",
        _ => {
            let driver = provider["driver"].as_str().unwrap_or_default();
            let after_version = provider["version"].as_str();
            if provider_version_advanced(driver, before_version, after_version) {
                "succeeded"
            } else {
                "unchanged"
            }
        }
    }
}
```

Expose a parent-level `provider_version_advanced(driver, before, after)` that
selects `CursorRelease` for Cursor and `Semver` for the other maintained
providers, then delegates to Task 1's `version_advanced`.

Keep the current output/error handling. Use `Provider updated.` for either
success path; distinguish still-behind from unverifiable unchanged exactly as
the current messages do.

- [ ] **Step 5: Run control and production integration tests and verify GREEN**

Run:

```bash
cargo test -p bibcode-server --lib production::control::tests -- --nocapture
cargo test -p bibcode-server --test production_control -- --nocapture
```

Expected: all tests pass, including same-instance locking, cancellation, output bounds, scheduler behavior, and advanced Cursor success.

- [ ] **Step 6: Commit truthful update verification**

```bash
git add apps/server/src/production/control.rs apps/server/tests/production_control.rs
git commit -m "fix(server): verify provider version advancement"
```

---

### Task 7: Living Documentation and Complete Verification

**Files:**
- Modify: `docs/architecture/providers.md:44-75`
- Modify: `docs/providers/opencode.md`
- Modify: `docs/providers/codex.md`
- Modify: `docs/providers/claude.md`
- Modify: `docs/providers/cursor.md`

**Interfaces:**
- Consumes: the implemented source/action matrix and observed validation results.
- Produces: current living documentation and final repository evidence.

- [ ] **Step 1: Update provider maintenance architecture documentation**

Document that the resolved/canonical executable determines both latest source
and updater, cache keys include source/channel, fetched scripts are parsed only,
manual commands are non-executable, custom paths fail closed, and successful
updates require current metadata or a provable installed-version advance.

- [ ] **Step 2: Update provider-specific setup pages**

Record the implemented rows from the design matrix. Claude documentation must
name native stable/latest, both Homebrew casks, WinGet, display-only
apt/dnf/apk commands, `DISABLE_UPDATES`, and the managed-channel limitation.
Cursor documentation must state that official installer metadata is parsed and
custom wrappers remain manual-only. Codex must name standalone `codex update`
and Homebrew cask behavior. OpenCode must name native and package-manager
sources, including Windows npm shims.

- [ ] **Step 3: Run focused behavior suites**

```bash
cargo test -p bibcode-server --lib production::provider_maintenance::tests -- --nocapture
cargo test -p bibcode-server --lib production::control::tests -- --nocapture
cargo test -p bibcode-server --test production_control -- --nocapture
vp test run apps/web/src/components/ProviderUpdateLaunchNotification.logic.test.ts apps/web/src/components/settings/providerStatus.test.ts apps/web/src/components/settings/ProviderInstanceCard.test.tsx
```

Expected: every selected suite passes with pristine output.

- [ ] **Step 4: Run repository-required Rust and workspace gates**

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
cargo test -p bibcode-server --quiet
vp check
vp run typecheck
```

Expected: every command exits zero. If an unrelated pre-existing failure
appears, preserve its full command/output and prove the focused changed-path
suites still pass before reporting the residual failure.

- [ ] **Step 5: Review the final diff and worktree**

```bash
git diff --check
git diff --stat cb37110..HEAD
git status --short
```

Inspect every changed file for accidental generated data, debug output,
dependency drift, `.codegraph` changes, secret/path leakage, or missing living
documentation. The only uncommitted files at this point should be the Task 7
documentation edits.

- [ ] **Step 6: Commit living documentation**

```bash
git add docs/architecture/providers.md docs/providers/opencode.md docs/providers/codex.md docs/providers/claude.md docs/providers/cursor.md
git commit -m "docs: document provider update sources"
```

- [ ] **Step 7: Re-run final cleanliness checks**

```bash
git diff --check
git status --short
```

Expected: no output from either command.
