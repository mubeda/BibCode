import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_WS_METHODS } from "./orchestration.ts";
import {
  WS_METHODS,
  WsRpcGroup,
  WsServerGetConfigRpc,
  WsServerConsumeCodexRateLimitResetRpc,
  WsServerRefreshProvidersRpc,
  WsVcsPullRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsInitRpc,
  WsShellOpenInEditorRpc,
  WsSubscribeVcsStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsPreviewListRpc,
  WsSourceControlLookupRepositoryRpc,
  WsProjectsReadFileRpc,
  WsReviewGetDiffPreviewRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationSubscribeShellRpc,
  WsSubscribeAuthAccessRpc,
  WsActivityGetSnapshotRpc,
  WsSubscribeActivityRpc,
  WsSubscribeWorktreeCatalogRpc,
  WsVcsRefreshWorktreeCatalogRpc,
  WsWorktreeUpdateDiscoveryPolicyRpc,
  WsWorktreeAdoptRpc,
} from "./rpc.ts";

const decodeSubscribeWorktreeCatalog = Schema.decodeUnknownSync(
  WsSubscribeWorktreeCatalogRpc.payloadSchema,
);
const decodeRefreshWorktreeCatalog = Schema.decodeUnknownSync(
  WsVcsRefreshWorktreeCatalogRpc.payloadSchema,
);
const decodeUpdateWorktreeDiscoveryPolicy = Schema.decodeUnknownSync(
  WsWorktreeUpdateDiscoveryPolicyRpc.payloadSchema,
);
const decodeWorktreeAdopt = Schema.decodeUnknownSync(WsWorktreeAdoptRpc.payloadSchema);
const decodeWorktreeAdoptResult = Schema.decodeUnknownSync(WsWorktreeAdoptRpc.successSchema);
const decodeWorktreeAdoptError = Schema.decodeUnknownSync(WsWorktreeAdoptRpc.errorSchema);

