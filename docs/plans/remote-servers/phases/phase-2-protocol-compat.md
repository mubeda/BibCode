# Phase 2: Protocol Compatibility Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every BiBCode descriptor surface publishes a two-number protocol compatibility window, and the client runtime computes a `CompatVerdict` per environment that later phases (3, 4, 6, 7) consume.

**Architecture:** Additive, decode-defaulted fields `remoteProtocolVersion` / `minCompatibleRemoteProtocol` on `ExecutionEnvironmentDescriptor` (TS contract + all three Rust descriptor producers), constants `REMOTE_PROTOCOL_VERSION = 1` / `MIN_COMPATIBLE_REMOTE_PROTOCOL = 1` on both sides, a pure verdict function in a new `packages/client-runtime/src/connection/compat.ts`, and a per-environment `compatVerdictAtom` derived from the supervisor's prepared connection (the resolver already fetches the descriptor on every attempt).

**Tech Stack:** TypeScript (effect Schema, effect Atom), Rust (Axum server, serde), vite-plus (`vp test`), cargo.

**Spec:** `docs/plans/remote-servers/remote-servers-spec.md` §4.4 (normative names and shapes; this plan uses them verbatim). Master plan: `docs/plans/remote-servers/remote-servers-plan.md` (this file is Phase 2).

## Global Constraints

