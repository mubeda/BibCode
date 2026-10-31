import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";

import {
  agentSuggestionOutcome,
  selectThreadSourceControlDraft,
  useSourceControlPanelStore,
} from "./sourceControlPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
const STORAGE_NAME = "bibcode:source-control-panel-state:v1";

describe("sourceControlPanelStore", () => {
  beforeEach(() => useSourceControlPanelStore.setState({ byThreadKey: {} }));

  it("returns a default draft for an unknown thread", () => {
    expect(
      selectThreadSourceControlDraft(useSourceControlPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      message: "",
    });
  });

  it("sets the commit message", () => {
    useSourceControlPanelStore.getState().setMessage(THREAD_REF, "fix: thing");
    expect(
      selectThreadSourceControlDraft(useSourceControlPanelStore.getState().byThreadKey, THREAD_REF)
        .message,
    ).toBe("fix: thing");
  });

  it("clears the draft on removeThread", () => {
    useSourceControlPanelStore.getState().setMessage(THREAD_REF, "wip");
    useSourceControlPanelStore.getState().removeThread(THREAD_REF);
    expect(useSourceControlPanelStore.getState().byThreadKey).toEqual({});
  });

  it("groups changes by folder by default", () => {
    expect(useSourceControlPanelStore.getInitialState().sourceControlGroupByFolder).toBe(true);
  });

  describe("an agent's commit message suggestion", () => {
    const CWD = "environment-1::/repo";
    const OTHER = "environment-1::/other";
    const store = () => useSourceControlPanelStore.getState();
    const outcome = (intentId: string) =>
      agentSuggestionOutcome(store().agentSuggestionByCwdKey[CWD], intentId);
    const persisted = new Map<string, string>();
    const saved = () => JSON.parse(persisted.get(STORAGE_NAME) ?? "{}").state;
    /** What another tab saved after this one loaded. */
    const otherTabSaved = (byCwdKey: Record<string, { message: string }>) =>
      persisted.set(
        STORAGE_NAME,
        JSON.stringify({
          state: { byThreadKey: {}, byCwdKey, agentSuggestionByCwdKey: {} },
          version: 2,
        }),
      );

    beforeEach(() => {
      persisted.clear();
      useSourceControlPanelStore.persist.setOptions({
        storage: createJSONStorage(() => ({
          getItem: (name: string) => persisted.get(name) ?? null,
          setItem: (name: string, value: string) => void persisted.set(name, value),
          removeItem: (name: string) => void persisted.delete(name),
        })),
      });
      useSourceControlPanelStore.setState({
        byThreadKey: {},
        byCwdKey: {},
        agentSuggestionByCwdKey: {},
      });
    });

    it("fills an empty draft once, and never again after the draft is cleared", () => {
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      expect(store().byCwdKey[CWD]?.message).toBe("Fix the parser");
      expect(outcome("intent-1")).toBe("filled");
      expect(saved().agentSuggestionByCwdKey[CWD]).toEqual({
        intentId: "intent-1",
        outcome: "filled",
      });
      // A commit clears the draft; the same suggestion, still pending, does not come back.
      store().clearCwdDraft(CWD);
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      expect(store().byCwdKey[CWD]).toBeUndefined();
    });

    it("offers over a draft with text and writes nothing", () => {
      store().setCwdMessage(CWD, "my own words");
      const before = persisted.get(STORAGE_NAME);
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      expect(store().byCwdKey[CWD]?.message).toBe("my own words");
      expect(outcome("intent-1")).toBe("offered");
      expect(persisted.get(STORAGE_NAME)).toBe(before);

      store().dismissAgentCommitSuggestion(CWD, "intent-1");
      expect(store().byCwdKey[CWD]?.message).toBe("my own words");
      expect(outcome("intent-1")).toBe("dismissed");
    });

    it("uses an offered suggestion only when the person asks, and Undo restores", () => {
      store().setCwdMessage(CWD, "my own words");
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      expect(store().byCwdKey[CWD]?.message).toBe("my own words");
      store().acceptAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      expect(store().byCwdKey[CWD]?.message).toBe("Fix the parser");
      expect(outcome("intent-1")).toBe("used");
      // A handled suggestion is not used again.
      store().setCwdMessage(CWD, "Fix the parser!");
      store().acceptAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      expect(store().byCwdKey[CWD]?.message).toBe("Fix the parser!");
      store().setCwdMessage(CWD, "Fix the parser");
      // A misclick is undone: the person's words come back.
      store().undoAgentCommitSuggestion(CWD, "intent-1");
      expect(store().byCwdKey[CWD]?.message).toBe("my own words");
      expect(outcome("intent-1")).toBe("dismissed");
    });

    it("never overwrites a draft an earlier suggestion filled", () => {
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "First");
      store().receiveAgentCommitSuggestion(CWD, "intent-2", "Second");
      expect(store().byCwdKey[CWD]?.message).toBe("First");
      expect(outcome("intent-2")).toBe("offered");
    });

    it("never lets a stale tab's draft write over what another tab saved", () => {
      // This tab typed "Fix" earlier; another tab has since saved "Fix parser".
      store().setCwdMessage(CWD, "Fix");
      otherTabSaved({ [CWD]: { message: "Fix parser" } });
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Agent message");
      expect(saved().byCwdKey[CWD]).toEqual({ message: "Fix parser" });
      expect(outcome("intent-1")).toBe("offered");
    });

    it("offers, and writes nothing, when only the saved draft has text", () => {
      otherTabSaved({ [CWD]: { message: "tab A words" } });
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Agent message");
      expect(saved().byCwdKey[CWD]).toEqual({ message: "tab A words" });
      expect(store().byCwdKey[CWD]).toBeUndefined();
      expect(outcome("intent-1")).toBe("offered");
    });

    it("fills only its own folder and keeps another folder's saved draft", () => {
      otherTabSaved({ [OTHER]: { message: "other folder words" } });
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Agent message");
      expect(store().byCwdKey[CWD]?.message).toBe("Agent message");
      expect(saved().byCwdKey[OTHER]).toEqual({ message: "other folder words" });
      expect(saved().byCwdKey[CWD]).toEqual({ message: "Agent message" });
    });

    it("promotes a draft from before folder drafts before it applies a suggestion", () => {
      useSourceControlPanelStore.setState({ byThreadKey: { "env:thread": { message: "half" } } });
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Fix the parser", "env:thread");
      expect(store().byCwdKey[CWD]?.message).toBe("half");
      expect(store().byThreadKey).toEqual({});
      expect(outcome("intent-1")).toBe("offered");
    });

    it("remembers a bounded number of folders", () => {
      for (let index = 0; index < 130; index += 1) {
        store().receiveAgentCommitSuggestion(`environment-1::/repo/${index}`, `i${index}`, "Fix");
      }
      const kept = Object.keys(store().agentSuggestionByCwdKey);
      expect(kept).toHaveLength(128);
      expect(kept[0]).toBe("environment-1::/repo/2");
    });
  });

  it("switches the changes view between grouped and flat", () => {
    useSourceControlPanelStore.getState().setSourceControlGroupByFolder(false);
    expect(useSourceControlPanelStore.getState().sourceControlGroupByFolder).toBe(false);
    useSourceControlPanelStore.getState().setSourceControlGroupByFolder(true);
    expect(useSourceControlPanelStore.getState().sourceControlGroupByFolder).toBe(true);
  });
});
