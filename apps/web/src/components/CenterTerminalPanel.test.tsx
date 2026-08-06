import { EnvironmentId, ProjectId, ThreadId } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  panelProps: null as Record<string, unknown> | null,
}));

vi.mock("~/state/entities", () => ({
  useThread: () => ({
    environmentId: EnvironmentId.make("environment-1"),
    projectId: ProjectId.make("project-1"),
    worktreePath: "/repo/.bibcode/worktrees/feature",
  }),
  useProject: () => ({ workspaceRoot: "/repo" }),
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (selector: (state: { getDraftThreadByRef: () => null }) => unknown) =>
    selector({ getDraftThreadByRef: () => null }),
}));
vi.mock("~/state/terminalSessions", () => ({
  useKnownTerminalSessions: () => [
    {
      target: { terminalId: "term-1" },
      state: {
        summary: {
          cwd: "/repo/.bibcode/worktrees/stale",
          worktreePath: "/repo/.bibcode/worktrees/stale",
          label: "stale process",
        },
      },
    },
  ],
}));
vi.mock("@bibcode/shared/projectScripts", () => ({
  projectScriptCwd: ({ worktreePath }: { worktreePath: string | null }) => worktreePath ?? "/repo",
  projectScriptRuntimeEnv: () => ({ BIBCODE_PROJECT_ROOT: "/repo" }),
}));
vi.mock("./ThreadTerminalPanel", () => ({
  default: (props: Record<string, unknown>) => {
    h.panelProps = props;
    return <div data-terminal-panel />;
  },
}));

import { CenterTerminalPanel } from "./CenterTerminalPanel";

beforeEach(() => {
  h.panelProps = null;
});

describe("CenterTerminalPanel", () => {
  it("uses the host worktree and forwards the provider command", () => {
    const onClose = vi.fn();
    const surface = {
      id: "terminal:term-1",
      kind: "terminal",
      terminalId: "term-1",
      label: "Codex Terminal",
      command: {
        executable: "/opt/codex",
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        label: "Codex Terminal",
      },
    } as const;
    renderToStaticMarkup(
      <CenterTerminalPanel
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        projectId={ProjectId.make("project-1")}
        surface={surface}
        launchContext={{
          cwd: "/repo/.bibcode/worktrees/feature",
          worktreePath: "/repo/.bibcode/worktrees/feature",
          runtimeEnv: { BIBCODE_PROJECT_ROOT: "/repo" },
        }}
        keybindings={{} as never}
        focusRequestId={1}
        onAddTerminalContext={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(h.panelProps).toMatchObject({
      owner: "center-panel",
      projectId: ProjectId.make("project-1"),
      cwd: "/repo/.bibcode/worktrees/feature",
      worktreePath: "/repo/.bibcode/worktrees/feature",
      terminalIds: ["term-1"],
      activeTerminalId: "term-1",
      terminalGroups: [{ id: "terminal:term-1", terminalIds: ["term-1"] }],
    });
    expect(h.panelProps?.["onSplitTerminal"]).toBeUndefined();
    expect(h.panelProps?.["onSplitTerminalVertical"]).toBeUndefined();
    expect(h.panelProps?.["onCloseTerminal"]).toBe(onClose);
    expect(
      (h.panelProps!["terminalCommandsById"] as ReadonlyMap<string, unknown>).get("term-1"),
    ).toEqual(surface.command);
    expect((h.panelProps!["terminalLabelsById"] as ReadonlyMap<string, string>).get("term-1")).toBe(
      "Codex Terminal",
    );
  });

  it("does not mount an attach layer without a resolved live-thread launch context", () => {
    renderToStaticMarkup(
      <CenterTerminalPanel
        threadRef={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
        }}
        projectId={ProjectId.make("project-1")}
        surface={{
          id: "terminal:term-1",
          kind: "terminal",
          terminalId: "term-1",
        }}
        launchContext={null}
        keybindings={{} as never}
        focusRequestId={1}
        onAddTerminalContext={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(h.panelProps).toBeNull();
  });
});
