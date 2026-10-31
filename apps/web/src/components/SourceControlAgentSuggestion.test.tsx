// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type UiCommitMessageIntent,
  type UiIntent,
} from "@bibcode/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/uiIntents", () => ({
  uiIntentsEnvironment: {
    intents: (target: { environmentId: string }) => `intents:${target.environmentId}`,
  },
}));

import { sourceControlDraftKey, useSourceControlDraft } from "~/sourceControlDraft";
import { useSourceControlPanelStore } from "~/sourceControlPanelStore";

import { SourceControlAgentSuggestion } from "./SourceControlAgentSuggestion";

const environmentId = EnvironmentId.make("env-1");
const CWD = "/work/repo";
const CWD_KEY = sourceControlDraftKey({ environmentId, cwd: CWD });

/** A registry that keeps each atom's last value and gives it to a late subscriber at once. */
function fakeRegistry() {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const values = new Map<string, unknown>();
  return {
    subscribe(atom: string, f: (value: unknown) => void, options?: { immediate?: boolean }) {
      if (options?.immediate) f(values.get(atom) ?? AsyncResult.initial());
      const set = listeners.get(atom) ?? new Set();
      set.add(f);
      listeners.set(atom, set);
      return () => set.delete(f);
    },
    emit(atom: string, value: unknown) {
      values.set(atom, value);
      for (const f of listeners.get(atom) ?? []) f(value);
    },
  };
}

let sequence = 0;
function suggestion(overrides: Partial<UiCommitMessageIntent> = {}): UiCommitMessageIntent {
  sequence += 1;
  return {
    kind: "commitMessage",
    intentId: `intent-${sequence}`,
    threadId: ThreadId.make("thread-1"),
    cwd: CWD,
    message: "Fix the parser\n\nIt skipped the last line.",
    actor: { kind: "mcp-client", clientId: "session-1", label: "Claude Code" },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

/** The message box and the suggestion, as the Source Control panel lays them out. */
function Panel(props: { readonly cwd: string }) {
  const draft = useSourceControlDraft({ environmentId, cwd: props.cwd });
  return (
    <>
      <textarea
        aria-label="Commit message"
        value={draft.message}
        onChange={(event) => draft.setMessage(event.target.value)}
      />
      <SourceControlAgentSuggestion
        environmentId={environmentId}
        cwd={props.cwd}
        draftMessage={draft.message}
      />
    </>
  );
}

const roots: ReturnType<typeof createRoot>[] = [];
let container: HTMLDivElement;
async function mount(registry: ReturnType<typeof fakeRegistry>, cwd = CWD) {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry as never}>
        <Panel cwd={cwd} />
      </RegistryContext.Provider>,
    ),
  );
}

const emit = (registry: ReturnType<typeof fakeRegistry>, intents: UiIntent[]) =>
  act(async () => registry.emit(`intents:${environmentId}`, AsyncResult.success(intents)));

const textarea = () => container.querySelector("textarea")!;
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === name);
const click = (name: string) =>
  act(async () => {
    button(name)!.click();
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useSourceControlPanelStore.setState({ byCwdKey: {}, agentSuggestionByCwdKey: {} });
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("SourceControlAgentSuggestion", () => {
  it("fills an empty draft and says which agent wrote it", async () => {
    const registry = fakeRegistry();
    await mount(registry);
    expect(container.textContent).not.toContain("Message from");
    await emit(registry, [suggestion()]);
    expect(textarea().value).toBe("Fix the parser\n\nIt skipped the last line.");
    expect(container.textContent).toContain("Message from Agent Claude Code");
    expect(button("Use it")).toBeUndefined();
  });

  it("keeps what the person typed and offers the suggestion to use or dismiss", async () => {
    const registry = fakeRegistry();
    useSourceControlPanelStore.getState().setCwdMessage(CWD_KEY, "my own words");
    await mount(registry);
    const offered = suggestion({ actor: { kind: "mcp-client", clientId: "s", label: null } });
    await emit(registry, [offered]);
    expect(textarea().value).toBe("my own words");
    expect(container.textContent).toContain("An agent suggested a message");
    expect(container.textContent).toContain("“Fix the parser”");

    await click("Use it");
    expect(textarea().value).toBe(offered.message);
    expect(container.textContent).toContain("Message from an agent");
    expect(button("Use it")).toBeUndefined();

    // A misclick is undone, and the person's words come back.
    await click("Undo");
    expect(textarea().value).toBe("my own words");
    expect(container.textContent).not.toContain("Message from");
    expect(button("Undo")).toBeUndefined();
  });

  it("dismisses an offered suggestion and leaves the draft alone", async () => {
    const registry = fakeRegistry();
    useSourceControlPanelStore.getState().setCwdMessage(CWD_KEY, "my own words");
    await mount(registry);
    await emit(registry, [suggestion()]);
    await click("Dismiss");
    expect(textarea().value).toBe("my own words");
    expect(container.textContent).not.toContain("suggested a message");
  });

  it("reaches a panel opened after the suggestion was sent", async () => {
    const registry = fakeRegistry();
    await emit(registry, [suggestion({ message: "Sent earlier" })]);
    await mount(registry);
    expect(textarea().value).toBe("Sent earlier");
    expect(container.textContent).toContain("Message from Agent Claude Code");
  });

  it("drops the label once the person edits, and never refills after a commit", async () => {
    const registry = fakeRegistry();
    await mount(registry);
    const sent = suggestion({ message: "Fix it" });
    await emit(registry, [sent]);
    await act(async () => useSourceControlPanelStore.getState().setCwdMessage(CWD_KEY, "Fix it!"));
    expect(container.textContent).not.toContain("Message from");
    // A successful commit clears the draft; the pending suggestion stays out of it.
    await act(async () => useSourceControlPanelStore.getState().clearCwdDraft(CWD_KEY));
    await emit(registry, [sent]);
    expect(textarea().value).toBe("");
  });

  it("ignores another folder's suggestion and focus intents", async () => {
    const registry = fakeRegistry();
    await mount(registry);
    await emit(registry, [
      suggestion({ cwd: "/work/other" }),
      {
        kind: "focus",
        intentId: "focus-1",
        threadId: ThreadId.make("thread-1"),
        surface: "sourceControl",
        path: null,
        actor: { kind: "mcp-client", clientId: "s", label: "Claude Code" },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);
    expect(textarea().value).toBe("");
    expect(container.textContent).not.toContain("Agent");
  });

  it("shows an agent's text as text", async () => {
    const registry = fakeRegistry();
    useSourceControlPanelStore.getState().setCwdMessage(CWD_KEY, "mine");
    await mount(registry);
    await emit(registry, [
      suggestion({
        message: "<img src=x onerror=alert(1)>",
        actor: { kind: "mcp-client", clientId: "s", label: "<b>Bold</b>" },
      }),
    ]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("Agent <b>Bold</b> suggested a message");
  });
});