(Copied from the master plan; every task's requirements implicitly include this section.)

- Zero reference-product strings in code, identifiers, UI copy, or comments; product
  strings are "BiBCode"/"bibcode" by context (spec D16).
- `packages/contracts` stays schema-only; every new WS method gets a Rust mirror and an
  entry in the TS↔Rust parity manifests; every RPC method declares exactly one scope in
  `apps/server/src/auth/scope.rs`.
- All new descriptor/contract fields are additive and decode-defaulted so older servers
  keep working (no breaking wire changes).
- No production Node runtime, no Electron, no sidecars; desktop-privileged operations
  cross `DesktopBridge`; normal traffic uses typed HTTP/WS RPC.
- Preserve unrelated worktree changes — in particular the user's pending deletions under
  `docs/plans/2026-08-24-environment-project-management/` must never be restored or
  committed by this work.
- Every phase: focused tests for changed behavior, `vp check`, `vp run typecheck`; Rust
  phases additionally `cargo fmt --all --check`, relevant Rust tests, and Clippy for
  affected targets with warnings denied; final `git diff`/`git status --short` review.
- Living docs (`docs/architecture/remote.md`, `connection-runtime.md`, `overview.md`) and
  `docs/testing/` runbooks update in the same patch as the behavior they describe; phases
  that change no runbook-relevant behavior state "reviewed and remain accurate".

## Phase-specific notes for the implementer

- **This phase adds no WS methods**, so there is no parity-manifest entry to add. The
  TS↔Rust parity mechanism for two integer constants is *pinned literals on both sides*:
  the TS tests assert the constants equal `1` and the decode defaults equal `0`; the Rust
  tests assert every descriptor producer serializes `"remoteProtocolVersion": 1` and
  `"minCompatibleRemoteProtocol": 1` under exactly those camelCase keys. If either side
  bumps a value without the other, its pinned test fails.
- **The Rust descriptor is produced in three places** (verified against current source).
  All three must publish the window, sourcing the numbers from one shared pair of
  constants:
  1. `apps/server/src/http.rs` — `environment_descriptor` handler for the public
     `/.well-known/bibcode/environment` route (typed serde structs, ~line 262).
  2. `apps/server/src/production/control.rs` — `fn environment_descriptor` (~line 2139),
     which feeds `server.getConfig` (`config_snapshot`), the initial
     `subscribeServerConfig` snapshot, and lifecycle welcome/ready events.
  3. `apps/server/src/lifecycle.rs` — the BiBCode Connect descriptor `json!` literal
     (~line 270), embedded in relay link proofs and relay status.
- The desktop bridge command `desktop_bridge_fetch_environment_descriptor`
  (`apps/desktop/src-tauri/src/bridge.rs` ~line 1114) passes the descriptor JSON through
  as an untyped `serde_json::Value` — verified: no typed struct, no `deny_unknown_fields`
  — so **no desktop change is needed**.
- `Schema.withDecodingDefault` makes a field *required on the Type side*. Adding the two
  fields to `ExecutionEnvironmentDescriptor` breaks every TS object literal that
  constructs a descriptor value (mostly test fixtures). Task 1 includes the enumeration
  and fix step — do not skip it or `vp run typecheck` fails.
- Run all `vp` commands from the repository root. Rust tests run with
  `cargo test -p bibcode-server ...` (crate name verified in `apps/server/Cargo.toml`).

---

### Task 1: Contracts — window constants and descriptor fields (TypeScript)

**Files:**
- Modify: `packages/contracts/src/environment.ts` (constants + two fields on `ExecutionEnvironmentDescriptor`, currently lines 36–46)
- Test: `packages/contracts/src/environment.test.ts` (append to the existing `describe("execution environment contracts", ...)` block)
- Modify (fixture ripple, enumerated by typecheck in Step 5): known typed descriptor literals include
  `packages/client-runtime/src/connection/resolver.test.ts` (~line 45, `satisfies ExecutionEnvironmentDescriptor`),
  `packages/client-runtime/src/authorization/layer.test.ts`,
  `packages/client-runtime/src/environment/knownEnvironment.test.ts`,
  `apps/web/src/environments/primary/bootstrap.test.ts`,
  plus any `PreparedConnection`-shaped fixtures in
  `packages/client-runtime/src/connection/driver.test.ts`,
  `supervisor.test.ts`, `registry.test.ts`, and
  `packages/client-runtime/src/rpc/session.test.ts`

**Interfaces:**
- Consumes: existing `ExecutionEnvironmentDescriptor` schema and its decode-default style (`Schema.withDecodingDefault(Effect.succeed(...))`, see `storageInstanceId` in the same struct).
- Produces (spec §4.4 names, verbatim — Tasks 2–4 and Phases 3/4/6/7 rely on these):
  - `export const REMOTE_PROTOCOL_VERSION = 1` (from `packages/contracts/src/environment.ts`, re-exported by the `@bibcode/contracts` root barrel via the existing `export * from "./environment.ts"` in `packages/contracts/src/index.ts` — no barrel change needed)
  - `export const MIN_COMPATIBLE_REMOTE_PROTOCOL = 1`
  - `ExecutionEnvironmentDescriptor` gains `remoteProtocolVersion: number` and `minCompatibleRemoteProtocol: number`, both decode-defaulted to `0` (0 = "legacy, pre-window") and **wire-constrained to non-negative integers** (amended spec §4.4) via the existing `NonNegativeInt` from `packages/contracts/src/baseSchemas.ts` (`Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))` — the same constraint `orchestration.ts` uses for `sequence`/`sizeBytes`). A negative or fractional value fails decoding; the Rust mirror side uses `u32`, which cannot produce either.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("execution environment contracts", ...)` block of `packages/contracts/src/environment.test.ts` (this file's runner import is `vite-plus/test` — keep it), and extend the import from `./environment.ts`:

```ts
import {
  ExecutionEnvironmentDescriptor,
  MIN_COMPATIBLE_REMOTE_PROTOCOL,
  REMOTE_PROTOCOL_VERSION,
} from "./environment.ts";
```

```ts
  it("pins the remote protocol window constants", () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe(1);
    expect(MIN_COMPATIBLE_REMOTE_PROTOCOL).toBe(1);
  });

  it("defaults the protocol window to 0/0 for an old descriptor", () => {
    const decoded = decodeExecutionEnvironmentDescriptor({
      ...descriptor,
      capabilities: { repositoryIdentity: true },
    });

    expect(decoded.remoteProtocolVersion).toBe(0);
    expect(decoded.minCompatibleRemoteProtocol).toBe(0);
  });

  it("decodes an advertised protocol window", () => {
    const decoded = decodeExecutionEnvironmentDescriptor({
      ...descriptor,
      remoteProtocolVersion: 1,
      minCompatibleRemoteProtocol: 1,
      capabilities: { repositoryIdentity: true },
    });

    expect(decoded.remoteProtocolVersion).toBe(1);
    expect(decoded.minCompatibleRemoteProtocol).toBe(1);
  });

  it("rejects negative protocol window values", () => {
    for (const field of ["remoteProtocolVersion", "minCompatibleRemoteProtocol"] as const) {
      expect(() =>
        decodeExecutionEnvironmentDescriptor({
          ...descriptor,
          [field]: -1,
          capabilities: { repositoryIdentity: true },
        }),
      ).toThrow();
    }
  });

  it("rejects fractional protocol window values", () => {
    for (const field of ["remoteProtocolVersion", "minCompatibleRemoteProtocol"] as const) {
      expect(() =>
        decodeExecutionEnvironmentDescriptor({
          ...descriptor,
          [field]: 1.5,
          capabilities: { repositoryIdentity: true },
        }),
      ).toThrow();
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (repo root): `vp test run packages/contracts/src/environment.test.ts`
Expected: FAIL — `REMOTE_PROTOCOL_VERSION` has no exported member / decoded object lacks `remoteProtocolVersion`.

- [ ] **Step 3: Write the minimal implementation**

In `packages/contracts/src/environment.ts`, extend the `./baseSchemas.ts` import with `NonNegativeInt`, add the constants directly above `ExecutionEnvironmentDescriptor`, and add the two fields to the struct (after `storageInstanceId`, before `capabilities`), mirroring the existing decode-default style:

```ts
import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
```

```ts
export const REMOTE_PROTOCOL_VERSION = 1;
export const MIN_COMPATIBLE_REMOTE_PROTOCOL = 1;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  storageInstanceId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  remoteProtocolVersion: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  minCompatibleRemoteProtocol: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;
```

(`NonNegativeInt` already exists — `packages/contracts/src/baseSchemas.ts:16`, `export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));` — and is already consumed by `orchestration.ts`; do not define a second one.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/contracts/src/environment.test.ts`
Expected: PASS (all pre-existing descriptor tests in the file must also still pass — the fields are additive and decode-defaulted).

- [ ] **Step 5: Fix the typed-fixture ripple**

The two new fields are required on the Type side, so every TS literal built *as* an `ExecutionEnvironmentDescriptor` now fails typecheck. Enumerate:

Run: `rg -ln "satisfies ExecutionEnvironmentDescriptor" packages apps`
Run: `vp run typecheck` (the authoritative enumeration — fix every error it reports)

Fix rule: fixtures modeling a **current** server add `remoteProtocolVersion: 1, minCompatibleRemoteProtocol: 1`; fixtures deliberately modeling a **legacy/older** server add `remoteProtocolVersion: 0, minCompatibleRemoteProtocol: 0`. Example (the `satisfies ExecutionEnvironmentDescriptor` fixture in `packages/client-runtime/src/connection/resolver.test.ts`):

```ts
  serverVersion: "0.0.0-test",
  storageInstanceId: "store-current",
  remoteProtocolVersion: 1,
  minCompatibleRemoteProtocol: 1,
  capabilities: {
```

Untyped JSON payloads that go through `Schema.decodeUnknown*` need **no** change (defaults apply); only typed literals do.

- [ ] **Step 6: Run the full typecheck and the touched packages' tests**

Run: `vp run typecheck`
Expected: PASS with zero errors.
Run: `vp run --filter @bibcode/contracts test && vp run --filter @bibcode/client-runtime test`
Expected: PASS (each package's `test` script is `vp test run`).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/environment.ts packages/contracts/src/environment.test.ts
git add -u packages/client-runtime apps/web
git commit -m "feat(contracts): add remote protocol compatibility window to the environment descriptor"
```

---

### Task 2: Server — publish the window on every descriptor surface (Rust)

**Files:**
- Modify: `apps/server/src/http.rs` (constants next to `ENVIRONMENT_DESCRIPTOR_PATH` ~line 40; `EnvironmentDescriptor` struct + handler, lines 260–301)
- Modify: `apps/server/src/production/control.rs` (`fn environment_descriptor`, ~line 2139)
- Modify: `apps/server/src/lifecycle.rs` (Connect descriptor `json!`, ~line 270)
- Test: `apps/server/src/production/control.rs` (unit tests module, next to `environment_descriptor_advertises_complete_worktree_catalog_surface` ~line 4996)
- Test: `apps/server/tests/server_runtime.rs` (`binds_an_ephemeral_port_and_serves_the_environment_descriptor`, ~line 259)

**Interfaces:**
- Consumes: the wire keys pinned by Task 1 — `remoteProtocolVersion`, `minCompatibleRemoteProtocol`, both serialized as `1` by a current server.
- Produces: `pub(crate) const REMOTE_PROTOCOL_VERSION: u32 = 1` and `pub(crate) const MIN_COMPATIBLE_REMOTE_PROTOCOL: u32 = 1` in `apps/server/src/http.rs`, referenced by the other two producers as `crate::http::REMOTE_PROTOCOL_VERSION` / `crate::http::MIN_COMPATIBLE_REMOTE_PROTOCOL` (precedent: `apps/server/src/auth/http.rs` already imports `crate::http::AppState`).

- [ ] **Step 1: Write the failing Rust tests**

In the `#[cfg(test)] mod tests` of `apps/server/src/production/control.rs`, next to `environment_descriptor_advertises_complete_worktree_catalog_surface`, add:

```rust
    #[test]
    fn environment_descriptor_advertises_the_protocol_compatibility_window() {
        let temp = tempfile::tempdir().expect("state directory");
        let config = running_test_config(temp.path());
        let descriptor = environment_descriptor(&config, false);
        assert_eq!(descriptor["remoteProtocolVersion"], 1);
        assert_eq!(descriptor["minCompatibleRemoteProtocol"], 1);
    }
```

In `apps/server/tests/server_runtime.rs`, inside `binds_an_ephemeral_port_and_serves_the_environment_descriptor`, after the existing `assert_eq!(descriptor["capabilities"]["repositoryIdentity"], true);` line, add:

```rust
    assert_eq!(descriptor["remoteProtocolVersion"], 1);
    assert_eq!(descriptor["minCompatibleRemoteProtocol"], 1);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p bibcode-server --lib environment_descriptor_advertises_the_protocol_compatibility_window`
Expected: FAIL — `descriptor["remoteProtocolVersion"]` is `null`, not `1`.
Run: `cargo test -p bibcode-server --test server_runtime binds_an_ephemeral_port_and_serves_the_environment_descriptor`
Expected: FAIL on the new assertion.

- [ ] **Step 3: Write the minimal implementation (all three producers)**

`apps/server/src/http.rs` — constants next to the route path, and the two struct fields (serde is already `rename_all = "camelCase"`, so the snake_case field names serialize to the pinned wire keys):

```rust
pub const ENVIRONMENT_DESCRIPTOR_PATH: &str = "/.well-known/bibcode/environment";
pub(crate) const REMOTE_PROTOCOL_VERSION: u32 = 1;
pub(crate) const MIN_COMPATIBLE_REMOTE_PROTOCOL: u32 = 1;
```

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentDescriptor {
    environment_id: String,
    label: String,
    platform: PlatformDescriptor,
    server_version: String,
    storage_instance_id: String,
    remote_protocol_version: u32,
    min_compatible_remote_protocol: u32,
    capabilities: EnvironmentCapabilities,
}
```

and in the `environment_descriptor` handler:

```rust
        server_version: config.server_version.clone(),
        storage_instance_id: config
            .storage_instance_id
            .expect("a running server has a prepared persistent store")
            .to_string(),
        remote_protocol_version: REMOTE_PROTOCOL_VERSION,
        min_compatible_remote_protocol: MIN_COMPATIBLE_REMOTE_PROTOCOL,
        capabilities: EnvironmentCapabilities {
            repository_identity: true,
        },
```

`apps/server/src/production/control.rs` — in `fn environment_descriptor`, add the two keys to the `json!` map (fully qualified paths avoid import churn):

```rust
        "serverVersion": config.server_version,
        "storageInstanceId": config
            .storage_instance_id
            .expect("a running server has a prepared persistent store")
            .to_string(),
        "remoteProtocolVersion": crate::http::REMOTE_PROTOCOL_VERSION,
        "minCompatibleRemoteProtocol": crate::http::MIN_COMPATIBLE_REMOTE_PROTOCOL,
        "capabilities": {
```

`apps/server/src/lifecycle.rs` — the Connect descriptor `json!` literal (~line 270) gains the same two keys:

```rust
                let descriptor = serde_json::json!({
                    "environmentId": config.environment_id,
                    "label": config.environment_label,
                    "platform": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
                    "serverVersion": config.server_version,
                    "storageInstanceId": config
                        .storage_instance_id
                        .expect("a running server has a prepared persistent store")
                        .to_string(),
                    "remoteProtocolVersion": crate::http::REMOTE_PROTOCOL_VERSION,
                    "minCompatibleRemoteProtocol": crate::http::MIN_COMPATIBLE_REMOTE_PROTOCOL,
                    "capabilities": { "repositoryIdentity": true },
                });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bibcode-server --lib environment_descriptor`
Expected: PASS (the new window test plus the two pre-existing `environment_descriptor_*` tests).
Run: `cargo test -p bibcode-server --test server_runtime binds_an_ephemeral_port_and_serves_the_environment_descriptor`
Expected: PASS.

- [ ] **Step 5: Rust gate for the touched crate**

Run: `cargo fmt --all --check`
Expected: no diff.
Run: `cargo clippy -p bibcode-server --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/http.rs apps/server/src/production/control.rs apps/server/src/lifecycle.rs apps/server/tests/server_runtime.rs
git commit -m "feat(server): publish the remote protocol compatibility window on every descriptor surface"
```

---

### Task 3: `CompatVerdict` — verdict module in client-runtime

**Files:**
- Create: `packages/client-runtime/src/connection/compat.ts`
- Create: `packages/client-runtime/src/connection/compat.test.ts`
- Modify: `packages/client-runtime/src/connection/index.ts` (add `export * from "./compat.ts";` in alphabetical position, after the `./catalog.ts` export)

**Interfaces:**
- Consumes: `REMOTE_PROTOCOL_VERSION`, `MIN_COMPATIBLE_REMOTE_PROTOCOL`, `ExecutionEnvironmentDescriptor` from `@bibcode/contracts` (Task 1).
- Produces (spec §4.4, verbatim — Task 4 and Phases 3/4/6/7 rely on these exact names, importable from `@bibcode/client-runtime/connection`):
  - `type CompatVerdict = { kind: "compatible" } | { kind: "legacy" } | { kind: "server-too-old"; serverVersion: number; minSupported: number } | { kind: "client-too-old"; serverMinCompatible: number; clientVersion: number }`
  - `computeCompatVerdict(descriptor: Pick<ExecutionEnvironmentDescriptor, "remoteProtocolVersion" | "minCompatibleRemoteProtocol">): CompatVerdict`
- Evaluation order is normative: legacy (both fields 0) → server-too-old → client-too-old → compatible.
- Per amended spec §4.4 there is **no separate probe-failure cache**: failed descriptor probes are throttled by the supervisor's existing 1/2/4/8/16 s reconnection backoff (`packages/client-runtime/src/connection/supervisor.ts`), which this phase does not touch. Do not introduce a cache constant or caching logic.

- [ ] **Step 1: Write the failing tests**

Create `packages/client-runtime/src/connection/compat.test.ts` (runner style follows the neighboring `presentation.test.ts`: `@effect/vitest`):

```ts
import { describe, expect, it } from "@effect/vitest";

import { computeCompatVerdict } from "./compat.ts";

describe("protocol compatibility verdict", () => {
  it("reports a pre-window server (both fields 0) as legacy", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 0, minCompatibleRemoteProtocol: 0 }),
    ).toEqual({ kind: "legacy" });
  });

  it("reports the current window (1/1) as compatible", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 1, minCompatibleRemoteProtocol: 1 }),
    ).toEqual({ kind: "compatible" });
  });

  it("accepts a newer server that still supports this client's floor", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 5, minCompatibleRemoteProtocol: 1 }),
    ).toEqual({ kind: "compatible" });
  });

  it("accepts a server floor of 0 when the server version is inside the window", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 1, minCompatibleRemoteProtocol: 0 }),
    ).toEqual({ kind: "compatible" });
  });

  it("rejects a server below this client's floor as server-too-old", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 0, minCompatibleRemoteProtocol: 1 }),
    ).toEqual({ kind: "server-too-old", serverVersion: 0, minSupported: 1 });
  });

  it("rejects this client when it is below the server's floor as client-too-old", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 2, minCompatibleRemoteProtocol: 2 }),
    ).toEqual({ kind: "client-too-old", serverMinCompatible: 2, clientVersion: 1 });
  });

  it("reports server-too-old before client-too-old when both checks fail", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 0, minCompatibleRemoteProtocol: 99 }),
    ).toEqual({ kind: "server-too-old", serverVersion: 0, minSupported: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/client-runtime/src/connection/compat.test.ts`
Expected: FAIL — module `./compat.ts` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/client-runtime/src/connection/compat.ts`:

```ts
import {
  MIN_COMPATIBLE_REMOTE_PROTOCOL,
  REMOTE_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@bibcode/contracts";

/**
 * Compatibility verdict for one environment, computed from the remote protocol
 * window the server advertises on its environment descriptor.
 *
 * - `legacy`: the server predates the window (both fields decode-defaulted to
 *   0). Rendered as "Limited compatibility"; the existing default-false
 *   capability booleans continue to govern behavior.
 * - `server-too-old` / `client-too-old`: one side is outside the two-way
 *   window and the pairing cannot operate.
 */
export type CompatVerdict =
  | { kind: "compatible" }
  | { kind: "legacy" }
  | { kind: "server-too-old"; serverVersion: number; minSupported: number }
  | { kind: "client-too-old"; serverMinCompatible: number; clientVersion: number };

/**
 * Two-way window rule: compatible iff the server's version meets this client's
 * floor and this client's version meets the server's floor. Evaluation order
 * is normative: legacy (both fields 0), then server-too-old, then
 * client-too-old.
 *
 * Failed descriptor probes carry no cache of their own: retry pacing is the
 * supervisor's existing 1/2/4/8/16 s reconnection backoff.
 */
export function computeCompatVerdict(
  descriptor: Pick<
    ExecutionEnvironmentDescriptor,
    "remoteProtocolVersion" | "minCompatibleRemoteProtocol"
  >,
): CompatVerdict {
  const serverVersion = descriptor.remoteProtocolVersion;
  const serverMinCompatible = descriptor.minCompatibleRemoteProtocol;
  if (serverVersion === 0 && serverMinCompatible === 0) {
    return { kind: "legacy" };
  }
  if (serverVersion < MIN_COMPATIBLE_REMOTE_PROTOCOL) {
    return {
      kind: "server-too-old",
      serverVersion,
      minSupported: MIN_COMPATIBLE_REMOTE_PROTOCOL,
    };
  }
  if (REMOTE_PROTOCOL_VERSION < serverMinCompatible) {
    return {
      kind: "client-too-old",
      serverMinCompatible,
      clientVersion: REMOTE_PROTOCOL_VERSION,
    };
  }
  return { kind: "compatible" };
}
```

Then add the barrel export in `packages/client-runtime/src/connection/index.ts`:

```ts
export * from "./catalog.ts";
export * from "./compat.ts";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/client-runtime/src/connection/compat.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime/src/connection/compat.ts packages/client-runtime/src/connection/compat.test.ts packages/client-runtime/src/connection/index.ts
git commit -m "feat(client-runtime): compute the protocol compatibility verdict"
```

---

### Task 4: Per-environment verdict exposure — `compatVerdictAtom`

**Files:**
- Modify: `packages/client-runtime/src/state/session.ts` (helper + atom family inside `createEnvironmentSessionAtoms`, currently lines 28–95)
- Test: `packages/client-runtime/src/state/session.test.ts` (append to the existing `describe("environment session state", ...)` block)

**Interfaces:**
- Consumes: `computeCompatVerdict` / `CompatVerdict` from `../connection/compat.ts` (Task 3); the existing `preparedConnectionValueAtom` family and `PreparedConnection.descriptor` (the resolver attaches the descriptor it fetches on every connection attempt, so the verdict updates on every reconnect).
- Produces (pinned names for later phases):
  - `compatVerdictFromPrepared(prepared: Option.Option<Pick<PreparedConnection, "descriptor">>): CompatVerdict | null` — pure helper, exported for tests and non-atom callers.
  - `createEnvironmentSessionAtoms(runtime).compatVerdictAtom(environmentId)` — `Atom` of `CompatVerdict | null` (`null` = no prepared connection observed, i.e. the environment has not connected in this app session). **This is the selector later phases consume.** In `apps/web` it is already reachable with zero wiring as `environmentSession.compatVerdictAtom(environmentId)` (`apps/web/src/state/session.ts` exports `environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime)`). UI consumption (badges, settings rows, rail status) belongs to Phases 4 and 6, not this phase.

- [ ] **Step 1: Write the failing tests**

Append to `packages/client-runtime/src/state/session.test.ts` (the file already imports `describe`, `expect`, `it` from `@effect/vitest` and `Option`; extend its imports):

```ts
import type { ExecutionEnvironmentDescriptor } from "@bibcode/contracts";

import { compatVerdictFromPrepared, initialConfigOption } from "./session.ts";
```

```ts
const currentDescriptor: ExecutionEnvironmentDescriptor = {
  environmentId: "env-current",
  label: "Current",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  storageInstanceId: null,
  remoteProtocolVersion: 1,
  minCompatibleRemoteProtocol: 1,
  capabilities: {
    repositoryIdentity: true,
    worktreeCatalog: false,
    worktreeCatalogRefreshReason: false,
    vcsStatusSummary: false,
    activityProtocolVersion: null,
  },
};

describe("environment compatibility verdict selection", () => {
  it("yields no verdict before a prepared connection exists", () => {
    expect(compatVerdictFromPrepared(Option.none())).toBeNull();
  });

  it("derives the verdict from the prepared connection descriptor", () => {
    expect(
      compatVerdictFromPrepared(Option.some({ descriptor: currentDescriptor })),
    ).toEqual({ kind: "compatible" });
  });

  it("classifies a pre-window prepared descriptor as legacy", () => {
    expect(
      compatVerdictFromPrepared(
        Option.some({
          descriptor: {
            ...currentDescriptor,
            remoteProtocolVersion: 0,
            minCompatibleRemoteProtocol: 0,
          },
        }),
      ),
    ).toEqual({ kind: "legacy" });
  });
});
```

Note: if `environmentId: "env-current"` fails typecheck because `EnvironmentId` is branded, use `EnvironmentId.make("env-current")` with `import { EnvironmentId } from "@bibcode/contracts";` (this is the pattern `apps/web/src/state/environments.ts` uses).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test run packages/client-runtime/src/state/session.test.ts`
Expected: FAIL — `compatVerdictFromPrepared` is not exported from `./session.ts`.

- [ ] **Step 3: Write the minimal implementation**

In `packages/client-runtime/src/state/session.ts`, extend the imports:

```ts
import { computeCompatVerdict, type CompatVerdict } from "../connection/compat.ts";
```

Add the pure helper at module level (below `initialConfigOption`):

```ts
export function compatVerdictFromPrepared(
  prepared: Option.Option<Pick<PreparedConnection, "descriptor">>,
): CompatVerdict | null {
  return Option.match(prepared, {
    onNone: () => null,
    onSome: (connection) => computeCompatVerdict(connection.descriptor),
  });
}
```

Inside `createEnvironmentSessionAtoms`, after `preparedConnectionValueAtom`, add the family (naming and labels mirror the file's existing `environment-prepared-connection:${environmentId}` convention):

```ts
  const compatVerdictAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): CompatVerdict | null =>
      compatVerdictFromPrepared(get(preparedConnectionValueAtom(environmentId))),
    ).pipe(Atom.withLabel(`environment-compat-verdict:${environmentId}`)),
  );
