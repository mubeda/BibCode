import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";

import {
  selectThreadSourceControlDraft,
  useSourceControlPanelStore,
} from "./sourceControlPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

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
    const store = () => useSourceControlPanelStore.getState();

    beforeEach(() =>
      useSourceControlPanelStore.setState({ byCwdKey: {}, agentSuggestionByCwdKey: {} }),
    );

    it("fills an empty draft once, and never again after the draft is cleared", () => {
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      expect(store().byCwdKey[CWD]?.message).toBe("Fix the parser");
      expect(store().agentSuggestionByCwdKey[CWD]).toEqual({
        intentId: "intent-1",
        outcome: "filled",
      });
      // A commit clears the draft; the same suggestion, still pending, does not come back.
      store().clearCwdDraft(CWD);
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      expect(store().byCwdKey[CWD]).toBeUndefined();
    });

    it("keeps a draft with text and offers the suggestion instead", () => {
      store().setCwdMessage(CWD, "my own words");
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      expect(store().byCwdKey[CWD]?.message).toBe("my own words");
      expect(store().agentSuggestionByCwdKey[CWD]?.outcome).toBe("offered");

      store().dismissAgentCommitSuggestion(CWD, "intent-1");
      expect(store().byCwdKey[CWD]?.message).toBe("my own words");
      expect(store().agentSuggestionByCwdKey[CWD]?.outcome).toBe("dismissed");
    });

    it("uses an offered suggestion only when the person asks", () => {
      store().setCwdMessage(CWD, "my own words");
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      // A stale button, for an older suggestion, does nothing.
      store().acceptAgentCommitSuggestion(CWD, "intent-0", "Older");
      expect(store().byCwdKey[CWD]?.message).toBe("my own words");
      store().acceptAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      expect(store().byCwdKey[CWD]?.message).toBe("Fix the parser");
      expect(store().agentSuggestionByCwdKey[CWD]?.outcome).toBe("used");
      // A misclick is undone: the person's words come back.
      store().undoAgentCommitSuggestion(CWD, "intent-1");
      expect(store().byCwdKey[CWD]?.message).toBe("my own words");
      expect(store().agentSuggestionByCwdKey[CWD]).toEqual({
        intentId: "intent-1",
        outcome: "dismissed",
      });
    });

    it("never overwrites a draft an earlier suggestion filled", () => {
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "First");
      store().receiveAgentCommitSuggestion(CWD, "intent-2", "Second");
      expect(store().byCwdKey[CWD]?.message).toBe("First");
      expect(store().agentSuggestionByCwdKey[CWD]).toEqual({
        intentId: "intent-2",
        outcome: "offered",
      });
    });

    it("never fills over words another tab saved, and keeps that tab's other folders", () => {
      const persisted = new Map<string, string>();
      useSourceControlPanelStore.persist.setOptions({
        storage: createJSONStorage(() => ({
          getItem: (name: string) => persisted.get(name) ?? null,
          setItem: (name: string, value: string) => void persisted.set(name, value),
          removeItem: (name: string) => void persisted.delete(name),
        })),
      });
      const OTHER = "environment-1::/other";
      const saved = () =>
        JSON.parse(persisted.get("bibcode:source-control-panel-state:v1") ?? "{}").state;
      // Tab A typed after this tab loaded: this tab still holds empty drafts.
      const tabA = (byCwdKey: Record<string, { message: string }>) =>
        persisted.set(
          "bibcode:source-control-panel-state:v1",
          JSON.stringify({
            state: { byThreadKey: {}, byCwdKey, agentSuggestionByCwdKey: {} },
            version: 2,
          }),
        );
      tabA({ [CWD]: { message: "tab A words" }, [OTHER]: { message: "tab A other" } });

      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Fix the parser");
      expect(store().byCwdKey[CWD]?.message).toBe("tab A words");
      expect(store().agentSuggestionByCwdKey[CWD]?.outcome).toBe("offered");
      expect(saved().byCwdKey[CWD]).toEqual({ message: "tab A words" });
      expect(saved().byCwdKey[OTHER]).toEqual({ message: "tab A other" });

      // An empty folder is filled, and the fill changes only that folder.
      useSourceControlPanelStore.setState({ byCwdKey: {}, agentSuggestionByCwdKey: {} });
      tabA({ [OTHER]: { message: "tab A other" } });
      store().receiveAgentCommitSuggestion(CWD, "intent-2", "Fix the parser");
      expect(store().byCwdKey[CWD]?.message).toBe("Fix the parser");
      expect(saved().byCwdKey[OTHER]).toEqual({ message: "tab A other" });
      expect(saved().byCwdKey[CWD]).toEqual({ message: "Fix the parser" });
    });

    it("promotes a draft from before folder drafts before it applies a suggestion", () => {
      useSourceControlPanelStore.setState({ byThreadKey: { "env:thread": { message: "half" } } });
      store().receiveAgentCommitSuggestion(CWD, "intent-1", "Fix the parser", "env:thread");
      expect(store().byCwdKey[CWD]?.message).toBe("half");
      expect(store().byThreadKey).toEqual({});
      expect(store().agentSuggestionByCwdKey[CWD]?.outcome).toBe("offered");
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
