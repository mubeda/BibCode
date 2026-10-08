# Internal Browser Link Routing (Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every link a user clicks in BiBCode lands in the internal browser by default, the system browser on request, or an actionable notice when the target is on an unreachable remote server — never the wrong machine's localhost and never nowhere.

**Architecture:** One web router (`apps/web/src/browser/openLink.ts`) decides the destination from a new client setting plus an invert gesture, after a topology-aware resolver (`resolvePreviewTarget`) maps server-loopback URLs or rejects them. Desktop stops the opener plugin from swallowing `_blank` clicks and handles new-window requests natively. Server adds a sandbox CSP to agent HTML/SVG assets and attributes discovered ports to terminals.

**Tech Stack:** React 19 + Effect atoms (`apps/web`), Effect Schema (`packages/contracts`), Tauri 2.11.5 + tauri-plugin-opener 2.5.5 (`apps/desktop`), Rust/Axum/Tokio (`apps/server`), Vite+ (`vp`) test runner, cargo.

**Spec:** `docs/superpowers/specs/2026-10-07-internal-browser-link-routing-design.md`

## Global Constraints

- Setting: `browserLinkTarget: "app" | "system"`, default `"app"`, client-side (in `ClientSettingsSchema`).
- Chat invert gesture: Ctrl/Cmd/Shift/Alt-click or middle-click; on an `.html`/`.htm`/`.pdf` chat file link it opens the editor instead. Terminal invert gesture: **Shift** held with the Ctrl/Cmd activation click (Ctrl/Cmd alone is the activation gesture, see `isTerminalLinkActivation`); OSC 8 links use the same activation guard.
- Topology is decided by `target._tag` for SSH and relay, and by the endpoint host for every other connection (a primary can be a remote server in browser mode); tailnet `100.64.0.0/10` and private IPv6 count as private.
- A loopback URL for a thread is resolved **before** choosing a destination; an unreachable result shows the notice and opens nothing, for every destination.
- Terminal file paths: only `.html`, `.htm`, `.pdf` (case-insensitive, after stripping `:line:col`) go to the browser; Shift inverts to the editor; all other paths keep going to the editor.
- Asset CSP values, verbatim: HTML `sandbox allow-scripts allow-forms allow-popups`; SVG `default-src 'none'; style-src 'unsafe-inline'; sandbox`.
- Opener plugin: `tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build()`.
- No new RPC, no new server listener, no Node runtime, no new npm/cargo dependency.
- `vp` is not on PATH here: run it as `PATH=$PWD/node_modules/.bin:$PATH node scripts/run-local-vp.mjs <args>` from the repo root, or `node ../../scripts/run-local-vp.mjs <args>` from a package dir. Run cargo test/clippy serialized (parallel builds OOM).
- Before **every** commit: run `codex review --uncommitted` (no prompt argument), evaluate findings with `superpowers:receiving-code-review`, fix what holds, then commit. Commit messages end with the attribution lines given in the session.
- Before Task 1, record the starting commit: `START_SHA=$(git rev-parse HEAD)` and write it into the execution report; Task 10 diffs against it.
- Commit only the files the task lists. Never stage `docs/plans/2026-10-06-internal-browser-and-mobile-emulator-research.md` (it fails the identity test).

## Review Focus

1. **SSH environment + loopback link** — `httpBaseUrl` is `http://127.0.0.1:<forward>`, so any host-based "is this local?" check says yes. Expect: notice, not the client's localhost. Pinned in Task 2 (`classifies SSH by target tag even with a loopback httpBaseUrl`).
2. **`0.0.0.0` URLs** (`http://0.0.0.0:3000` printed by many dev servers) — expect the same handling as `localhost`. Pinned in Task 2 (`treats 0.0.0.0 as loopback`).
3. **Browser-mode system open after async work** — `window.open` loses user activation after an `await`. Expect: the system-browser branch calls `openExternal` synchronously in the click turn. Pinned in Task 3 (`opens external without awaiting first`).
4. **Terminal path with position suffix** (`dist/index.html:12:3`) — expect the browser, with the suffix stripped. Pinned in Task 5 (`classifies html path with line and column`).
5. **Preview popup from a tab whose thread is unknown** (tab closed mid-event) — expect: ignored, no crash. Pinned in Task 6 (`ignores new-window requests for unknown tabs`).

---

### Task 1: `browserLinkTarget` client setting and Settings row

**Files:**
- Modify: `packages/contracts/src/settings.ts` (literal near `:40-43`, `ClientSettingsSchema` near `:114-170`, `ClientSettingsPatch` near `:683-715`)
- Modify: `packages/contracts/src/settings.test.ts`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx` (`GeneralSettingsPanel` `:518`, `useGeneralSettingsRestore` `:422-500`)
- Modify: `apps/web/src/components/settings/SettingsPanels.test.tsx`

**Interfaces:**
- Produces: `BrowserLinkTarget` schema/type (`"app" | "system"`), `DEFAULT_BROWSER_LINK_TARGET = "app"`, `ClientSettings.browserLinkTarget`, patch key `browserLinkTarget`. Read with `getClientSettings().browserLinkTarget` (outside React) or `useClientSettings((s) => s.browserLinkTarget)`.

- [ ] **Step 1: Write the failing contracts test** — append to `packages/contracts/src/settings.test.ts`:

```ts
describe("ClientSettings browser link target", () => {
  it("opens links in the app by default and keeps an explicit choice", () => {
    expect(decodeClientSettings({}).browserLinkTarget).toBe("app");
    expect(DEFAULT_CLIENT_SETTINGS.browserLinkTarget).toBe("app");
    expect(decodeClientSettings({ browserLinkTarget: "system" }).browserLinkTarget).toBe("system");
    expect(decodeClientSettings({ browserLinkTarget: "bogus" }).browserLinkTarget).toBe("app");
    expect(decodeClientSettingsPatch({ browserLinkTarget: "system" })).toEqual({
      browserLinkTarget: "system",
    });
    expect(() => decodeClientSettingsPatch({ browserLinkTarget: "tab" })).toThrow();
  });
});
```

(Use the `decodeClientSettings` / `decodeClientSettingsPatch` helpers already defined at the top of that test file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/contracts && node ../../scripts/run-local-vp.mjs test run src/settings.test.ts`
Expected: FAIL — `browserLinkTarget` is `undefined`.

- [ ] **Step 3: Implement the schema** in `packages/contracts/src/settings.ts`:

```ts
/** Where a clicked web link opens: the integrated browser or the system browser. */
export const BrowserLinkTarget = Schema.Literals(["app", "system"]);
export type BrowserLinkTarget = typeof BrowserLinkTarget.Type;
export const DEFAULT_BROWSER_LINK_TARGET: BrowserLinkTarget = "app";
```

In `ClientSettingsSchema` (keep keys alphabetical; an unknown stored value falls back like `statusBarUsageMode`):

```ts
  browserLinkTarget: BrowserLinkTarget.pipe(
    Schema.catchDecoding(() => Effect.succeedSome(DEFAULT_BROWSER_LINK_TARGET)),
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_LINK_TARGET)),
  ),
```

In `ClientSettingsPatch`:

```ts
  browserLinkTarget: Schema.optionalKey(BrowserLinkTarget),
```

- [ ] **Step 4: Run the contracts test** — same command. Expected: PASS.