```

and extend the return value:

```ts
  return {
    initialConfigAtom,
    initialConfigValueAtom,
    preparedConnectionAtom,
    preparedConnectionValueAtom,
    compatVerdictAtom,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test run packages/client-runtime/src/state/session.test.ts`
Expected: PASS (the pre-existing initial-config test plus the three new tests).

- [ ] **Step 5: Typecheck the workspace**

Run: `vp run typecheck`
Expected: PASS (confirms `apps/web`'s existing `createEnvironmentSessionAtoms` call site absorbs the new return member with no change).

- [ ] **Step 6: Commit**

```bash
git add packages/client-runtime/src/state/session.ts packages/client-runtime/src/state/session.test.ts
git commit -m "feat(client-runtime): expose a per-environment protocol compatibility verdict"
```

---

### Task 5: Living documentation, runbook review, and the phase validation gate

**Files:**
- Modify: `docs/architecture/overview.md` (descriptor-surfaces paragraph, ~lines 255–264)
- Modify: `docs/architecture/connection-runtime.md` (new section after "Data boundary")
- Review only (no expected change): `docs/testing/README.md`, `docs/testing/cross-platform-validation.md`, `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, `docs/testing/windows-desktop.md`

**Interfaces:**
- Consumes: everything shipped by Tasks 1–4.
- Produces: living-doc coverage of the window and verdict, and the phase's completion evidence.

- [ ] **Step 1: Update `docs/architecture/overview.md`**

In the "Project-data ownership and identity" area, directly after the paragraph ending "…any other local filesystem path." (~line 264), insert:

```markdown
Every current-server descriptor surface also publishes the remote protocol
compatibility window: `remoteProtocolVersion` and
`minCompatibleRemoteProtocol` (both `1` today). The numbers are defined once
per language — TypeScript in `packages/contracts/src/environment.ts`
(`REMOTE_PROTOCOL_VERSION`, `MIN_COMPATIBLE_REMOTE_PROTOCOL`) and Rust in
`apps/server/src/http.rs` — and serialized by the well-known descriptor
route, `server.getConfig`, the initial `subscribeServerConfig` snapshot,
lifecycle welcome and ready events, and BiBCode Connect descriptors. Contract
decoding maps both fields to `0` for an older or third-party server, which
clients classify as legacy limited compatibility. The window supplements —
never replaces — the default-false capability booleans that continue to gate
optional behavior.
```

- [ ] **Step 2: Update `docs/architecture/connection-runtime.md`**

Insert a new section at the true end of the "Data boundary" section — i.e. **after** its closing `See [Remote architecture](./remote.md) …` cross-reference paragraph, so that cross-reference stays with Data boundary:

```markdown
## Protocol compatibility verdict

`packages/client-runtime/src/connection/compat.ts` computes a `CompatVerdict`
(`compatible`, `legacy`, `server-too-old`, or `client-too-old`) from the
`remoteProtocolVersion` / `minCompatibleRemoteProtocol` pair on the
environment descriptor. The rule is a two-way window: compatible iff the
server's version meets this client's floor and this client's version meets
the server's floor; a descriptor with both fields decode-defaulted to `0`
predates the window and is `legacy` ("Limited compatibility"), with the
existing default-false capability booleans still governing behavior. The
verdict rides the descriptor the resolver fetches on every connection
attempt: `createEnvironmentSessionAtoms(...).compatVerdictAtom(environmentId)`
derives it from the supervisor's prepared connection and is `null` until an
attempt has produced a descriptor. Failed descriptor probes have no separate
cache: retry pacing is the supervisor's existing 1/2/4/8/16 s reconnection
backoff, so a startup burst against an unreachable environment is already
throttled to one attempt per backoff step.
```

- [ ] **Step 3: Review the testing runbooks**

Read `docs/testing/README.md`, `docs/testing/cross-platform-validation.md`, `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md`, and `docs/testing/windows-desktop.md`. This phase changes no test commands, package scripts, CI gates, packaging steps, OS presentation, provider visibility, worktree lifecycle, process lifecycle, packaged UI flows, or validation-evidence schema — confirm that against the diff, make no edits, and state in the final report that all five runbooks were **reviewed and remain accurate**.

- [ ] **Step 4: Run the full phase validation gate**

Run, in order, and record exact commands and outcomes for the final report:

```bash
vp check
vp run typecheck
vp run --filter @bibcode/contracts test
vp run --filter @bibcode/client-runtime test
cargo fmt --all --check
cargo test -p bibcode-server --lib environment_descriptor
cargo test -p bibcode-server --test server_runtime binds_an_ephemeral_port_and_serves_the_environment_descriptor
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: all pass with no warnings.

- [ ] **Step 5: Final diff review**

Run: `git diff` and `git status --short`
Check: no unintended edits, no generated `.codegraph/` data staged, no debug output, no dependency drift, and the pending user deletions under `docs/plans/2026-08-24-environment-project-management/` remain untouched (neither restored nor committed).

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/overview.md docs/architecture/connection-runtime.md
git commit -m "docs(architecture): document the remote protocol compatibility window and verdict"
```

---

## Residual risks (report these with the completion evidence)

- The Rust descriptor has three producers kept consistent only by the shared constants in
  `apps/server/src/http.rs`; the BiBCode Connect descriptor in `apps/server/src/lifecycle.rs`
  has no producer-level test (it is buried in async lifecycle wiring), so its coverage is
  the shared constants plus review. A future refactor unifying the three producers would
  remove this class of drift.
- The pinned-literal parity mechanism catches a one-sided constant bump only through the
  paired tests asserting `1`; when the window is ever raised, both languages' constants,
  both pinned tests, and spec §4.4 must move in the same change.
- `compatVerdictAtom` is `null` for environments that have never connected in this app
  session; the disconnected-environment status probe is deliberately deferred to the
  settings surface of Phase 4, and failed-probe pacing is intentionally left to the
  supervisor's existing 1/2/4/8/16 s reconnection backoff (amended spec §4.4 — no
  separate probe-failure cache).