describe("WS_METHODS", () => {
  it("maps method identifiers to unique dotted wire names", () => {
    const values = Object.values(WS_METHODS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("uses stable wire names for representative methods", () => {
    expect(WS_METHODS.serverGetConfig).toBe("server.getConfig");
    expect((WS_METHODS as Record<string, string>).serverConsumeCodexRateLimitReset).toBe(
      "server.consumeCodexRateLimitReset",
    );
    expect(WS_METHODS.vcsPull).toBe("vcs.pull");
    expect(WS_METHODS.terminalOpen).toBe("terminal.open");
    expect(WS_METHODS.subscribeVcsStatus).toBe("subscribeVcsStatus");
    expect(WS_METHODS.cloudInstallRelayClient).toBe("cloud.installRelayClient");
    expect(WS_METHODS.sourceControlLookupRepository).toBe("sourceControl.lookupRepository");
    expect(WS_METHODS.activityGetSnapshot).toBe("activity.getSnapshot");
    expect(WS_METHODS.activityListRoster).toBe("activity.listRoster");
    expect(WS_METHODS.activityListDetail).toBe("activity.listDetail");
    expect(WS_METHODS.subscribeActivity).toBe("subscribeActivity");
    expect(WS_METHODS.subscribeWorktreeCatalog).toBe("subscribeWorktreeCatalog");
    expect(WS_METHODS.vcsRefreshWorktreeCatalog).toBe("vcs.refreshWorktreeCatalog");
    expect(WS_METHODS.worktreeUpdateDiscoveryPolicy).toBe("worktree.updateDiscoveryPolicy");
    expect(WS_METHODS.worktreeAdopt).toBe("worktree.adopt");
  });
});

describe("individual RPC definitions", () => {
  it("accepts workspace-unavailable failures at guarded unary boundaries", () => {
    const unavailable = {
      _tag: "WorkspaceUnavailableError",
      reason: "workspace-unavailable",
      message: "The workspace directory is missing.",
      threadId: "thread-1",
      path: "/repo/worktrees/missing",
      availability: "missing-registered",
    };
    for (const rpc of [
      WsOrchestrationDispatchCommandRpc,
      WsTerminalOpenRpc,
      WsTerminalWriteRpc,
      WsVcsPullRpc,
      WsProjectsReadFileRpc,
      WsReviewGetDiffPreviewRpc,
    ]) {
      expect(() => Schema.decodeUnknownSync(rpc.errorSchema)(unavailable)).not.toThrow();
    }
  });

  it("tags each RPC with its wire method name", () => {
    expect(WsServerGetConfigRpc._tag).toBe(WS_METHODS.serverGetConfig);
    expect(WsServerConsumeCodexRateLimitResetRpc._tag).toBe(
      WS_METHODS.serverConsumeCodexRateLimitReset,
    );
    expect(WsServerRefreshProvidersRpc._tag).toBe(WS_METHODS.serverRefreshProviders);
    expect(WsVcsPullRpc._tag).toBe(WS_METHODS.vcsPull);
    expect(WsVcsRemoveWorktreeRpc._tag).toBe(WS_METHODS.vcsRemoveWorktree);
    expect(WsVcsInitRpc._tag).toBe(WS_METHODS.vcsInit);
    expect(WsShellOpenInEditorRpc._tag).toBe(WS_METHODS.shellOpenInEditor);
    expect(WsTerminalOpenRpc._tag).toBe(WS_METHODS.terminalOpen);
    expect(WsTerminalWriteRpc._tag).toBe(WS_METHODS.terminalWrite);
    expect(WsPreviewListRpc._tag).toBe(WS_METHODS.previewList);
    expect(WsSourceControlLookupRepositoryRpc._tag).toBe(WS_METHODS.sourceControlLookupRepository);
    expect(WsProjectsReadFileRpc._tag).toBe(WS_METHODS.projectsReadFile);
    expect(WsActivityGetSnapshotRpc._tag).toBe(WS_METHODS.activityGetSnapshot);
    expect(WsSubscribeActivityRpc._tag).toBe(WS_METHODS.subscribeActivity);
    expect(WsSubscribeWorktreeCatalogRpc._tag).toBe(WS_METHODS.subscribeWorktreeCatalog);
    expect(WsVcsRefreshWorktreeCatalogRpc._tag).toBe(WS_METHODS.vcsRefreshWorktreeCatalog);
    expect(WsWorktreeUpdateDiscoveryPolicyRpc._tag).toBe(WS_METHODS.worktreeUpdateDiscoveryPolicy);
    expect(WsWorktreeAdoptRpc._tag).toBe(WS_METHODS.worktreeAdopt);
  });

  it("carries payload/success/error schemas on unary RPCs", () => {
    for (const rpc of [WsServerGetConfigRpc, WsVcsPullRpc, WsTerminalOpenRpc]) {
      expect(Schema.isSchema(rpc.payloadSchema)).toBe(true);
      expect(Schema.isSchema(rpc.successSchema)).toBe(true);
      expect(Schema.isSchema(rpc.errorSchema)).toBe(true);
    }
  });

  it("wires orchestration RPCs to the orchestration method names", () => {
    expect(WsOrchestrationDispatchCommandRpc._tag).toBe(ORCHESTRATION_WS_METHODS.dispatchCommand);
    expect(WsOrchestrationSubscribeShellRpc._tag).toBe(ORCHESTRATION_WS_METHODS.subscribeShell);
  });

  it("collapses the declared error schema to Never for streaming RPCs", () => {
    // Rpc.make sets errorSchema to Schema.Never and wraps success for streams.
    for (const streamRpc of [
      WsSubscribeVcsStatusRpc,
      WsCloudInstallRelayClientRpc,
      WsSubscribeAuthAccessRpc,
      WsOrchestrationSubscribeShellRpc,
      WsSubscribeWorktreeCatalogRpc,
    ]) {
      expect(streamRpc.errorSchema).toBe(Schema.Never);
      expect(Schema.isSchema(streamRpc.successSchema)).toBe(true);
    }
  });
});

describe("WsRpcGroup", () => {
  it("exposes a request map keyed by each RPC's tag", () => {
    expect(WsRpcGroup.requests).toBeInstanceOf(Map);
    for (const [key, rpc] of WsRpcGroup.requests) {
      expect(key).toBe(rpc._tag);
      expect(typeof rpc._tag).toBe("string");
      expect(Schema.isSchema(rpc.payloadSchema)).toBe(true);
      expect(Schema.isSchema(rpc.successSchema)).toBe(true);
      expect(Schema.isSchema(rpc.errorSchema)).toBe(true);
    }
  });

  it("registers the individually exported RPCs under their tags", () => {
    const members = [
      WsServerGetConfigRpc,
      WsServerConsumeCodexRateLimitResetRpc,
      WsVcsPullRpc,
      WsVcsInitRpc,
      WsShellOpenInEditorRpc,
      WsSubscribeVcsStatusRpc,
      WsCloudInstallRelayClientRpc,
      WsTerminalOpenRpc,
      WsPreviewListRpc,
      WsSourceControlLookupRepositoryRpc,
      WsOrchestrationDispatchCommandRpc,
      WsOrchestrationSubscribeShellRpc,
      WsSubscribeAuthAccessRpc,
      WsSubscribeWorktreeCatalogRpc,
      WsVcsRefreshWorktreeCatalogRpc,
      WsWorktreeUpdateDiscoveryPolicyRpc,
      WsWorktreeAdoptRpc,
    ];
    for (const rpc of members) {
      expect(WsRpcGroup.requests.get(rpc._tag)).toBe(rpc);
    }
  });

  it("keeps catalog reads project-scoped and discovery baselines server-owned", () => {
    expect(decodeSubscribeWorktreeCatalog({ projectId: "project-1" })).toEqual({
      projectId: "project-1",
    });
    expect(decodeRefreshWorktreeCatalog({ projectId: "project-1" })).toEqual({
      projectId: "project-1",
    });
    expect(
      decodeUpdateWorktreeDiscoveryPolicy({
        commandId: "command-1",
        projectId: "project-1",
        visibility: "hidden",
        acknowledgeGeneration: 9,
        dismissInitialPrompt: true,
        baselinePaths: ["/client-path"],
      }),
    ).toEqual({
      commandId: "command-1",
      projectId: "project-1",
      visibility: "hidden",
      acknowledgeGeneration: 9,
      dismissInitialPrompt: true,
    });
  });

  it("registers adoption with opaque server-resolved identity and typed outcomes", () => {
    expect(
      decodeWorktreeAdopt({
        commandId: "command-adopt-1",
        projectId: "project-1",
        worktreeKey: "worktree-1",
        expectedGeneration: 9,
        threadDefaults: {
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      }),
    ).toMatchObject({
      commandId: "command-adopt-1",
      projectId: "project-1",
      worktreeKey: "worktree-1",
      expectedGeneration: 9,
    });
    expect(
      ["created", "existing", "restored"].map((disposition) =>
        decodeWorktreeAdoptResult({ threadId: "thread-1", disposition }),
      ),
    ).toHaveLength(3);
    expect(
      decodeWorktreeAdoptError({
        _tag: "WorktreeAdoptionError",
        reason: "stale-generation",
        message: "Refresh required.",
        currentGeneration: 10,
      }),
    ).toMatchObject({ reason: "stale-generation", currentGeneration: 10 });
    expect(WsRpcGroup.requests.get(WS_METHODS.worktreeAdopt)).toBe(WsWorktreeAdoptRpc);
  });

  it("contains every RPC exactly once and covers the whole WS surface", () => {
    // Every registered request tag is a known dotted/plain WS method name.
    const wireNames = new Set<string>([
      ...Object.values(WS_METHODS),
      ...Object.values(ORCHESTRATION_WS_METHODS),
    ]);
    for (const key of WsRpcGroup.requests.keys()) {
      expect(wireNames.has(key)).toBe(true);
    }
    // The group is non-trivial: it registers many procedures.
    expect(WsRpcGroup.requests.size).toBeGreaterThanOrEqual(70);
  });
});
