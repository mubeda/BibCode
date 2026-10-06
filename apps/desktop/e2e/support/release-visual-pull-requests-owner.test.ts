// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - The genuine decoded snapshot and serialized read use inert public ports.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { GitProjectVisualSelection } from "./release-visual-git-project.ts";
const modulePath = "./release-visual-pull-requests-owner.ts";
const api = await import(modulePath).catch((error: unknown) => {
  if (NodeFS.existsSync(new URL(modulePath, import.meta.url))) throw error;
  return {};
});
const Schema = NodeModule.createRequire(NodePath.resolve("packages/contracts/package.json"))(
  "effect/Schema",
);
function snapshot(provider = "github") {
  const timestamp = "2026-10-06T00:00:00.000Z";
  return Schema.decodeUnknownSync(OrchestrationReadModel)({
    snapshotSequence: 0,
    updatedAt: timestamp,
    projects: [
      {
        id: "owned-project-" + provider,
        title: provider,
        workspaceRoot: "/owned/light/requests/" + provider,
        defaultModelSelection: null,
        scripts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
        repositoryIdentity: {
          canonicalKey: provider + ".visual.invalid/owned/requests",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://" + provider + ".visual.invalid/owned/requests.git",
          },
          rootPath: "/owned/light/requests/" + provider,
          displayName: "requests",
          owner: "owned",
          name: "requests",
        },
      },
    ],
    threads: [
      {
        id: "owned-thread-" + provider,
        projectId: "owned-project-" + provider,
        title: provider,
        kind: "default",
        modelSelection: { instanceId: "claude", model: "claude-opus-4-6" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        session: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
        messages: [],
        activities: [],
        checkpoints: [],
      },
    ],
  });
}
function probe(mode = "ordinary") {
  let provider = "github",
    current = snapshot(),
    selected: GitProjectVisualSelection | null = null;
  const calls: string[] = [];
  const create = Reflect.get(api, "createPullRequestsOwnerAdapters");
  if (typeof create !== "function") throw new Error("Missing public request owner.");
  const input = {
    origin: "http://127.0.0.1:4885",
    fixture: {
      projects: {
        github: { cwd: "/owned/light/requests/github" },
        gitlab: { cwd: "/owned/light/requests/gitlab" },
      },
    },
    importProject: async (cwd: string, bind?: () => Promise<GitProjectVisualSelection>) => {
      calls.push("import");
      provider = NodePath.basename(cwd);
      current = snapshot(provider);
      if (mode === "missing-callback") return;
      selected = await bind!();
      if (mode === "double-callback") await bind!();
      calls.push("model-selection");
    },
    readSnapshot: async () => {
      calls.push("snapshot");
      if (mode === "duplicate-project")
        return { ...current, projects: [...current.projects, ...current.projects] };
      if (mode === "foreign-identity")
        return {
          ...current,
          projects: current.projects.map((p: object) => ({
            ...p,
            repositoryIdentity: { canonicalKey: "foreign/requests" },
          })),
        };
      if (mode === "missing-identity")
        return {
          ...current,
          projects: current.projects.map((p: object) => ({ ...p, repositoryIdentity: null })),
        };
      if (mode === "duplicate-thread")
        return { ...current, threads: [...current.threads, ...current.threads] };
      if (mode === "foreign-root")
        return {
          ...current,
          projects: current.projects.map((p: { workspaceRoot: string }) => ({
            ...p,
            workspaceRoot: "/foreign",
          })),
        };
      if (mode === "workspace-thread")
        return {
          ...current,
          threads: current.threads.map((t: object) => ({ ...t, kind: "workspace" })),
        };
      if (mode === "started-thread")
        return {
          ...current,
          threads: current.threads.map((t: object) => ({ ...t, latestTurn: { id: "foreign" } })),
        };
      return current;
    },
    verifyServer: async () => {
      calls.push("server");
    },
    verifySource: async (host: string, selection: GitProjectVisualSelection) => {
      calls.push("source");
      expect(host).toBe(provider);
      expect(selection.cwd).toBe("/owned/light/requests/" + provider);
      if (mode === "source-refused") throw new Error("Inert source refusal.");
    },
    owner: {
      until: async (read: () => Promise<boolean>) => {
        if (!(await read())) throw new Error("Inert bounded public admission refusal.");
      },
    },
    browser: {
      $: (selector: string) => ({
        waitForExist: async () => {
          calls.push(selector);
        },
        waitForDisplayed: async () => {},
        waitForEnabled: async () => {},
        isFocused: async () => true,
        click: async () => {
          calls.push(selector);
        },
      }),
      $$: () => ({ length: Promise.resolve(mode === "duplicate-control" ? 2 : 1) }),
      keys: async (key: string) => {
        calls.push("key-" + key);
      },
      execute: async (_read: unknown, value: { target: string }) => {
        calls.push("dom-" + value.target);
        return mode !== "wrong-route";
      },
    },
  };
  return {
    adapter: create(input),
    calls,
    input,
    get selected() {
      return selected;
    },
    stale: () => {
      current = {
        ...current,
        threads: current.threads.map((thread: object) => ({ ...thread, id: "reused-thread" })),
      };
    },
  };
}
it.each(["github", "gitlab"])(
  "binds the genuine public imported project and navigates Requests: %s",
  async (provider) => {
    const p = probe();
    const selection = await p.adapter.openRequests(provider);
    expect(selection.cwd).toBe("/owned/light/requests/" + provider);
    expect(selection).toBe(p.selected);
    expect(p.calls.indexOf("source")).toBeLessThan(p.calls.indexOf("model-selection"));
    expect(p.calls).toContain('[data-testid="primary-card-button-owned-project-' + provider + '"]');
    expect(p.calls).toContain(
      'button[data-testid="pull-requests-button"][aria-label="Pull Requests for ' + provider + '"]',
    );
    expect(p.calls.at(-1)).toBe("dom-list");
    await p.adapter.openRequests(provider);
    expect(p.calls.filter((call) => call === "import")).toHaveLength(1);
  },
);
it.each([
  "missing-callback",
  "double-callback",
  "duplicate-project",
  "duplicate-thread",
  "foreign-root",
  "workspace-thread",
  "started-thread",
  "source-refused",
  "duplicate-control",
  "wrong-route",
  "foreign-identity",
  "missing-identity",
])("refuses the actual public ownership boundary: %s", async (mode) => {
  const p = probe(mode);
  await expect(p.adapter.openRequests("github")).rejects.toThrow();
});
it("rejects a copied selection and a reused thread before subsequent DOM admission", async () => {
  const p = probe();
  const selection = await p.adapter.openRequests("github");
  await expect(p.adapter.verifyOwnedIdentity({ ...selection })).rejects.toThrow();
  const count = p.calls.filter((call) => call.startsWith("dom-")).length;
  p.stale();
  await expect(p.adapter.verifyOwnedIdentity(selection)).rejects.toThrow();
  expect(p.calls.filter((call) => call.startsWith("dom-"))).toHaveLength(count);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it("executes the serialized public route/header read and refuses wrong host or project", () => {
  const read = Reflect.get(api, "readPullRequestsProjectSelection");
  expect(typeof read).toBe("function");
  vi.stubGlobal("location", {
    origin: "http://127.0.0.1:4885",
    pathname: "/project/local/owned-project-github/pull-requests/43",
    search: "?tab=files",
    hash: "",
  });
  const selection = {
    projectId: "owned-project-github",
    threadId: "owned-thread-github",
    environmentId: "local",
    cwd: "/owned/light/requests/github",
    title: "github",
    branch: "visual-request",
  };
  document.body.innerHTML =
    '<button data-testid="primary-card-button-owned-project-github"></button><div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div><button data-testid="pull-requests-button" aria-label="Pull Requests for github"></button><section aria-label="Pull Requests"><header><div><p>owned/requests</p><p>github.visual.invalid · viewer</p></div></header></section>';
  for (const element of document.querySelectorAll("button,section"))
    element.getBoundingClientRect = () => ({
      x: 1,
      y: 1,
      width: 100,
      height: 30,
      right: 101,
      bottom: 31,
      top: 1,
      left: 1,
      toJSON: () => ({}),
    });
  const input = { origin: "http://127.0.0.1:4885", provider: "github", selection, target: "any" };
  expect(read(input)).toBe(true);
  expect(read({ ...input, target: "list" })).toBe(false);
  document.querySelector("header p:last-child")!.textContent = "gitlab.visual.invalid · viewer";
  expect(read(input)).toBe(false);
  document.querySelector("header p:last-child")!.textContent = "github.visual.invalid · viewer";
  vi.stubGlobal("location", {
    origin: input.origin,
    pathname: "/project/local/foreign/pull-requests/43",
    search: "?tab=files",
    hash: "",
  });
  expect(read(input)).toBe(false);
});
