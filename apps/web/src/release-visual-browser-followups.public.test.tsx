// @effect-diagnostics nodeBuiltinImport:off - Compiled public source QA reads the unchanged serialized observer; no application launch or pixels.
// @vitest-environment happy-dom
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AttachmentUploadNotice } from "./components/chat/AttachmentUploadNotice";
import { HostedPairingRouteSurface } from "./components/auth/PairingRouteSurface";
import { SourceControlChangesList } from "./components/SourceControlChangesList";
import { SourceControlCommitRow } from "./components/SourceControlCommits";
import { isHostedStaticApp } from "./hostedPairing";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { VcsCommit } from "@bibcode/contracts";
import { SlowRequestsIndicator } from "./components/status-bar/SlowRequestsIndicator";
import {
  trackRpcRequestSent,
  acknowledgeRpcRequest,
  resetRequestLatencyStateForTests,
  SLOW_RPC_ACK_THRESHOLD_MS,
} from "./rpc/requestLatencyState";

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  resetRequestLatencyStateForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render(element: React.ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<AppAtomRegistryProvider>{element}</AppAtomRegistryProvider>));
  return container;
}
const policy = NodeFS.readFileSync(
  new NodeURL.URL("../../desktop/e2e/support/release-visual-browser-followups.ts", import.meta.url),
  "utf8",
);
const ownerPolicy = NodeFS.readFileSync(
  new NodeURL.URL(
    "../../desktop/e2e/support/release-visual-browser-followups-owner.ts",
    import.meta.url,
  ),
  "utf8",
);
const fixturePolicy = NodeFS.readFileSync(
  new NodeURL.URL(
    "../../desktop/e2e/support/release-visual-browser-followups-fixture.ts",
    import.meta.url,
  ),
  "utf8",
);
const ownerBegin = ownerPolicy.indexOf("const refused ="),
  ownerEnd = ownerPolicy.indexOf("export async function withBrowserFollowupHeldReply");
const entryBegin = fixturePolicy.indexOf("export function buildBrowserFollowupHostedEntry(");
if (ownerBegin < 0 || ownerEnd <= ownerBegin || entryBegin < 0)
  throw new Error("Actual hosted owner source boundary refused.");
function actualHostedOwner() {
  return NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      ownerPolicy.slice(ownerBegin, ownerEnd).replace(/^export /gm, "") +
        "\n" +
        fixturePolicy.slice(entryBegin).replace(/^export /gm, "") +
        "\nwithBrowserFollowupHostedEntry",
    ),
    {
      URL,
      URLSearchParams,
      document,
      window,
      location: window.location,
      browserFollowupHostedOrigin: "http://127.0.0.1:4893",
    },
  );
}
const start = policy.indexOf("export function readBrowserFollowupWitness("),
  end = policy.indexOf("\nexport function projectBrowserFollowupCapture(", start);