- [ ] **Step 5: Write the failing Settings UI test** in `apps/web/src/components/settings/SettingsPanels.test.tsx`, following the existing `GeneralSettingsPanel` tests in that file (same render helper and settings mock). Assert: a row titled `Open links in` renders with the value label `BiBCode browser`; selecting `System browser` calls the update mock with `{ browserLinkTarget: "system" }`; with `browserLinkTarget: "system"` the restore-defaults list includes `"Open links in"`.

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/settings/SettingsPanels.test.tsx`
Expected: FAIL — row not found.

- [ ] **Step 7: Implement the row** in `GeneralSettingsPanel`, next to the editor/time-format rows:

```tsx
const BROWSER_LINK_TARGET_LABELS = {
  app: "BiBCode browser",
  system: "System browser",
} as const;
```

```tsx
<SettingsRow
  title="Open links in"
  description="Where web links from chat and the terminal open. Hold Ctrl or Cmd in chat, or Shift in the terminal, to use the other one."
  resetAction={
    settings.browserLinkTarget !== DEFAULT_UNIFIED_SETTINGS.browserLinkTarget ? (
      <SettingResetButton
        label="link target"
        onClick={() =>
          updateSettings({ browserLinkTarget: DEFAULT_UNIFIED_SETTINGS.browserLinkTarget })
        }
      />
    ) : null
  }
  control={
    <Select
      value={settings.browserLinkTarget}
      onValueChange={(value) => {
        if (value === "app" || value === "system") updateSettings({ browserLinkTarget: value });
      }}
    >
      <SelectTrigger className="w-full sm:w-40" aria-label="Open links in">
        <SelectValue>{BROWSER_LINK_TARGET_LABELS[settings.browserLinkTarget]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="app">{BROWSER_LINK_TARGET_LABELS.app}</SelectItem>
        <SelectItem hideIndicator value="system">{BROWSER_LINK_TARGET_LABELS.system}</SelectItem>
      </SelectPopup>
    </Select>
  }
/>
```

In `useGeneralSettingsRestore`: add `...(settings.browserLinkTarget !== DEFAULT_UNIFIED_SETTINGS.browserLinkTarget ? ["Open links in"] : [])` to the changed list, `settings.browserLinkTarget` to the deps array, and `browserLinkTarget: DEFAULT_UNIFIED_SETTINGS.browserLinkTarget` to the reset patch.

- [ ] **Step 8: Run the Settings test** — same command as Step 6. Expected: PASS.

- [ ] **Step 9: Codex review, then commit**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/SettingsPanels.test.tsx
git commit -m "feat(settings): add browserLinkTarget client setting"
```

---

### Task 2: Topology-aware resolver and link notices

**Files:**
- Modify: `apps/web/src/browser/browserTargetResolver.ts`
- Modify: `apps/web/src/browser/browserTargetResolver.test.ts`
- Create: `apps/web/src/browser/linkNotices.ts`
- Create: `apps/web/src/browser/linkNotices.test.ts`
- Modify: `apps/web/src/components/preview/openDiscoveredPort.ts`, `apps/web/src/components/preview/useDiscoveredLocalServers.ts:38`, `apps/web/src/components/preview/PreviewView.tsx:153`
- Modify: `apps/web/src/components/preview/PreviewView.test.tsx` (it mocks the deleted `resolveDiscoveredServerUrl`), plus any other test that mocks it (`rg -l resolveDiscoveredServerUrl apps/web/src`)

**Interfaces:**
- Consumes: `readPreparedConnection(environmentId)` → `PreparedConnection | null` with `label`, `httpBaseUrl`, `target._tag` (`PrimaryConnectionTarget | BearerConnectionTarget | RelayConnectionTarget | SshConnectionTarget | UnavailableConnectionTarget`); `isLoopbackHost`, `normalizePreviewUrl` from `@bibcode/shared/preview`; `toastManager`, `stackedThreadToast` from `~/components/ui/toast` (`type` accepts `"error" | "warning" | "success" | "info" | "loading"`).
- Produces:

```ts
// browserTargetResolver.ts
export type PreviewUnreachableReason = "disconnected" | "ssh" | "relay" | "public-host";
export type PreviewTargetResolution =
  | { readonly kind: "reachable"; readonly url: string }
  | {
      readonly kind: "unreachable";
      readonly reason: PreviewUnreachableReason;
      readonly environmentLabel: string;
    };
export const UNREACHABLE_MESSAGES: Record<PreviewUnreachableReason, (label: string) => string>;
export function resolvePreviewTarget(environmentId: EnvironmentId, rawUrl: string): PreviewTargetResolution;

// linkNotices.ts
export function showPreviewUnreachableNotice(
  resolution: Extract<PreviewTargetResolution, { kind: "unreachable" }>,
): void;
export function showFileOutsideWorkspaceNotice(input: { readonly onOpenInEditor: () => void }): void;
export function showLinkOpenFailedNotice(url: string): void;
```

`resolveBrowserNavigationTarget` keeps its signature and return type; `resolveDiscoveredServerUrl` is deleted.

Topology rules (the connection target alone never decides "same machine"; the endpoint host does):

| `target._tag` | Rule |
| --- | --- |
| `SshConnectionTarget` | unreachable `ssh` (its `httpBaseUrl` is a client-side `127.0.0.1` forward) |
| `RelayConnectionTarget` | unreachable `relay` |
| `PrimaryConnectionTarget`, `BearerConnectionTarget`, `UnavailableConnectionTarget` | by `httpBaseUrl` host: loopback → same host; private/tailnet → rewrite onto that host; otherwise unreachable `public-host` |

Primary is classified by host because browser mode served by a remote server is a primary connection (`http://192.168.1.25:3773`). Desktop-local WSL is a Bearer target whose host is the VM IP, so it rewrites.

- [ ] **Step 1: Write failing tests** in `browserTargetResolver.test.ts`. Port every existing `resolveDiscoveredServerUrl` case (schemeless `localhost:5173/app`, `127.0.0.1` base, public URL passthrough, private IPv6 host, malformed input, wildcard HTTPS discovery) to `resolvePreviewTarget`, giving each mocked connection a `label` and a `target`. Where an old case expected the raw URL when disconnected, it now expects `{ kind: "unreachable", reason: "disconnected" }` for loopback input. Update the two `resolveBrowserNavigationTarget` message assertions (`/authenticated preview gateway/`, `"is not connected"`) to the new `UNREACHABLE_MESSAGES` text. Then add:

```ts
const env = EnvironmentId.make("environment-1");
const conn = (target: Record<string, unknown>, httpBaseUrl: string) => ({
  label: "Build box",
  httpBaseUrl,
  target,
});

it("keeps normalized loopback URLs on a same-host primary environment", async () => {
  readPreparedConnection.mockReturnValue(
    conn({ _tag: "PrimaryConnectionTarget" }, "http://127.0.0.1:3773"),
  );
  const { resolvePreviewTarget } = await import("./browserTargetResolver");
  expect(resolvePreviewTarget(env, "http://localhost:5173/a?b=1#c")).toEqual({
    kind: "reachable",
    url: "http://localhost:5173/a?b=1#c",
  });
  expect(resolvePreviewTarget(env, "localhost:5173/app")).toEqual({
    kind: "reachable",
    url: "http://localhost:5173/app",
  });
  expect(resolvePreviewTarget(env, "http://0.0.0.0:3000/")).toEqual({
    kind: "reachable",
    url: "http://localhost:3000/",
  });
});

it("maps a primary served from a remote LAN host onto that host", async () => {
  readPreparedConnection.mockReturnValue(
    conn({ _tag: "PrimaryConnectionTarget" }, "http://192.168.1.25:3773"),
  );
  const { resolvePreviewTarget } = await import("./browserTargetResolver");
  expect(resolvePreviewTarget(env, "http://localhost:5173/")).toEqual({
    kind: "reachable",
    url: "http://192.168.1.25:5173/",
  });
});

it("treats 0.0.0.0 as loopback on a LAN bearer environment", async () => {
  readPreparedConnection.mockReturnValue(
    conn({ _tag: "BearerConnectionTarget", connectionId: "lan:1" }, "http://192.168.1.25:3773"),
  );
  const { resolvePreviewTarget } = await import("./browserTargetResolver");
  expect(resolvePreviewTarget(env, "http://0.0.0.0:3000/")).toEqual({
    kind: "reachable",
    url: "http://192.168.1.25:3000/",
  });
});

it("reaches tailnet addresses", async () => {
  readPreparedConnection.mockReturnValue(
    conn({ _tag: "BearerConnectionTarget", connectionId: "ts:1" }, "http://100.64.0.10:3773"),
  );
  const { resolvePreviewTarget } = await import("./browserTargetResolver");
  expect(resolvePreviewTarget(env, "http://localhost:5173/")).toEqual({
    kind: "reachable",
    url: "http://100.64.0.10:5173/",
  });
});

it("classifies SSH by target tag even with a loopback httpBaseUrl", async () => {
  readPreparedConnection.mockReturnValue(
    conn({ _tag: "SshConnectionTarget", connectionId: "ssh:1" }, "http://127.0.0.1:45123/"),
  );
  const { resolvePreviewTarget } = await import("./browserTargetResolver");
  expect(resolvePreviewTarget(env, "http://localhost:5173/")).toEqual({
    kind: "unreachable",
    reason: "ssh",
    environmentLabel: "Build box",
  });
});

it("refuses relay environments", async () => {
  readPreparedConnection.mockReturnValue(
    conn({ _tag: "RelayConnectionTarget" }, "https://abc.connect.example.com"),
  );
  const { resolvePreviewTarget } = await import("./browserTargetResolver");
  expect(resolvePreviewTarget(env, "http://127.0.0.1:8080/")).toMatchObject({
    kind: "unreachable",
    reason: "relay",
  });
});

it("refuses bearer environments on public hosts", async () => {
  readPreparedConnection.mockReturnValue(
    conn({ _tag: "BearerConnectionTarget", connectionId: "b:1" }, "https://dev.example.com"),
  );
  const { resolvePreviewTarget } = await import("./browserTargetResolver");
  expect(resolvePreviewTarget(env, "http://localhost:5173/")).toMatchObject({
    kind: "unreachable",
    reason: "public-host",
  });
});

it("rewrites desktop-local WSL loopback onto the VM address", async () => {
  readPreparedConnection.mockReturnValue(
    conn({ _tag: "BearerConnectionTarget", connectionId: "local:wsl" }, "http://172.22.1.5:3773"),
  );
  const { resolvePreviewTarget } = await import("./browserTargetResolver");
  expect(resolvePreviewTarget(env, "http://localhost:5173/x")).toEqual({
    kind: "reachable",
    url: "http://172.22.1.5:5173/x",
  });
});

it("reports a disconnected environment instead of guessing", async () => {
  readPreparedConnection.mockReturnValue(null);
  const { resolvePreviewTarget } = await import("./browserTargetResolver");
  expect(resolvePreviewTarget(env, "http://localhost:5173/")).toEqual({
    kind: "unreachable",
    reason: "disconnected",
    environmentLabel: "This environment",
  });
});

it("passes non-loopback URLs through without reading the connection", async () => {
  const { resolvePreviewTarget } = await import("./browserTargetResolver");
  expect(resolvePreviewTarget(env, "https://example.com/docs")).toEqual({
    kind: "reachable",
    url: "https://example.com/docs",
  });
  expect(readPreparedConnection).not.toHaveBeenCalled();
});

it("refuses environment-port automation targets over SSH", async () => {
  readPreparedConnection.mockReturnValue(
    conn({ _tag: "SshConnectionTarget", connectionId: "ssh:1" }, "http://127.0.0.1:45123/"),
  );
  const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
  expect(() =>
    resolveBrowserNavigationTarget(env, { kind: "environment-port", port: 5173 }),
  ).toThrow(/SSH/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/browser/browserTargetResolver.test.ts`
Expected: FAIL — `resolvePreviewTarget` is not exported.

- [ ] **Step 3: Implement** in `browserTargetResolver.ts`. Keep `isLocalLoopbackHost`. Extend `isPrivateNetworkHost` with the tailnet CGNAT range and private IPv6:

```ts
const isPrivateNetworkHost = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".local")) {
    return true;
  }
  if (normalized.endsWith(".ts.net")) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(normalized) || /^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) || // tailnet CGNAT 100.64.0.0/10
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254)
  );
};
```

Add:

```ts
export type PreviewUnreachableReason = "disconnected" | "ssh" | "relay" | "public-host";
export type PreviewTargetResolution =
  | { readonly kind: "reachable"; readonly url: string }
  | {
      readonly kind: "unreachable";
      readonly reason: PreviewUnreachableReason;
      readonly environmentLabel: string;
    };

export const UNREACHABLE_MESSAGES: Record<PreviewUnreachableReason, (label: string) => string> = {
  disconnected: (label) => `${label} isn't connected. Reconnect it, then open the link again.`,
  ssh: (label) =>
    `This address is on ${label}, not this computer. Opening server ports over SSH isn't available yet.`,
  relay: (label) =>
    `This address is on ${label}, not this computer. Opening server ports over BiBCode Connect isn't available yet.`,
  "public-host": (label) =>
    `This address is on ${label}, not this computer, and ${label} isn't on a private network, so its ports can't be opened directly.`,
};

