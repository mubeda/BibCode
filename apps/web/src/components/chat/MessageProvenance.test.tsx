// @vitest-environment happy-dom

import { EnvironmentId, type SendRequestAction, ThreadId } from "@bibcode/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type AnyProps = Record<string, unknown>;

const shells = vi.hoisted(() => new Map<string, { title: string }>());
vi.mock("~/state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : (shells.get(ref.threadId) ?? null),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: AnyProps) => <>{props.children as ReactNode}</>,
  TooltipTrigger: (props: AnyProps) => {
    const render = props.render as { props: AnyProps } | undefined;
    return <span {...(render?.props ?? {})}>{props.children as ReactNode}</span>;
  },
  TooltipPopup: (props: AnyProps) => <div data-tooltip-popup>{props.children as ReactNode}</div>,
}));

import { MessageProvenance, personSendText, provenanceText } from "./MessageProvenance";

const environmentId = EnvironmentId.make("env-1");
const actor = { kind: "mcp-client" as const, clientId: "session-1", label: "Claude Code" };
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(node));
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  shells.clear();
});

describe("MessageProvenance", () => {
  describe("an agent message", () => {
    const hosted = { kind: "hosted-agent" as const, address: "thread:t1", label: "API refactor" };
    const renderHosted = (a: typeof hosted | undefined) =>
      render(
        <MessageProvenance actor={a} sourceThreadId={undefined} environmentId={environmentId} />,
      );

    it("shows the hosted chip for an agent message", async () => {
      const container = await renderHosted(hosted);
      const chips = container.querySelectorAll('[data-agent-chip="hosted-agent"]');
      expect(chips).toHaveLength(1);
      expect(chips[0]?.textContent).toBe("From agent · API refactor");
    });

    it("a person's message shows no chip", async () => {
      const container = await renderHosted(undefined);
      expect(container.querySelector("[data-agent-chip]")).toBeNull();
    });

    it("an outside agent keeps its own chip", async () => {
      const container = await render(
        <MessageProvenance
          actor={actor}
          sourceThreadId={undefined}
          environmentId={environmentId}
        />,
      );
      expect(container.querySelector("[data-agent-chip]")?.textContent).toBe("Agent · Claude Code");
    });

    it("a hosted agent message names no outside agent", async () => {
      const container = await renderHosted(hosted);
      expect(container.textContent).not.toContain("Agent · ");
    });
  });

  it("names the panel a message came from beside the agent chip", async () => {
    shells.set("panel-1", { title: "Review panel" });
    const container = await render(
      <MessageProvenance
        actor={actor}
        sourceThreadId={ThreadId.make("panel-1")}
        environmentId={environmentId}
      />,
    );
    expect(container.querySelector("[data-message-provenance]")?.textContent).toBe(
      "From Review panel",
    );
    expect(container.querySelector("[data-agent-chip]")?.textContent).toContain(
      "Agent · Claude Code",
    );
  });

  it("renders a title as text and says so when the source is gone", async () => {
    shells.set("panel-1", { title: "<img src=x onerror=alert(1)>" });
    const container = await render(
      <MessageProvenance
        actor={actor}
        sourceThreadId={ThreadId.make("panel-1")}
        environmentId={environmentId}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(provenanceText(undefined)).toBe("From another thread");
  });

  describe("a person's send", () => {
    const personSend = (action: SendRequestAction, sourceAddress = "thread:api") => ({
      requestId: "request-1",
      action,
      sourceAddress,
    });
    const label = async (
      action: SendRequestAction,
      sourceAddress?: string,
      extra: { actor?: typeof actor } = {},
    ) => {
      const container = await render(
        <MessageProvenance
          actor={extra.actor}
          sourceThreadId={undefined}
          environmentId={environmentId}
          personSend={personSend(action, sourceAddress)}
        />,
      );
      return container;
    };

    it('a person\'s Review reads "Review, sent from API refactor"', async () => {
      shells.set("api", { title: "API refactor" });
      const container = await label("review");
      expect(container.querySelector("[data-message-provenance]")?.textContent).toBe(
        "Review, sent from API refactor",
      );
    });

    it("shows no agent chip for a person's send, even when an actor is also present", async () => {
      shells.set("api", { title: "API refactor" });
      const container = await label("review", undefined, { actor });
      expect(container.querySelector("[data-agent-chip]")).toBeNull();
      expect(container.querySelector("[data-message-provenance]")).not.toBeNull();
    });

    it('Take over from reads "Take over from API refactor"', async () => {
      shells.set("api", { title: "API refactor" });
      const container = await label("take-over");
      expect(container.textContent).toBe("Take over from API refactor");
    });

    it('Second opinion, Hand off and Message read "{Action}, sent from {title}"', async () => {
      shells.set("api", { title: "API refactor" });
      expect((await label("second-opinion")).textContent).toBe(
        "Second opinion, sent from API refactor",
      );
      expect((await label("hand-off")).textContent).toBe("Hand off, sent from API refactor");
      expect((await label("message")).textContent).toBe("Message, sent from API refactor");
    });

    it('a source this client no longer has reads "Review, sent from another thread"', async () => {
      expect((await label("review", "thread:gone")).textContent).toBe(
        "Review, sent from another thread",
      );
    });

    it('a terminal source reads "Second opinion, sent from a terminal in API refactor"', async () => {
      shells.set("api", { title: "API refactor" });
      expect((await label("second-opinion", "terminal:api/t1")).textContent).toBe(
        "Second opinion, sent from a terminal in API refactor",
      );
    });

    it("a title is rendered as text", async () => {
      shells.set("api", { title: "<img src=x onerror=alert(1)>" });
      const container = await label("message");
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    });

    it("personSendText names the action and the source", () => {
      expect(personSendText({ action: "review", sourceTitle: "  ", sourceKind: "thread" })).toBe(
        "Review, sent from another thread",
      );
    });
  });

  it("a message with no actor, source or personSend renders nothing", async () => {
    const container = await render(
      <MessageProvenance
        actor={undefined}
        sourceThreadId={undefined}
        environmentId={environmentId}
        personSend={undefined}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows only the chip for an agent's message without a source, and nothing for a person's", async () => {
    const agentOnly = await render(
      <MessageProvenance actor={actor} sourceThreadId={undefined} environmentId={environmentId} />,
    );
    expect(agentOnly.querySelector("[data-message-provenance]")).toBeNull();
    expect(agentOnly.querySelector("[data-agent-chip]")).not.toBeNull();
    const person = await render(
      <MessageProvenance
        actor={undefined}
        sourceThreadId={undefined}
        environmentId={environmentId}
      />,
    );
    expect(person.innerHTML).toBe("");
  });
});
