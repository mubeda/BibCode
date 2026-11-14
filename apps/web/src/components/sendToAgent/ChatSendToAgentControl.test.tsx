// @vitest-environment happy-dom

import { EnvironmentId, ProjectId, ThreadId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  shell: null as Record<string, unknown> | null,
  messages: [] as unknown[],
  buttonProps: [] as Array<Record<string, unknown>>,
  send: vi.fn(),
}));

vi.mock("~/state/entities", () => ({
  useThreadShell: () => h.shell,
  useThreadMessages: () => h.messages,
  useProjects: () => [{ id: "project-a", workspaceRoot: "/repo/a" }],
}));
vi.mock("~/state/sendRequests", () => ({ useSendRequest: () => h.send }));
vi.mock("../agents/useAgentRows", () => ({ useAgentRows: () => [] }));
vi.mock("./SendToAgentButton", () => ({
  SendToAgentButton: (props: Record<string, unknown>) => {
    h.buttonProps.push(props);
    return <span data-send-to-agent />;
  },
}));

import { ChatSendToAgentControl } from "./ChatSendToAgentControl";

const threadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("panel-1"),
};
const createPanel = vi.fn();
const previewContentFor = vi.fn();

let root: Root;
let container: HTMLDivElement;

function render(serverSupported = true) {
  act(() =>
    root.render(
      <ChatSendToAgentControl
        threadRef={threadRef}
        serverSupported={serverSupported}
        newPanelProviders={[]}
        createPanel={createPanel}
        previewContentFor={previewContentFor}
      />,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.buttonProps.length = 0;
  h.shell = {
    projectId: ProjectId.make("project-a"),
    title: "API refactor",
    worktreePath: null,
  };
  h.messages = [{ id: "m1", role: "assistant", text: "Done.", streaming: false }];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ChatSendToAgentControl", () => {
  it("builds the source from the panel's shell and messages and hands the sender on", () => {
    render();
    const props = h.buttonProps.at(-1)!;
    expect(props["source"]).toMatchObject({
      environmentId: "environment-a",
      threadId: "panel-1",
      terminalId: null,
      projectId: "project-a",
      title: "API refactor",
      checkout: "/repo/a",
      messages: h.messages,
      terminalHasText: false,
    });
    expect(props["send"]).toBe(h.send);
    expect(props["createPanel"]).toBe(createPanel);
    expect(props["serverSupported"]).toBe(true);
  });

  it("uses the panel's worktree as its checkout", () => {
    h.shell = { ...h.shell, worktreePath: "/repo/a-worktree" };
    render();
    expect(h.buttonProps.at(-1)!["source"]).toMatchObject({ checkout: "/repo/a-worktree" });
  });

  it("renders nothing until the panel's shell is known", () => {
    h.shell = null;
    render();
    expect(container.querySelector("[data-send-to-agent]")).toBeNull();
  });

  it("passes the missing capability on, so the button can say why it is off", () => {
    render(false);
    expect(h.buttonProps.at(-1)!["serverSupported"]).toBe(false);
  });
});