type EnvironmentReach =
  | { readonly kind: "same-host" }
  | { readonly kind: "host"; readonly host: string }
  | { readonly kind: "unreachable"; readonly reason: PreviewUnreachableReason; readonly label: string };

function classifyEnvironmentReach(environmentId: EnvironmentId): EnvironmentReach {
  const connection = readPreparedConnection(environmentId);
  if (!connection) return { kind: "unreachable", reason: "disconnected", label: "This environment" };
  const label = connection.label;
  if (connection.target._tag === "SshConnectionTarget") {
    return { kind: "unreachable", reason: "ssh", label };
  }
  if (connection.target._tag === "RelayConnectionTarget") {
    return { kind: "unreachable", reason: "relay", label };
  }
  const host = new URL(connection.httpBaseUrl).hostname.replace(/^\[|\]$/g, "");
  if (isLocalLoopbackHost(host)) return { kind: "same-host" };
  if (isPrivateNetworkHost(host)) return { kind: "host", host };
  return { kind: "unreachable", reason: "public-host", label };
}

const formatHost = (host: string) => (host.includes(":") ? `[${host}]` : host);

export function resolvePreviewTarget(
  environmentId: EnvironmentId,
  rawUrl: string,
): PreviewTargetResolution {
  let parsed: URL;
  try {
    parsed = new URL(normalizePreviewUrl(rawUrl));
  } catch {
    // Malformed input keeps the normal navigation error path.
    return { kind: "reachable", url: rawUrl };
  }
  if (!isLoopbackHost(parsed.hostname)) return { kind: "reachable", url: parsed.toString() };
  const reach = classifyEnvironmentReach(environmentId);
  if (reach.kind === "unreachable") {
    return { kind: "unreachable", reason: reach.reason, environmentLabel: reach.label };
  }
  // A wildcard bind is not a navigable address; loopback is.
  parsed.hostname = reach.kind === "same-host"
    ? parsed.hostname === "0.0.0.0" ? "localhost" : parsed.hostname
    : formatHost(reach.host);
  return { kind: "reachable", url: parsed.toString() };
}
```

Rewrite `resolveBrowserNavigationTarget`'s `environment-port` branch to use `classifyEnvironmentReach`: `unreachable` → `throw new Error(UNREACHABLE_MESSAGES[reach.reason](reach.label))`; `same-host` → `resolvedUrl = requestedUrl`, `resolutionKind: "direct"`; `host` → today's rewrite, `resolutionKind: "direct-private-network"`. Delete `resolveDiscoveredServerUrl`.

- [ ] **Step 4: Run resolver tests** — Step 2's command. Expected: PASS.

- [ ] **Step 5: Failing notice tests** `apps/web/src/browser/linkNotices.test.ts` — mock `~/components/ui/toast` (`toastManager.add`, `stackedThreadToast: (o) => o`) and assert:
  - `showPreviewUnreachableNotice({ kind: "unreachable", reason: "ssh", environmentLabel: "Box" })` adds a `warning` toast titled `Can't open this address here` whose description is `UNREACHABLE_MESSAGES.ssh("Box")`.
  - `showFileOutsideWorkspaceNotice({ onOpenInEditor })` adds an `info` toast titled `This file is outside the workspace` with `actionProps.children === "Open in editor"`; invoking `actionProps.onClick` calls `onOpenInEditor`.
  - `showLinkOpenFailedNotice("https://x.test/")` adds an `error` toast titled `Couldn't open the link`, description `https://x.test/`, action `Copy link` that calls `navigator.clipboard.writeText("https://x.test/")`.

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/browser/linkNotices.test.ts` — Expected: FAIL.

- [ ] **Step 6: Implement** `apps/web/src/browser/linkNotices.ts`:

```ts
import { stackedThreadToast, toastManager } from "~/components/ui/toast";

import { type PreviewTargetResolution, UNREACHABLE_MESSAGES } from "./browserTargetResolver";

export function showPreviewUnreachableNotice(
  resolution: Extract<PreviewTargetResolution, { kind: "unreachable" }>,
): void {
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "Can't open this address here",
      description: UNREACHABLE_MESSAGES[resolution.reason](resolution.environmentLabel),
    }),
  );
}

export function showFileOutsideWorkspaceNotice(input: { readonly onOpenInEditor: () => void }): void {
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: "This file is outside the workspace",
      description: "Only files inside the thread's workspace can open in the browser.",
      actionVariant: "outline",
      actionProps: { children: "Open in editor", onClick: input.onOpenInEditor },
    }),
  );
}

export function showLinkOpenFailedNotice(url: string): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't open the link",
      description: url,
      actionVariant: "outline",
      actionProps: {
        children: "Copy link",
        onClick: () => void navigator.clipboard?.writeText(url).catch(() => undefined),
      },
    }),
  );
}
```

Run Step 5's command. Expected: PASS.

- [ ] **Step 7: Migrate callers and their tests.**
  - `openDiscoveredPort.ts`: `const resolution = resolvePreviewTarget(input.threadRef.environmentId, input.port.url); if (resolution.kind === "unreachable") { showPreviewUnreachableNotice(resolution); return AsyncResult.success(undefined); }` then use `resolution.url`.
  - `useDiscoveredLocalServers.ts:38`: `url: (() => { const r = resolvePreviewTarget(input.environmentId, server.url); return r.kind === "reachable" ? r.url : server.url; })()` (display only; the click path resolves again).
  - `PreviewView.tsx:153` (`handleSubmitUrl`): resolve; on `unreachable`, call `showPreviewUnreachableNotice` and return before any `navigate`/`navigateDesktopTab`.
  - `PreviewView.test.tsx` and any other test double: replace the `resolveDiscoveredServerUrl` mock with `resolvePreviewTarget: vi.fn((_env, url) => ({ kind: "reachable", url }))`; add one case asserting an `unreachable` result shows the notice (mock `~/browser/linkNotices`) and never navigates.

- [ ] **Step 8: Run the resolver, notice, and preview component tests**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/browser src/components/preview`
Expected: PASS.

- [ ] **Step 9: Codex review, then commit**

```bash
git add apps/web/src/browser/browserTargetResolver.ts apps/web/src/browser/browserTargetResolver.test.ts apps/web/src/browser/linkNotices.ts apps/web/src/browser/linkNotices.test.ts apps/web/src/components/preview/openDiscoveredPort.ts apps/web/src/components/preview/useDiscoveredLocalServers.ts apps/web/src/components/preview/PreviewView.tsx apps/web/src/components/preview/PreviewView.test.tsx
git commit -m "fix(web): resolve server-loopback preview targets by environment topology"
```

---

### Task 3: The `openLink` router

**Files:**
- Create: `apps/web/src/browser/openLink.ts`
- Create: `apps/web/src/browser/openLink.test.ts`

**Interfaces:**
- Consumes: `resolvePreviewTarget`, `showPreviewUnreachableNotice`, `showLinkOpenFailedNotice` (Task 2); `getClientSettings().browserLinkTarget` (Task 1); `openUrlInPreview`, `OpenPreviewMutation` (`~/browser/openFileInPreview`); `isPreviewSupportedInRuntime` (`~/previewStateStore`); `readLocalApi` (`~/localApi`).
- Produces:

```ts
export type LinkDestination = "app" | "system";
export function chooseLinkDestination(input: {
  readonly setting: LinkDestination;
  readonly invert: boolean;
  readonly canUseApp: boolean;
}): LinkDestination;

export type OpenLinkOutcome = "app" | "system" | "unreachable" | "unavailable";
export function openLink(input: {
  readonly url: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly invert: boolean;
  readonly openPreview: OpenPreviewMutation<unknown>;
  readonly onError?: (cause: unknown) => void;
}): OpenLinkOutcome;
```

`openLink` is synchronous up to the external open, so browser-mode `window.open` keeps the click's user activation. The `"app"` branch fires `openUrlInPreview` without awaiting and reports failures through `onError`.

- [ ] **Step 1: Write failing tests** `apps/web/src/browser/openLink.test.ts`:

```ts
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const resolvePreviewTarget = vi.fn();
const showPreviewUnreachableNotice = vi.fn();
const openUrlInPreview = vi.fn();
const openExternal = vi.fn();
let previewSupported = true;
let setting: "app" | "system" = "app";

vi.mock("./browserTargetResolver", () => ({ resolvePreviewTarget }));
const showLinkOpenFailedNotice = vi.fn();
vi.mock("./linkNotices", () => ({ showPreviewUnreachableNotice, showLinkOpenFailedNotice }));
vi.mock("./openFileInPreview", () => ({ openUrlInPreview }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => previewSupported }));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ shell: { openExternal } }) }));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ browserLinkTarget: setting }),
}));

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const openPreview = vi.fn();

describe("chooseLinkDestination", () => {
  it.each([
    ["app", false, true, "app"],
    ["app", true, true, "system"],
    ["system", false, true, "system"],
    ["system", true, true, "app"],
    ["app", false, false, "system"],
    ["system", true, false, "system"],
  ] as const)("setting %s invert %s canUseApp %s -> %s", async (s, invert, canUseApp, want) => {
    const { chooseLinkDestination } = await import("./openLink");
    expect(chooseLinkDestination({ setting: s, invert, canUseApp })).toBe(want);
  });
});

describe("openLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewSupported = true;
    setting = "app";
    openUrlInPreview.mockResolvedValue(AsyncResult.success(undefined));
    openExternal.mockResolvedValue(undefined);
  });

  it("opens resolved loopback URLs in the app", async () => {
    resolvePreviewTarget.mockReturnValue({ kind: "reachable", url: "http://10.0.0.2:5173/" });
    const { openLink } = await import("./openLink");
    expect(openLink({ url: "http://localhost:5173/", threadRef, invert: false, openPreview })).toBe("app");
    expect(openUrlInPreview).toHaveBeenCalledWith({ threadRef, url: "http://10.0.0.2:5173/", openPreview });
  });

  it("shows the notice and opens nothing for unreachable targets, even when inverted", async () => {
    const unreachable = { kind: "unreachable", reason: "ssh", environmentLabel: "Box" };
    resolvePreviewTarget.mockReturnValue(unreachable);
    const { openLink } = await import("./openLink");
    expect(openLink({ url: "http://localhost:5173/", threadRef, invert: true, openPreview })).toBe("unreachable");
    expect(showPreviewUnreachableNotice).toHaveBeenCalledWith(unreachable);
    expect(openExternal).not.toHaveBeenCalled();
    expect(openUrlInPreview).not.toHaveBeenCalled();
  });

  it("opens external without awaiting first", async () => {
    resolvePreviewTarget.mockReturnValue({ kind: "reachable", url: "https://example.com/" });
    setting = "system";
    const { openLink } = await import("./openLink");
    openLink({ url: "https://example.com/", threadRef, invert: false, openPreview });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
  });

  it("falls back to the system browser without a thread", async () => {
    const { openLink } = await import("./openLink");
    expect(openLink({ url: "https://example.com/", threadRef: null, invert: false, openPreview })).toBe("system");
    expect(resolvePreviewTarget).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
  });

  it("falls back to the system browser when preview is unsupported", async () => {
    previewSupported = false;
    resolvePreviewTarget.mockReturnValue({ kind: "reachable", url: "https://example.com/" });
    const { openLink } = await import("./openLink");
    expect(openLink({ url: "https://example.com/", threadRef, invert: false, openPreview })).toBe("system");
  });

  it("shows a copyable notice when the system browser fails", async () => {
    resolvePreviewTarget.mockReturnValue({ kind: "reachable", url: "https://example.com/" });
    setting = "system";
    openExternal.mockRejectedValue(new Error("no handler"));
    const { openLink } = await import("./openLink");
    openLink({ url: "https://example.com/", threadRef, invert: false, openPreview });
    await vi.waitFor(() => expect(showLinkOpenFailedNotice).toHaveBeenCalledWith("https://example.com/"));
  });

  it("reports async preview failures through onError", async () => {
    resolvePreviewTarget.mockReturnValue({ kind: "reachable", url: "https://example.com/" });
    const failure = new Error("boom");
    openUrlInPreview.mockRejectedValue(failure);
    const onError = vi.fn();
    const { openLink } = await import("./openLink");
    openLink({ url: "https://example.com/", threadRef, invert: false, openPreview, onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/browser/openLink.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `apps/web/src/browser/openLink.ts`:

```ts
import type { ScopedThreadRef } from "@bibcode/contracts";
import { isAtomCommandInterrupted } from "@bibcode/client-runtime/state/runtime";

import { getClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";

import { resolvePreviewTarget } from "./browserTargetResolver";
import { type OpenPreviewMutation, openUrlInPreview } from "./openFileInPreview";
import { showLinkOpenFailedNotice, showPreviewUnreachableNotice } from "./linkNotices";

export type LinkDestination = "app" | "system";
export type OpenLinkOutcome = "app" | "system" | "unreachable" | "unavailable";

export function chooseLinkDestination(input: {
  readonly setting: LinkDestination;
  readonly invert: boolean;
  readonly canUseApp: boolean;
}): LinkDestination {
  if (!input.canUseApp) return "system";
  if (!input.invert) return input.setting;
  return input.setting === "app" ? "system" : "app";
}

export function openLink(input: {
  readonly url: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly invert: boolean;
  readonly openPreview: OpenPreviewMutation<unknown>;
  readonly onError?: (cause: unknown) => void;
}): OpenLinkOutcome {
  let url = input.url;
  if (input.threadRef) {
    const resolution = resolvePreviewTarget(input.threadRef.environmentId, url);
    if (resolution.kind === "unreachable") {
      showPreviewUnreachableNotice(resolution);
      return "unreachable";
    }
    url = resolution.url;
  }
  const destination = chooseLinkDestination({
    setting: getClientSettings().browserLinkTarget,
    invert: input.invert,
    canUseApp: input.threadRef !== null && isPreviewSupportedInRuntime(),
  });
  if (destination === "system" || input.threadRef === null) {
    const api = readLocalApi();
    if (!api) return "unavailable";
    // Called synchronously so browser-mode window.open keeps the click's activation.
    api.shell.openExternal(url).catch((cause: unknown) => {
      showLinkOpenFailedNotice(url);
      input.onError?.(cause);
    });
    return "system";
  }
  openUrlInPreview({ threadRef: input.threadRef, url, openPreview: input.openPreview })
    .then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) input.onError?.(result.cause);
    })
    .catch((cause: unknown) => input.onError?.(cause));
  return "app";
}
```

- [ ] **Step 4: Run the tests** — same command. Expected: PASS.

- [ ] **Step 5: Codex review, then commit**

```bash
git add apps/web/src/browser/openLink.ts apps/web/src/browser/openLink.test.ts
git commit -m "feat(web): add a single link router for the integrated browser"
```

---

### Task 4: Route chat links and chat file links through the router

**Files:**
- Modify: `apps/web/src/components/ChatMarkdown.tsx` (`MarkdownFileLink` click `:1168-1176` and `handleOpenInBrowser` `:1037-1065`; anchor renderer `:1358-1440`; `openExternalLinkInPreview` `:1274`)
- Modify: `apps/web/src/components/ChatMarkdown.behavior.test.tsx` (click-behavior tests live here; `ChatMarkdown.test.tsx` holds rendering tests)

**Interfaces:**
- Consumes: `openLink` (Task 3); `showFileOutsideWorkspaceNotice` (Task 2); `getClientSettings` (`~/hooks/useSettings`).

- [ ] **Step 1: Write failing tests** in `ChatMarkdown.behavior.test.tsx`. Mock `~/browser/openLink` with `vi.mock("~/browser/openLink", () => ({ openLink: vi.fn(() => "app") }))` and `~/browser/linkNotices`.
  - primary click on `http://localhost:5173/` calls `openLink` with `{ invert: false }` and `preventDefault`s;
  - Ctrl-click calls `openLink` with `{ invert: true }` and `preventDefault`s;
  - middle-click (`auxclick`, `button: 1`) calls `openLink` with `{ invert: true }`;
  - same-document `#fragment` links still scroll and never call `openLink`;
  - right-click menu "Open in integrated browser" calls `openLink` with `invert: false` when the setting is `"app"`, and "Open in system browser" with `invert: true`;
  - Ctrl-click on an `.html` chat file link opens the editor instead of the browser (assert the editor opener, not `onOpenInBrowser`);
  - an `.html` chat file link whose preview fails with cause `{ _tag: "AssetWorkspacePathValidationError" }` calls `showFileOutsideWorkspaceNotice`, and its `onOpenInEditor` opens the editor.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/ChatMarkdown.behavior.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement URL links.** In the non-file-link branch of the `a` renderer, replace the `opensInPreview` logic with:

```tsx
const routeLink = (event: ReactMouseEvent<HTMLAnchorElement>, invert: boolean) => {
  if (!href || !isHttpUrl(href)) return;
  event.preventDefault();
  openLink({
    url: href,
    threadRef: threadRef ?? null,
    invert,
    openPreview,
    onError: (cause) => reportMarkdownActionFailure({ operation: "open-link", target: href }, cause),
  });
};
```

```tsx
onClick={(event) => {
  onClick?.(event);
  if (event.defaultPrevented) return;
  if (isSameDocumentLink && href) {
    handleMarkdownFragmentClick(event, href);
    return;
  }
  routeLink(event, isModifiedOrNonPrimaryMarkdownClick(event));
}}
onAuxClick={(event) => {
  if (event.button === 1) routeLink(event, true);
}}
```

Keep `target="_blank"` on the element (it only matters for non-http hrefs). Remove `opensInPreview` and the `openExternalLinkInPreview` callback. Rewrite the context menu so each item routes through `openLink` synchronously (no `await` of a result, no `result._tag` checks):

```tsx
if (clicked === "open-in-browser" || clicked === "open-external") {
  const wantApp = clicked === "open-in-browser";
  const setting = getClientSettings().browserLinkTarget;
  openLink({
    url: href,
    threadRef: threadRef ?? null,
    invert: wantApp ? setting === "system" : setting === "app",
    openPreview,
    onError: (cause) =>
      reportMarkdownActionFailure({ operation: "open-link", target: href }, cause),
  });
}
```

Drop `openExternalLinkInPreview` from the `markdownComponents` dependency list (`:1535`) and add `openPreview`.

- [ ] **Step 4: Implement file links.** In `MarkdownFileLink`'s anchor `onClick`:

