// @effect-diagnostics nodeBuiltinImport:off - Execute the actual controller branch with inert, individually tested public/source ports.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import {
  OrchestrationThread,
  OrchestrationReadModel,
} from "../../../../packages/contracts/src/orchestration.ts";
import type { ProviderChatLossBinding } from "./release-visual-provider-chat-loss.ts";
import { expect, it } from "vite-plus/test";
import {
  qualifiedProviderChatScenes,
  projectProviderChatAssertion,
  type ProviderChatProducerInput,
} from "./release-visual-provider-chat-producer.ts";
const source = NodeFS.readFileSync(
  NodePath.resolve("apps/desktop/e2e/qualify-delivery-retry.ts"),
  "utf8",
);
const marker = '      } else if (config.selection === "release-visual-provider-chat") {';
const start = source.indexOf(marker, source.indexOf("      const baseline =")) + marker.length;
const end = source.indexOf(
  '      } else if (config.selection === "release-visual-cursor-question") {',
  start,
);
const body = NodeModule.stripTypeScriptTypes(source.slice(start, end));
const origin = "http://127.0.0.1:4885";
const workspace = {
  path: "/owned/managed",
  branch: "codex/delivery-retry-light",
  commonDirectory: "/owned/project/.git",
  threadId: "host",
};
const visualInput = {
  root: "/owned/light",
  project: "/owned/project",
  home: "/owned/home",
  git: "/owned/bin/git",
  branch: workspace.branch,
};
const descriptor = {
  environmentId: "local",
  bootId: "owned-boot",
  storageInstanceId: "owned-storage",
};
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const time = "2026-10-05T00:00:00.000Z";
function thread(id: string, provider: "codex" | "claudeAgent"): OrchestrationThread {
  return Schema.decodeUnknownSync(OrchestrationThread)({
    id,
    projectId: "project",
    title: "Owned",
    kind: id === "host" ? "workspace" : "panel",
    branch: workspace.branch,
    worktreePath: workspace.path,
    modelSelection: { instanceId: provider, model: provider === "codex" ? "gpt-5.4" : "opus" },
    runtimeMode: "full-access",
    latestTurn: {
      turnId: "baseline",
      state: "completed",
      requestedAt: time,
      startedAt: time,
      completedAt: time,
      assistantMessageId: null,
    },
    createdAt: time,
    updatedAt: time,
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [
      {
        turnId: "baseline",
        checkpointTurnCount: 1,
        checkpointRef: "refs/bibcode/checkpoints/host/turn/1",
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: time,
      },
    ],
    session: null,
  });
}
async function run(mode = "owned") {
  const calls: string[] = [],
    original = new Error("Inert owned source refusal.");
  const media = { kind: "provider-chat-media" };
  const binding: ProviderChatLossBinding = {
    host: thread("host", "claudeAgent"),
    target: thread("panel", "codex"),
  };
  const scope = { kind: "provider-chat-registered-managed-loss" };
  const snapshot: OrchestrationReadModel = Schema.decodeUnknownSync(OrchestrationReadModel)({
    snapshotSequence: 0,
    updatedAt: time,
    projects: [
      {
        id: "project",
        title: "Owned",
        workspaceRoot: visualInput.project,
        defaultModelSelection: null,
        scripts: [],
        createdAt: time,
        updatedAt: time,
        deletedAt: null,
      },
    ],
    threads: [binding.host, binding.target],
  });
  const browser = {};
  const execute = NodeVM.runInNewContext(
    "(async()=>{const captures=[],assertions=[];let providerChatFixtureSafeToDelete=true;" +
      body +
      "\nreturn {captures,assertions,providerChatFixtureSafeToDelete};})",
    {
      check: (value: unknown) => {
        if (!value) throw original;
      },
      providerSnapshot: async () => snapshot,
      providerMedia: media,
      providerDescriptor: descriptor,
      readOwnedGitProjectDescriptor: async () =>
        mode === "changed-server" ? { ...descriptor, bootId: "foreign" } : descriptor,
      context: {
        stateRoot: "/owned/state",
        projectPath: visualInput.project,
        providerInputLogPath: "/owned/input.jsonl",
      },
      config: { binary: "/owned/bibcode", fixture: "/owned", evidence: "/owned-evidence" },
      runRoot: visualInput.root,
      childEnv: { CI: "true" },
      workspace,
      visualInput,
      origin,
      theme: "light",
      browser,
      b: () => browser,
      capturedVisuals: new Set(),
      owner: {
        until: async (test: () => Promise<boolean>) => {
          if (!(await test())) throw original;
        },
        json: async () => ({ credential: "inert-owned-credential" }),
      },
      step: (phase: string) => calls.push(phase),
      write: () => calls.push("write"),
      fixtureAccessToken: async () => "inert-owned-token",
      withProviderChatPublicApi: async (
        args: { CI: string; accessToken: string },
        run: (api: object) => Promise<void>,
      ) => {
        expect(args).toMatchObject({ CI: "true", accessToken: "inert-owned-token" });
        await run({
          createAssetUrl: async (threadId: string) => {
            expect(threadId).toBe("host");
            return { relativeUrl: "/api/assets/swatch?s=owned" };
          },
        });
      },
      configureProviderChatMedia: async (
        value: object,
        url: object,
        fetchAsset: (url: string) => Promise<Buffer>,
      ) => {
        expect(value).toBe(media);
        expect(url).toEqual({ relativeUrl: "/api/assets/swatch?s=owned" });
        expect(await fetchAsset(origin + "/api/assets/swatch?s=owned")).toEqual(Buffer.alloc(64));
      },
      fetch: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(64).buffer }),
      Buffer,
      AbortSignal,
      bounded: async (value: Promise<unknown>) => value,
      readProviderChatInputs: (path: string) => {
        expect(path).toBe("/owned/input.jsonl");
        return [];
      },
      readOwnedDeliveryWorktree: (value: object) => {
        expect(value).toEqual(visualInput);
        return {
          path: workspace.path,
          branch: workspace.branch,
          commonDirectory: workspace.commonDirectory,
        };
      },
      verifyProviderChatMedia: (value: object) => expect(value).toBe(media),
      withOwnedCodexVisualOptionRefusal: async (
        args: { selection: string; fixtureRoot: string; runRoot: string; childEnv: object },
        run: () => Promise<void>,
      ) => {
        expect(args).toMatchObject({
          selection: "provider-chat-v1",
          fixtureRoot: "/owned",
          runRoot: "/owned/light",
          childEnv: { CI: "true" },
        });
        await run();
      },
      withProviderChatWorkspaceLoss: async (
        args: {
          worktree: object;
          readBinding: () => Promise<object>;
          observeUnsafeCleanup: () => void;
        },
        run: (scope: object) => Promise<void>,
      ) => {
        expect(args.worktree).toEqual(visualInput);
        expect(await args.readBinding()).toBe(binding);
        if (mode === "unsafe-loss") args.observeUnsafeCleanup();
        await run(scope);
      },
      readProviderChatWorkspaceLoss: (value: object, source: object) => {
        expect(value).toBe(scope);
        expect(source).toBe(binding);
        calls.push("loss-proof");
      },
      captureProviderChatScene: async (args: {
        scene: string;
        theme: string;
        threadId: string;
        branch: string;
        verifyOwnedIdentity: () => Promise<void>;
      }) => {
        expect(args).toMatchObject({ theme: "light", threadId: "host", branch: workspace.branch });
        await args.verifyOwnedIdentity();
        if (mode === "capture-failure") throw original;
        return { scene: args.scene };
      },
      runProviderChatVisual: async (args: ProviderChatProducerInput) => {
        expect(args.hostThreadId).toBe("host");
        await args.snapshot();
        args.verifyWorktree();
        args.verifyMedia(false);
        expect(args.readInputs()).toEqual([]);
        await args.withRefusedModel(async () => {});
        // Inert source values never leave the port; actual pair/schema checks have separate tests.
        await args.withManagedWorkspaceLoss(
          async () => binding,
          async (value) => args.verifyLoss(value, binding),
        );
        for (const scene of qualifiedProviderChatScenes)
          await args.capture(scene, async () => {
            await args.snapshot();
            args.verifyWorktree();
          });
        return projectProviderChatAssertion("light");
      },
    },
  ) as () => Promise<{
    captures: object[];
    assertions: object[];
    providerChatFixtureSafeToDelete: boolean;
  }>;
  return { execute, calls, original };
}
it("binds the actual seven-row controller caller to asset, source, capture and explicit loss owners", async () => {
  const f = await run();
  const result = await f.execute();
  expect(result.captures).toHaveLength(7);
  expect(result.assertions).toEqual([projectProviderChatAssertion("light")]);
  expect(result.providerChatFixtureSafeToDelete).toBe(true);
  expect(f.calls).toContain("loss-proof");
});
it.each(["changed-server", "capture-failure"])(
  "preserves the original bounded caller failure: %s",
  async (mode) => {
    const f = await run(mode);
    await expect(f.execute()).rejects.toBe(f.original);
  },
);
it("carries unsafe restoration into the actual controller receipt instead of deleting the fixture", async () => {
  const f = await run("unsafe-loss");
  expect((await f.execute()).providerChatFixtureSafeToDelete).toBe(false);
});