if (start < 0 || end <= start) throw new Error("Actual browser follow-up public observer refused.");
function observe(scene: "hosted-pair-confirm" | "hosted-pair-incomplete") {
  const read = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(policy.slice(start, end)).replace(/^export /gm, "") +
      "\nreadBrowserFollowupWitness",
    {
      document,
      window,
      location: window.location,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollX: 0,
      scrollY: 0,
      URLSearchParams,
      HTMLButtonElement,
      HTMLElement,
      Reflect,
      getComputedStyle: (node: Element) => {
        const actual = window.getComputedStyle(node);
        return {
          display: actual.display || "block",
          visibility: actual.visibility || "visible",
          opacity: actual.opacity || "1",
          overflowX: actual.overflowX,
          overflowY: actual.overflowY,
        };
      },
    },
  );
  return read({
    scene,
    theme: "light",
    origin: "http://127.0.0.1:4893",
    environmentId: "local",
    threadId: "owned-thread",
    projectId: "owned-project",
    terminalId: "term-1",
    terminalLabel: "Terminal 1",
    environmentLabel: "Local",
    hostedHost: "127.0.0.1:4887",
  });
}
/** Inert layout harness only. Runtime capture uses browser geometry and hit tests with no replacements. */
function hostedLayout() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 960 });
  const section = document.querySelector("section")!;
  const rectangles = new Map<Element, DOMRect>();
  rectangles.set(section, new DOMRect(260, 120, 760, 680));
  let row = 0;
  for (const node of section.querySelectorAll("h1,p,span,button"))
    rectangles.set(node, new DOMRect(300, 180 + row++ * 70, 640, 40));
  for (const [node, rectangle] of rectangles)
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue(rectangle);
  vi.spyOn(document, "elementFromPoint").mockImplementation((x, y) => {
    const candidates = [...rectangles].filter(
      ([, box]) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
    );
    return candidates.at(-1)?.[0] ?? null;
  });
  return section;
}
function hostedUrl(value: string) {
  const api = window as unknown as { happyDOM: { setURL: (url: string) => void } };
  api.happyDOM.setURL(value);
  vi.stubEnv("VITE_HTTP_URL", "");
  vi.stubEnv("VITE_WS_URL", "");
  vi.stubEnv("VITE_HOSTED_APP_URL", "http://127.0.0.1:4893");
  vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");
}
it.each(["confirm", "incomplete"] as const)(
  "uses the real hosted %s surface and product scrub without automatic consent",
  async (mode) => {
    hostedUrl(
      "http://127.0.0.1:4893/pair?host=http%3A%2F%2F127.0.0.1%3A4887&label=Owned+hosted+backend" +
        (mode === "confirm" ? "#token=owned-unused-token" : ""),
    );
    const fetch = vi.fn(() => Promise.reject(new Error("Inert external protocol port refused.")));
    vi.stubGlobal("fetch", fetch);
    expect(isHostedStaticApp()).toBe(true);
    await render(<HostedPairingRouteSurface />);
    const section = hostedLayout();
    const scene = mode === "confirm" ? "hosted-pair-confirm" : "hosted-pair-incomplete";
    const value = observe(scene);
    expect(value).not.toBeNull();
    expect(Object.values(value)).not.toContain(false);
    expect(window.location.hash).toBe("");
    expect(fetch).not.toHaveBeenCalled();
    expect(section.querySelectorAll("input,textarea")).toHaveLength(0);
    if (mode === "confirm")
      expect(section.querySelector("button")?.textContent).toBe("Pair this backend");
    else expect(section.querySelector("button")).toBeNull();
    vi.spyOn(section, "getBoundingClientRect").mockReturnValue(new DOMRect(-1, 120, 760, 680));
    expect(observe(scene).targetInView).toBe(false);
  },
);
it("waits for the actual product-owned deferred scrub after its heading is already visible", async () => {
  hostedUrl("http://127.0.0.1:4893/settings/general");
  const replace = window.history.replaceState.bind(window.history);
  let productReplacements = 0;
  vi.spyOn(window.history, "replaceState").mockImplementation((data, unused, url) => {
    productReplacements++;
    // Delay the native platform operation requested by the actual product effect; no fixture URL erasure.
    setTimeout(() => replace(data, unused, url), 20);
  });
  const handles = ["original"];
  let current = "original",
    firstVerified = false,
    revoked = 0,
    polls = 0;
  const browser = {
    getWindowHandles: async () => [...handles],
    getWindowHandle: async () => current,
    newWindow: async () => {
      handles.push("created");
      current = "created";
      return { handle: "created" };
    },
    switchToWindow: async (handle: string) => {
      current = handle;
    },
    closeWindow: async () => {
      handles.splice(handles.indexOf(current), 1);
    },
    $$: () => ({ length: 1 }),
    $: (selector: string) => ({
      waitForDisplayed: async () => {
        if (selector === "h1") expect(document.querySelector("h1")).not.toBeNull();
      },
      waitForEnabled: async () => {},
      click: async () => {},
    }),
    url: async (entry: string) => {
      hostedUrl(entry);
      await render(<HostedPairingRouteSurface />);
      expect(document.querySelector("h1")?.textContent).toBe("Pair this backend");
      expect(window.location.hash).toContain("token=");
    },
    execute: async (read: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      read.name === "readBrowserFollowupHostedMode" ? isHostedStaticApp() : read(...args),
  };
  const owner = {
    until: async (predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 250;
      do {
        polls++;
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      } while (Date.now() < deadline);
      throw new Error("Inert hosted readiness bound reached");
    },
  };
  try {
    await actualHostedOwner()(
      {
        mode: "confirm",
        theme: "light",
        browser,
        owner,
        token: "owned-unused-token",
        verifyHostedBuild: async () => ({
          genuineHostedBuild: true,
          backendConfigAbsent: true,
          sameSourceMatched: true,
        }),
        verifyOwnedUnsubmittedLink: async () => {},
        revokeOwnedUnsubmittedLink: async () => {
          revoked++;
        },
        observeUnsafeCleanup: () => {},
      },
      async (scope: { verify: () => Promise<unknown> }) => {
        await scope.verify();
        firstVerified = true;
        expect(window.location.hash).toBe("");
      },
    );
    expect(firstVerified).toBe(true);
    expect(productReplacements).toBe(1);
    expect(polls).toBeGreaterThan(1);
    expect(revoked).toBe(1);
    expect(handles).toEqual(["original"]);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
});
it("keeps real upload progress, size, and public Cancel behavior at the staged fixture size", async () => {
  let cancellations = 0;
  const container = await render(
    <AttachmentUploadNotice
      progress={{
        attachmentCount: 1,
        fileName: "upload-browser-followup.png",
        phase: "uploading",
        sentBytes: 16 * 1024,
        totalBytes: 512 * 1024,
      }}
      onCancel={() => cancellations++}
    />,
  );
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Uploading 1 attachment — 16 of 512 KiB",
  );
  const cancel = container.querySelector("button")!;
  expect(cancel.disabled).toBe(false);
  await act(async () => cancel.click());
  expect(cancellations).toBe(1);
});
it("uses the real Source Control row entry and commit presentation before opening Diff", async () => {
  const opened: Array<{ path: string; area: unknown }> = [];
  const container = await render(
    <>
      <SourceControlChangesList
        files={[
          {
            path: "pierre-step5.ts",
            status: "modified",
            area: "unstaged",
            insertions: 3,
            deletions: 3,
          },
        ]}
        onToggle={() => {}}
        onOpenFile={(path, area) => opened.push({ path, area })}
        onStageFile={() => {}}
      />
      <SourceControlCommitRow
        commit={
          {
            sha: "a".repeat(40),
            shortSha: "aaaaaaa",
            subject: "Visual qualification baseline",
            authorName: "BiBCode UI Fixture",
            authoredAtMs: 1,
          } as VcsCommit
        }
        nowMs={2}
      />
    </>,
  );
  expect(container.textContent).toContain("Visual qualification baseline");
  expect(container.querySelector('[aria-label="Stage pierre-step5.ts"]')).not.toBeNull();
  const row = container.querySelector<HTMLButtonElement>('button[title="pierre-step5.ts"]')!;
  await act(async () => row.click());
  expect(opened).toEqual([{ path: "pierre-step5.ts", area: "unstaged" }]);
});
it("observes the real request callback at the unchanged threshold and clears only on its acknowledgement", async () => {
  resetRequestLatencyStateForTests();
  const container = await render(
    <div data-status-bar="">
      <SlowRequestsIndicator />
    </div>,
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await act(async () =>
    trackRpcRequestSent("owned-ack", {
      method: "server.getTraceDiagnostics",
      environmentId: "local",
    }),
  );
  await act(async () => vi.advanceTimersByTime(SLOW_RPC_ACK_THRESHOLD_MS - 1));
  expect(container.querySelector("button")).toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(container.querySelector("button")?.textContent).toBe("1 slow request");
  vi.useRealTimers();
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(document.body.textContent).toContain("Waiting more than 15 seconds for a response.");
  expect(document.body.textContent).toContain("server.getTraceDiagnostics ·");
  expect(document.querySelector("time[datetime]")).not.toBeNull();
  await act(async () => acknowledgeRpcRequest("owned-ack"));
  expect(container.querySelector("button")).toBeNull();
});