```tsx
onClick={(event) => {
  event.preventDefault();
  event.stopPropagation();
  if (onOpenInBrowser && isModifiedOrNonPrimaryMarkdownClick(event)) {
    handleOpenInEditor();
    return;
  }
  if (onOpenInBrowser) {
    handleOpenInBrowser();
    return;
  }
  handleOpenInFilePreview();
}}
```

In `handleOpenInBrowser`, before the generic "Unable to open file in browser" toast:

```ts
const error = squashAtomCommandFailure(result) as { readonly _tag?: string } | undefined;
if (error?._tag === "AssetWorkspacePathValidationError") {
  showFileOutsideWorkspaceNotice({ onOpenInEditor: handleOpenInEditor });
  return;
}
```

(Add `handleOpenInEditor` to that callback's dependency list.)

- [ ] **Step 5: Run tests** — Step 2's command plus `src/components/ChatMarkdown.test.tsx`. Expected: PASS.

- [ ] **Step 6: Codex review, then commit**

```bash
git add apps/web/src/components/ChatMarkdown.tsx apps/web/src/components/ChatMarkdown.behavior.test.tsx
git commit -m "feat(web): route chat links and file links through the link router"
```

---

### Task 5: Terminal URLs, `.html`/`.pdf` paths, and OSC 8

**Files:**
- Modify: `apps/web/src/terminal-links.ts` (`FILE_PATH_PATTERN` `:40-41`, `extractTerminalLinks` `:183`, new `fileUrlToPath`, `terminalPreviewFilePath`)
- Modify: `apps/web/src/terminal-links.test.ts`
- Modify: `apps/web/src/components/ThreadTerminalPanel.tsx` (link provider `:1534-1620`, `new Terminal({...})` `:1128`, hooks near `:808`)
- Modify: `apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx`
- Delete: `apps/web/src/components/preview/openTerminalLinkInPreview.ts` and `apps/web/src/components/preview/openTerminalLinkInPreview.test.ts`

**Interfaces:**
- Consumes: `openLink` (Task 3); `showFileOutsideWorkspaceNotice` (Task 2); `openFileInPreview` (`~/browser/openFileInPreview`); `isPreviewSupportedInRuntime` (`~/previewStateStore`); `useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false })` (imports: `useAtomQueryRunner` from `../state/use-atom-query-runner`, `assetEnvironment` from `../state/assets`, as `ChatMarkdown.tsx:75,79,1227` do); `usePreparedConnection(environmentId)` from `../state/session`, which returns `Option<PreparedConnection>` (check `._tag === "None"` and read `.value.httpBaseUrl`, as `ChatMarkdown.tsx:1293-1305` does); `isTerminalLinkActivation`; `isMacPlatform` from `~/lib/utils`.
- Produces:

```ts
export function fileUrlToPath(raw: string): string | null; // file:// URL → OS path, else null
export function terminalPreviewFilePath(rawPath: string, cwd: string): string | null;
```

`extractTerminalLinks` additionally yields `kind: "path"` matches for `file://` URLs (collected before plain paths so the Windows-drive alternative can't match inside `file:`) and for bare preview filenames such as `index.html` or `report.pdf:3`.

- [ ] **Step 1: Failing helper and extraction tests** in `terminal-links.test.ts`:

```ts
describe("file links", () => {
  it("extracts bare preview filenames", () => {
    expect(extractTerminalLinks("open index.html now").map((m) => [m.kind, m.text])).toEqual([
      ["path", "index.html"],
    ]);
  });
  it("extracts file URLs whole", () => {
    expect(extractTerminalLinks("see file:///tmp/report%20one.PDF").map((m) => m.text)).toEqual([
      "file:///tmp/report%20one.PDF",
    ]);
  });
  it("converts POSIX, Windows-drive, and UNC file URLs", () => {
    expect(fileUrlToPath("file:///tmp/report%20one.PDF")).toBe("/tmp/report one.PDF");
    expect(fileUrlToPath("file:///C:/repo/report.pdf")).toBe("C:\\repo\\report.pdf");
    expect(fileUrlToPath("file://server/share/report.pdf")).toBe("\\\\server\\share\\report.pdf");
    expect(fileUrlToPath("/not/a/url")).toBeNull();
  });
  it("classifies html path with line and column", () => {
    expect(terminalPreviewFilePath("dist/index.html:12:3", "/repo")).toBe("/repo/dist/index.html");
  });
  it("classifies a bare preview filename against the cwd", () => {
    expect(terminalPreviewFilePath("index.html", "/repo")).toBe("/repo/index.html");
  });
  it("accepts file URLs and pdf, case-insensitively", () => {
    expect(terminalPreviewFilePath("file:///tmp/report.PDF", "/repo")).toBe("/tmp/report.PDF");
  });
  it("ignores other files", () => {
    expect(terminalPreviewFilePath("src/main.ts:4", "/repo")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/terminal-links.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** in `terminal-links.ts`:

```ts
const FILE_URL_PATTERN = /file:\/\/[^\s"'`<>]+/g;
const PREVIEW_FILENAME_PATTERN = /(?<![\w./\\-])[A-Za-z0-9._-]+\.(?:html?|pdf)(?::\d+){0,2}(?![\w/])/gi;

export function fileUrlToPath(raw: string): string | null {
  if (!raw.startsWith("file://")) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const pathname = decodeURIComponent(url.pathname);
  if (url.host.length > 0) {
    return `\\\\${url.host}${pathname.replaceAll("/", "\\")}`;
  }
  const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(pathname);
  if (drive) return `${drive[1]}${(drive[2] ?? "\\").replaceAll("/", "\\")}`;
  return pathname;
}

export function terminalPreviewFilePath(rawPath: string, cwd: string): string | null {
  const { path } = splitPathAndPosition(fileUrlToPath(rawPath) ?? rawPath);
  if (!/\.(?:html?|pdf)$/i.test(path)) return null;
  return resolvePathLinkTarget(path, cwd);
}
```

Update `extractTerminalLinks` (keep `collectMatches`' existing exclusion argument, which skips ranges already matched):

```ts
export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const urlMatches = collectMatches(line, "url", URL_PATTERN, []);
  const fileUrlMatches = collectMatches(line, "path", FILE_URL_PATTERN, urlMatches);
  const taken = [...urlMatches, ...fileUrlMatches];
  const pathMatches = collectMatches(line, "path", FILE_PATH_PATTERN, taken);
  const filenameMatches = collectMatches(line, "path", PREVIEW_FILENAME_PATTERN, [
    ...taken,
    ...pathMatches,
  ]);
  return [...taken, ...pathMatches, ...filenameMatches].toSorted((a, b) => a.start - b.start);
}
```

Run Step 2's command, plus the whole existing `terminal-links.test.ts`. Expected: PASS with no regressions in existing extraction cases.

- [ ] **Step 4: Failing panel tests** in `ThreadTerminalPanel.interactions.test.tsx`, using its existing link-activation harness:
  - Ctrl-click (non-mac platform) on `http://localhost:5173` calls `openLink` with `{ invert: false }`; no context menu is shown.
  - Ctrl+Shift-click calls `openLink` with `{ invert: true }`.
  - Ctrl-click on `dist/index.html` calls `openFileInPreview` with the absolute path; Ctrl+Shift-click calls the editor opener instead.
  - Ctrl-click on `src/main.ts:4` calls the editor opener (unchanged).
  - `openFileInPreview` failing with cause `{ _tag: "AssetWorkspacePathValidationError" }` calls `showFileOutsideWorkspaceNotice`; invoking its `onOpenInEditor` opens the editor with the path.
  - The `Terminal` is constructed with a `linkHandler`: `activate` with a plain click does nothing; with Ctrl (Cmd on mac) calls `openLink` with `{ url, invert: false }`; with Ctrl+Shift calls it with `{ invert: true }`.

- [ ] **Step 5: Implement in `ThreadTerminalPanel.tsx`.** Add next to `openPreview` (`:810`):

```ts
const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
  reportFailure: false,
});
const preparedConnection = usePreparedConnection(threadRef.environmentId);
const openPreviewFile = useEffectEvent(async (absolutePath: string) => {
  if (preparedConnection._tag === "None") return { ok: false as const, outside: false };
  const result = await openFileInPreview({
    threadRef,
    filePath: absolutePath,
    httpBaseUrl: preparedConnection.value.httpBaseUrl,
    createAssetUrl,
    openPreview,
  });
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return { ok: true as const };
  const error = squashAtomCommandFailure(result) as { readonly _tag?: string } | undefined;
  return { ok: false as const, outside: error?._tag === "AssetWorkspacePathValidationError" };
});
const routeTerminalUrl = useEffectEvent((url: string, invert: boolean) =>
  openLink({
    url,
    threadRef: threadRef.threadId.length > 0 ? threadRef : null,
    invert,
    openPreview,
    onError: (cause) => {
      const t = terminalRef.current;
      if (t) writeSystemMessage(t, cause instanceof Error ? cause.message : "Unable to open link");
    },
  }),
);
const openEditorPath = useEffectEvent((target: string) => {
  void (async () => {
    const result = await openTerminalPath(target);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    const t = terminalRef.current;
    if (t) writeSystemMessage(t, error instanceof Error ? error.message : "Unable to open path");
  })();
});
```

In `activate`, replace the `match.kind === "url"` block and the path block with:

```ts
if (match.kind === "url") {
  routeTerminalUrl(match.text, event.shiftKey);
  return;
}
const unavailableReason = readWorkspaceUnavailable();
if (unavailableReason !== null) {
  writeSystemMessage(latestTerminal, unavailableReason);
  return;
}
const editorTarget = resolvePathLinkTarget(fileUrlToPath(match.text) ?? match.text, cwd);
const previewFile = terminalPreviewFilePath(match.text, cwd);
if (previewFile !== null && isPreviewSupportedInRuntime() && !event.shiftKey) {
  void (async () => {
    const outcome = await openPreviewFile(previewFile);
    if (outcome.ok) return;
    if (outcome.outside) {
      showFileOutsideWorkspaceNotice({ onOpenInEditor: () => openEditorPath(editorTarget) });
      return;
    }
    writeSystemMessage(latestTerminal, "Unable to preview this file.");
  })();
  return;
}
openEditorPath(editorTarget);
```

In `new Terminal({...})` (`:1128`) add (OSC 8 activations bypass the link provider, so apply the same activation guard here):

```ts
linkHandler: {
  activate: (event, uri) => {
    if (!isTerminalLinkActivation(event)) return;
    routeTerminalUrl(uri, event.shiftKey);
  },
  allowNonHttpProtocols: false,
},
```

Remove the `openTerminalLinkInPreview` import. Remove the `localApi` guard in the URL branch only if nothing else in that block still uses it.

- [ ] **Step 6: Run the terminal tests**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/terminal-links.test.ts src/components/ThreadTerminalPanel.interactions.test.tsx`
Expected: PASS.

- [ ] **Step 7: Codex review, then commit**

```bash
git add apps/web/src/terminal-links.ts apps/web/src/terminal-links.test.ts apps/web/src/components/ThreadTerminalPanel.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx
git rm apps/web/src/components/preview/openTerminalLinkInPreview.ts apps/web/src/components/preview/openTerminalLinkInPreview.test.ts
git commit -m "feat(web): route terminal URLs, OSC 8 links, and html paths through the link router"
```

---

### Task 6: Desktop new-window handling and the opener click script

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs:104` (opener), `:113-121` (`setup`: build the main window)
- Modify: `apps/desktop/src-tauri/tauri.conf.json:15-23` (`"create": false` on `main`)
- Modify: `apps/desktop/src-tauri/src/window.rs` (new `build_main_window` + `main_window_new_window_action`)
- Modify: `apps/desktop/src-tauri/src/preview/host.rs` (builder `:773-818`; new event constant + pure fn + test)
- Modify: `packages/contracts/src/ipc.ts:1360-1430` (`DesktopPreviewBridge.onNewWindowRequest`)
- Modify: `apps/web/src/tauriPreviewBridge.ts` (implement `onNewWindowRequest`) and `apps/web/src/tauriPreviewBridge.test.ts`
- Modify: `apps/web/src/previewStateStore.ts` (`findPreviewThreadForTab`)
- Create: `apps/web/src/components/preview/PreviewNewWindowRouter.tsx` + `PreviewNewWindowRouter.test.tsx`
- Modify: `apps/web/src/AppRoot.tsx:173` (mount the router next to `<PreviewAutomationHosts />`)
- Modify: every test double implementing `DesktopPreviewBridge` (`rg -ln "automation: \{" apps/web/src --glob '*.test.*'`) to add `onNewWindowRequest: () => () => undefined`.

**Interfaces:**
- Produces (Rust): `pub const NEW_WINDOW_EVENT: &str = "preview://new-window";` payload `{ "tabId": String, "url": String }`; `fn preview_new_window_url(url: &Url) -> Option<&Url>` (http/https only); `fn main_window_new_window_action(url: &Url) -> MainNewWindowAction` where `enum MainNewWindowAction { OpenExternal, Ignore }` (http, https, mailto → `OpenExternal`).
- Produces (TS): `onNewWindowRequest: (listener: (tabId: string, url: string) => void) => () => void` on `DesktopPreviewBridge`; `findPreviewThreadForTab(tabId: string): ScopedThreadRef | null`.

- [ ] **Step 1: Failing Rust tests.** In `preview/host.rs` `mod tests`:

```rust
#[test]
fn preview_new_window_only_forwards_web_urls() {
    let web = tauri::Url::parse("https://example.com/a").unwrap();
    assert_eq!(super::preview_new_window_url(&web), Some(&web));
    let data = tauri::Url::parse("data:text/html,hi").unwrap();
    assert_eq!(super::preview_new_window_url(&data), None);
}
```

In `window.rs` tests:

```rust
#[test]
fn main_window_new_windows_open_externally_for_web_and_mail_links() {
    use super::{MainNewWindowAction, main_window_new_window_action};
    for url in ["https://github.com/x/y/pull/1", "http://localhost:3000/", "mailto:a@b.c"] {
        let url = tauri::Url::parse(url).unwrap();
        assert_eq!(main_window_new_window_action(&url), MainNewWindowAction::OpenExternal);
    }
    let file = tauri::Url::parse("file:///etc/passwd").unwrap();
    assert_eq!(main_window_new_window_action(&file), MainNewWindowAction::Ignore);
}
```

In `lib.rs` tests:

```rust
#[test]
fn main_window_is_created_by_setup_so_it_can_handle_new_windows() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(config["app"]["windows"][0]["label"], "main");
    assert_eq!(config["app"]["windows"][0]["create"], false);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bibcode-desktop --lib -- preview_new_window main_window_new_windows main_window_is_created`
Expected: FAIL (missing items / `create` is null).

- [ ] **Step 3: Implement Rust.**

`lib.rs:104`:

```rust
        // The plugin's injected click script would swallow `_blank` links in
        // every webview (preview tabs included) and call an IPC command no
        // capability grants. New windows are routed by `on_new_window` instead.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
```

`tauri.conf.json`: add `"create": false` to the `main` window entry.

`window.rs`:

```rust
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MainNewWindowAction {
    OpenExternal,
    Ignore,
}

pub(crate) fn main_window_new_window_action(url: &tauri::Url) -> MainNewWindowAction {
    match url.scheme() {
        "http" | "https" | "mailto" => MainNewWindowAction::OpenExternal,
        _ => MainNewWindowAction::Ignore,
    }
}

pub(crate) fn build_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .expect("tauri.conf.json defines the main window");
    let handle = app.clone();
    tauri::WebviewWindowBuilder::from_config(app, &config)?
        .on_new_window(move |url, _features| {
            if main_window_new_window_action(&url) == MainNewWindowAction::OpenExternal {
                if let Err(error) = handle.opener().open_url(url.as_str(), None::<&str>) {
                    tracing::warn!("failed to open link externally: {error}");
                }
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}
```

`lib.rs` `setup`: call `window::build_main_window(app.handle())?;` **before** `window::configure_application_menu` / `window::restore_main_window_state` (both expect the window to exist).

`preview/host.rs`:

```rust
pub const NEW_WINDOW_EVENT: &str = "preview://new-window";

fn preview_new_window_url(url: &Url) -> Option<&Url> {
    matches!(url.scheme(), "http" | "https").then_some(url)
}

#[derive(Debug, Clone, Serialize)]
struct NewWindowEvent {
    #[serde(rename = "tabId")]
    tab_id: String,
    url: String,
}
```

In `create_tab`, chain on the builder after `on_page_load`:

```rust
        .on_new_window({
            let app = app.clone();
            let tab_id = tab_id.to_string();
            move |url, _features| {
                if let Some(url) = preview_new_window_url(&url) {
                    let payload = NewWindowEvent { tab_id: tab_id.clone(), url: url.to_string() };
                    if let Err(error) = app.emit(NEW_WINDOW_EVENT, payload) {
                        tracing::warn!("failed to emit preview new-window request: {error}");
                    }
                }
                tauri::webview::NewWindowResponse::Deny
            }
        })
```

- [ ] **Step 4: Run Rust tests** — Step 2's command. Expected: PASS. Then `cargo clippy -p bibcode-desktop --all-targets -- -D warnings` and `cargo fmt --all --check`.

- [ ] **Step 5: Failing web test** `PreviewNewWindowRouter.test.tsx`:

```tsx
// Mock window.desktopBridge.preview.onNewWindowRequest to capture the listener,
// mock findPreviewThreadForTab and openUrlInPreview.
it("opens popups from a preview tab as a new tab in the same thread", () => {
  /* render <PreviewNewWindowRouter />; call captured listener("tab_1", "https://x.test/");
     expect openUrlInPreview called with { threadRef, url: "https://x.test/" } */
});
it("ignores new-window requests for unknown tabs", () => {
  /* findPreviewThreadForTab returns null; call listener; expect no openUrlInPreview call, no throw */
});
it("shows the unreachable notice for server-loopback popups on SSH threads", () => {
  /* resolvePreviewTarget returns { kind: "unreachable", reason: "ssh", environmentLabel: "Box" };
     expect showPreviewUnreachableNotice called and openUrlInPreview not called */
});
```

Write both tests fully using the render helper pattern from `PreviewAutomationHosts.test.tsx:250-270`.

Also add to `tauriPreviewBridge.test.ts` (using its existing fake `listen`): after the bridge binds logical tab `tab_a` to the native host and then switches the active logical tab to `tab_b` of another thread, a `preview://new-window` event carrying the native host tab id reaches the listener as `("tab_b", url)`; with no active logical tab, the listener is not called.

- [ ] **Step 6: Run to verify failure**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/preview/PreviewNewWindowRouter.test.tsx src/tauriPreviewBridge.test.ts`
Expected: FAIL.

- [ ] **Step 7: Implement web side.**

`ipc.ts` `DesktopPreviewBridge`, after `onStateChange`:

```ts
  /** A page in a preview tab asked to open a new window (popup or target=_blank). */
  onNewWindowRequest: (listener: (tabId: string, url: string) => void) => () => void;
```

`tauriPreviewBridge.ts`, next to `onStateChange`:

```ts
    onNewWindowRequest: (listener) =>
      listen<{ tabId: string; url: string }>("preview://new-window", (payload) => {
        // One native child is reused for every logical tab (see nativeHostTabId);
        // remap exactly like the preview://state handler does.
        const tabId = nativeHostTabId !== null && payload.tabId === nativeHostTabId
          ? activeTabId
          : payload.tabId;
        if (tabId !== null) listener(tabId, payload.url);
      }),
```

`previewStateStore.ts`:

```ts
export function findPreviewThreadForTab(tabId: string): ScopedThreadRef | null {
  const sessions = appAtomRegistry.get(activePreviewSessionsAtom);
  for (const [threadKey, state] of Object.entries(sessions)) {
    if (state.sessions[tabId]) return parseScopedThreadKey(threadKey);
  }
  return null;
}
```

`PreviewNewWindowRouter.tsx`:

```tsx
"use client";

import { useEffect } from "react";

import { resolvePreviewTarget } from "~/browser/browserTargetResolver";
import { showPreviewUnreachableNotice } from "~/browser/linkNotices";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { findPreviewThreadForTab } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

export function PreviewNewWindowRouter() {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  useEffect(() => {
    const bridge = window.desktopBridge?.preview;
    if (!bridge) return;
    return bridge.onNewWindowRequest((tabId, url) => {
      const threadRef = findPreviewThreadForTab(tabId);
      if (!threadRef) return;
      // Popups always become internal tabs, but a server-loopback URL must
      // still be resolved for the thread's environment first.
      const resolution = resolvePreviewTarget(threadRef.environmentId, url);
      if (resolution.kind === "unreachable") {
        showPreviewUnreachableNotice(resolution);
        return;
      }
      void openUrlInPreview({ threadRef, url: resolution.url, openPreview });
    });
  }, [openPreview]);
  return null;
}
```

Mount `<PreviewNewWindowRouter />` in `AppRoot.tsx` next to `<PreviewAutomationHosts />`. Add `onNewWindowRequest: () => () => undefined` to every `DesktopPreviewBridge` test double the typecheck flags.

- [ ] **Step 8: Run web tests + typecheck**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/preview` then from repo root `PATH=$PWD/node_modules/.bin:$PATH node scripts/run-local-vp.mjs run typecheck`
Expected: PASS.

- [ ] **Step 9: Manual desktop check** — `vp run dev:desktop` (see `docs/reference/scripts.md`): in a preview tab, click a `target=_blank` link → a new preview tab opens; in Git Manager, click a PR title → system browser opens. Record in the task report.

- [ ] **Step 10: Codex review, then commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/src/window.rs apps/desktop/src-tauri/src/preview/host.rs packages/contracts/src/ipc.ts apps/web/src/tauriPreviewBridge.ts apps/web/src/tauriPreviewBridge.test.ts apps/web/src/previewStateStore.ts apps/web/src/components/preview/PreviewNewWindowRouter.tsx apps/web/src/components/preview/PreviewNewWindowRouter.test.tsx apps/web/src/AppRoot.tsx <updated test doubles>
git commit -m "fix(desktop): route new-window requests instead of dropping _blank links"
```

---

### Task 7: Tauri `automation.status` so agent `preview_open` succeeds

**Files:**
- Modify: `apps/web/src/tauriPreviewBridge.ts:184-193`
- Modify: `apps/web/src/tauriPreviewBridge.test.ts`

**Interfaces:**
- Consumes: `stateByTab: Map<string, DesktopPreviewTabState>` already in `tauriPreviewBridge.ts:35`.
- Produces: `automation.status(tabId)` resolves `PreviewAutomationStatus` `{ available, visible: true, tabId, url, title, loading }`; all other automation methods still reject.

- [ ] **Step 1: Failing test:**

```ts
it("reports tab status without automation support", async () => {
  // build the bridge with a fake listen that lets the test publish a state event:
  // publish { tabId: "tab_1", state: { navStatus: { kind: "Loading", url: "http://x/", title: "" }, ... } }
  await expect(bridge.automation.status("tab_1")).resolves.toEqual({
    available: true, visible: true, tabId: "tab_1", url: "http://x/", title: "", loading: true,
  });
  await expect(bridge.automation.status("missing")).resolves.toMatchObject({ available: false });
  await expect(bridge.automation.click("tab_1", {} as never)).rejects.toThrow(/not supported/);
});
```

(Model the bridge construction on how `tauriDesktopBridge.ts:476` passes `listen` into the preview bridge factory.)

Also remove `() => bridge.automation.status("t1"),` from the `unsupportedCalls` array in the existing `rejects every unsupported Promise surface` test (`tauriPreviewBridge.test.ts:554`); status is now supported.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/tauriPreviewBridge.test.ts`
Expected: FAIL — status rejects.

- [ ] **Step 3: Implement:**

```ts
      status: async (tabId) => {
        const state = stateByTab.get(tabId);
        const nav = state?.navStatus;
        const loaded = nav && nav.kind !== "Idle" ? nav : null;
        return {
          available: state !== undefined,
          visible: true,
          tabId,
          url: loaded?.url ?? null,
          title: loaded?.title ?? null,
          loading: nav?.kind === "Loading",
        };
      },
```

- [ ] **Step 4: Run tests** — Step 2's command plus `src/components/preview/PreviewAutomationHosts.test.tsx`. Expected: PASS.

- [ ] **Step 5: Docs in the same commit** — `docs/architecture/overview.md:36-38`: say the Rust server brokers preview automation, and on the Tauri desktop host only tab status/open/navigate are supported; snapshot, click, type, and other automation calls are not yet.

- [ ] **Step 6: Codex review, then commit**

```bash
git add apps/web/src/tauriPreviewBridge.ts apps/web/src/tauriPreviewBridge.test.ts docs/architecture/overview.md
git commit -m "fix(web): report desktop preview tab status so agent preview_open succeeds"
```

---

### Task 8: Sandbox CSP on agent HTML and SVG assets

**Files:**
- Modify: `apps/server/src/production/http_routes.rs:459-482`
- Modify: `apps/server/tests/production_http_routes.rs` (near `assets_and_mcp_use_native_handlers_with_protocol_headers` `:260`)

**Interfaces:**
- Produces: `fn asset_content_security_policy(content_type: &str) -> Option<&'static str>`.

- [ ] **Step 1: Failing test** in `apps/server/tests/production_http_routes.rs`:

```rust
#[tokio::test]
async fn html_and_svg_assets_are_sandboxed() {
    for (path, content_type, expected) in [
        ("page.html", "text/html; charset=utf-8", Some("sandbox allow-scripts allow-forms allow-popups")),
        ("icon.svg", "image/svg+xml", Some("default-src 'none'; style-src 'unsafe-inline'; sandbox")),
        ("doc.pdf", "application/pdf", None),
    ] {
        let mut state = state_with_json_recorder(Arc::new(Mutex::new(Vec::new())));
        let content_type = content_type.to_owned();
        state.assets = Arc::new(move |_token, _path, _context| {
            let content_type = content_type.clone();
            Box::pin(async move {
                Ok(AssetHttpResponse {
                    content_type,
                    bytes: b"x".to_vec(),
                    cache_control: "private, max-age=3600".to_owned(),
                })
            })
        });
        let app = add_routes(Router::new()).with_state(TestState(state));
        let response = app
            .oneshot(Request::get(format!("/api/assets/t/{path}")).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            response.headers().get("content-security-policy").map(|v| v.to_str().unwrap()),
            expected,
            "{path}"
        );
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bibcode-server --test production_http_routes html_and_svg_assets_are_sandboxed`
Expected: FAIL — header missing.

- [ ] **Step 3: Implement** in `http_routes.rs`:

```rust
/// Agent-written HTML/SVG is served from the BiBCode origin; an opaque-origin
/// sandbox keeps its scripts away from the session cookie and `/api`.
fn asset_content_security_policy(content_type: &str) -> Option<&'static str> {
    let essence = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match essence.as_str() {
        "text/html" => Some("sandbox allow-scripts allow-forms allow-popups"),
        "image/svg+xml" => Some("default-src 'none'; style-src 'unsafe-inline'; sandbox"),
        _ => None,
    }
}
```

In `asset`:

```rust
        Ok(asset) => {
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, &asset.content_type)
                .header(header::CACHE_CONTROL, asset.cache_control)
                .header("x-content-type-options", "nosniff");
            if let Some(policy) = asset_content_security_policy(&asset.content_type) {
                builder = builder.header(header::CONTENT_SECURITY_POLICY, policy);
            }
            builder.body(Body::from(asset.bytes)).unwrap_or_else(|_| internal_error())
        }
```

- [ ] **Step 4: Run** — Step 2's command, plus the existing `assets_and_mcp_use_native_handlers_with_protocol_headers` (its SVG response now also carries the CSP; extend its asserts to expect it). Then `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `cargo fmt --all --check`.

- [ ] **Step 5: Codex review, then commit**

```bash
git add apps/server/src/production/http_routes.rs apps/server/tests/production_http_routes.rs
git commit -m "fix(server): sandbox agent HTML and SVG assets with a CSP"
```

---

### Task 9: Attribute discovered ports to terminals

**Files:**
- Modify: `apps/server/src/production/local_servers.rs`
- Modify: `apps/server/src/terminal/manager.rs` (new `live_session_pids`)
- Modify: `apps/server/src/production/server_terminal.rs:361-370` (handle `subscribeDiscoveredLocalServers` here)
- Modify: `apps/server/src/production/control.rs:1721-1737` (remove the old arm)
- Modify: `apps/server/tests/production_control.rs:1062-1101` (move the discovery assertions out; `NativeServerControl` no longer serves this stream)

**Interfaces:**
- Consumes: `NativeProcessSampler::collect_rows()` → `Vec<ProcessRow>`; `build_descendant_entries(&rows, root_pid)` (`apps/server/src/diagnostics/model.rs:185`); `ServerTerminalServices { terminal, process_sampler, .. }`.
- Produces:

```rust
pub(crate) struct TerminalProcessSet { pub thread_id: String, pub terminal_id: String, pub pids: Vec<u32> }
pub(crate) async fn discover(cancellation: &CancellationToken, terminals: &[TerminalProcessSet]) -> Vec<Value>;
impl TerminalManager { pub async fn live_session_pids(&self) -> Vec<(String, String, u32)> }
```

- [ ] **Step 1: Failing unit tests** in `local_servers.rs` `mod tests`:

```rust
#[test]
fn listeners_are_attributed_to_the_terminal_owning_their_pid() {
    let terminals = vec![TerminalProcessSet {
        thread_id: "thread-1".into(),
        terminal_id: "term-1".into(),
        pids: vec![100, 101],
    }];
    assert_eq!(
        terminal_for_pid(&terminals, Some(101)),
        Some(json!({ "threadId": "thread-1", "terminalId": "term-1" }))
    );
    assert_eq!(terminal_for_pid(&terminals, Some(7)), None);
    assert_eq!(terminal_for_pid(&terminals, None), None);
}

#[cfg(target_os = "linux")]
#[test]
fn proc_tcp_rows_keep_the_socket_inode() {
    let input = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0\n";
    let listeners = parse_proc_tcp(input);
    assert_eq!(listeners[0].port, 5173);
    assert_eq!(listeners[0].inode, Some(424242));
}

#[cfg(target_os = "linux")]
#[test]
fn socket_inodes_map_to_pids_from_fd_links_and_skip_unreadable_dirs() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("100/fd")).unwrap();
    std::os::unix::fs::symlink("socket:[424242]", root.path().join("100/fd/3")).unwrap();
    // pid 101 has no fd dir (vanished process)
    let map = socket_inode_pids(root.path(), &[100, 101]);
    assert_eq!(map.get(&424242), Some(&100));
}
```

(`tempfile` is already a dev-dependency of `bibcode-server`.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bibcode-server --lib local_servers`
Expected: FAIL (missing functions/field).

- [ ] **Step 3: Implement `local_servers.rs`.**
  - `Listener` gains `#[cfg_attr(not(target_os = "linux"), allow(dead_code))] inode: Option<u64>` (set `None` on Windows/macOS parsers).
  - Linux `parse_proc_tcp`/`parse_proc_tcp6`: guard `fields.len() < 10`, set `inode: fields[9].parse().ok().filter(|inode| *inode != 0)`.
  - `normalize`: when merging duplicates, also fill `inode` if missing.
  - Linux helper (pure over a proc root so it is testable):

```rust
#[cfg(target_os = "linux")]
fn socket_inode_pids(proc_root: &std::path::Path, pids: &[u32]) -> std::collections::HashMap<u64, u32> {
    let mut map = std::collections::HashMap::new();
    for &pid in pids {
        // Processes exit and fd dirs can be unreadable; skip both.
        let Ok(entries) = std::fs::read_dir(proc_root.join(pid.to_string()).join("fd")) else { continue };
        for entry in entries.flatten() {
            let Ok(target) = std::fs::read_link(entry.path()) else { continue };
            let target = target.to_string_lossy();
            if let Some(inode) = target.strip_prefix("socket:[").and_then(|s| s.strip_suffix(']')) {
                if let Ok(inode) = inode.parse() { map.insert(inode, pid); }
            }
        }
    }
    map
}
```

  - `terminal_for_pid(terminals: &[TerminalProcessSet], pid: Option<u32>) -> Option<Value>` returns `json!({ "threadId", "terminalId" })` for the first set containing the pid.
  - `discover(cancellation, terminals)`: after `platform_listeners`, on Linux, if any listener has `pid: None` and `terminals` is non-empty, run `socket_inode_pids(Path::new("/proc"), &all_terminal_pids)` inside `tokio::task::spawn_blocking` and fill `pid` from `inode`. Replace `"terminal": null` with `terminal_for_pid(terminals, listener.pid)`. Only terminal descendants are scanned, never the whole host.

- [ ] **Step 4: Implement `TerminalManager::live_session_pids`** (model on `live_session_count`, manager.rs ~3416):

```rust
pub async fn live_session_pids(&self) -> Vec<(String, String, u32)> {
    let sessions = self.inner.sessions.read().await;
    let mut live = Vec::new();
    for session in sessions.values() {
        let summary = session.lock().await.summary();
        if matches!(summary.status, TerminalStatus::Starting | TerminalStatus::Running)
            && let Some(pid) = summary.pid
        {
            live.push((summary.thread_id, summary.terminal_id, pid));
        }
    }
    live
}
```

(Adjust field names to `TerminalSummary`'s actual ones.) Add a manager test using the existing fake-PTY harness asserting one running session yields one tuple.

- [ ] **Step 5: Move the stream to `server_terminal.rs`.** Remove `"subscribeDiscoveredLocalServers"` from the `for method in [...]` list at `:361-365` and from `control.rs:1721-1737`. Register it directly:

```rust
    {
        let terminal = services.terminal.clone();
        let sampler = services.process_sampler.clone();
        registry.register_stream("subscribeDiscoveredLocalServers", move |_request, cancellation| {
            discovered_local_servers_stream(terminal.clone(), sampler.clone(), cancellation)
        });
    }
```

`discovered_local_servers_stream` copies the old loop's body (channel of 8, `send_event` with `{ servers, scannedAt }`, `SCAN_INTERVAL` sleep, cancellation) and returns the same `JsonStream` type `control.subscribe` returns. Each tick: `let live = terminal.live_session_pids().await;` If `live` is empty, pass `&[]`. Otherwise `sampler.collect_rows().await` once (on error, log at debug and pass `&[]`) and build one `TerminalProcessSet` per session with `pids = [root] + build_descendant_entries(&rows, root).iter().map(|e| e.pid)`.

  ponytail: one full process sample per scan tick while terminals are live; switch to an inspector cache if diagnostics show the 1 s scan cost.

Migrate the discovery half of the `production_control.rs` test (bind a real `TcpListener`, see it discovered with `host`/`port`/`url`, drop it, see the rescan remove it, cancel and see the stream end) into a `#[tokio::test]` in `server_terminal.rs`'s test module, built on the existing services fixture there (`server_terminal.rs:1728-1760`), subscribing through the registry stream. Delete those lines from `production_control.rs`; keep its lifecycle assertions.

- [ ] **Step 6: Run**

Run: `cargo test -p bibcode-server --lib local_servers` then `cargo test -p bibcode-server --lib terminal::manager::tests::live_session_pids` then `cargo test -p bibcode-server --lib production::server_terminal` then `cargo test -p bibcode-server --test production_control` then `cargo test -p bibcode-server --test rpc_wire` (the method set is unchanged; this guards the wire contract).
Expected: PASS. Then clippy + fmt as in Task 8.

- [ ] **Step 7: Codex review, then commit**

```bash
git add apps/server/src/production/local_servers.rs apps/server/src/terminal/manager.rs apps/server/src/production/server_terminal.rs apps/server/src/production/control.rs apps/server/tests/production_control.rs
git commit -m "feat(server): attribute discovered ports to their terminals"
```

---

### Task 10: Living docs, testing runbook, and completion gates

**Files:**
- Modify: `docs/user/workspace-ui.md` (Browser section near `:850`)
- Modify: `packages/contracts/src/preview.ts:4-7` (header comment)
- Modify: `docs/testing/cross-platform-validation.md` (new `### Integrated browser link routing` under the packaged visual validation section)
- Modify: `docs/superpowers/specs/2026-10-07-internal-browser-link-routing-design.md` (only if implementation deviated)

- [ ] **Step 1: User docs** — in `workspace-ui.md`: the "Open links in" setting; chat Ctrl/Cmd/middle-click and terminal Ctrl/Cmd+Shift-click invert it; `.html`/`.htm`/`.pdf` terminal paths open in the browser; links to ports on SSH or BiBCode Connect servers show a notice for now; the browser exists in the desktop app on macOS 14+, Windows, and Linux (replace "when the environment supports previewing").

- [ ] **Step 2: Contracts comment** — `preview.ts:4-7`: the preview is a Tauri child webview owned by the Rust desktop host, not a renderer-owned Chromium `<webview>`.

- [ ] **Step 3: Runbook** — add a checklist: chat link (plain, Ctrl/Cmd, middle) × setting app/system; terminal URL Ctrl/Cmd and Ctrl/Cmd+Shift; OSC 8 link (`printf '\e]8;;https://example.com\e\\link\e]8;;\e\\\n'`); terminal `index.html` path; preview-tab `target=_blank` popup; Git Manager PR link; agent `preview_open` result; SSH environment loopback link shows the notice; agent HTML asset response has the sandbox CSP (`curl -sI` the asset URL).

- [ ] **Step 4: Completion gates (repo root)**

```bash
PATH=$PWD/node_modules/.bin:$PATH node scripts/run-local-vp.mjs check
PATH=$PWD/node_modules/.bin:$PATH node scripts/run-local-vp.mjs run typecheck
cargo fmt --all --check
cargo clippy -p bibcode-server -p bibcode-desktop --all-targets -- -D warnings
cargo test -p bibcode-server
cargo test -p bibcode-desktop
(cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit)
```

All must pass. Record exact output summaries.

- [ ] **Step 5: Reviews** — run `/vercel-react-best-practices` over `ChatMarkdown.tsx`, `ThreadTerminalPanel.tsx`, `PreviewNewWindowRouter.tsx`, `SettingsPanels.tsx`, `PreviewView.tsx`; review the notice copy, the setting row, and the terminal system messages against `UI.md`. Fix findings.

- [ ] **Step 6: Final diff review** — `git diff $START_SHA..HEAD --stat`, then read `git diff $START_SHA..HEAD` in full, and `git status --short`: no generated files, no `.codegraph/`, no research doc, no dependency drift, no debug output.

- [ ] **Step 7: Codex review, then commit**

```bash
git add docs/user/workspace-ui.md packages/contracts/src/preview.ts docs/testing/cross-platform-validation.md
git commit -m "docs: integrated browser link routing behavior and validation"
```
