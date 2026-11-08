import {
  type OrchestrationPreviewCheckpointRevertResult,
  ProviderDriverKind,
  ThreadId,
} from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildRevertCheckpointDialog } from "./RevertCheckpointDialog.logic";

const codex = { driver: ProviderDriverKind.make("codex"), supportsConversationRewind: true };
const claude = {
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Work Claude",
  supportsConversationRewind: false,
};

function preview(
  overrides: Partial<OrchestrationPreviewCheckpointRevertResult> = {},
): OrchestrationPreviewCheckpointRevertResult {
  return {
    writingSiblings: [],
    restoredPaths: [],
    siblingChanges: { paths: [], turns: [] },
    siblingChangesToken: null,
    conversationRewind: "available",
    headFallbackRefused: false,
    ...overrides,
  };
}

const labels = (model: ReturnType<typeof buildRevertCheckpointDialog>) =>
  model.actions.map((action) => action.label);

describe("buildRevertCheckpointDialog", () => {
  it("offers both reverts, with the file restore first and destructive", () => {
    const model = buildRevertCheckpointDialog({
      turnCount: 3,
      provider: codex,
      preview: preview(),
    });
    expect(model.title).toBe("Revert to checkpoint 3?");
    expect(model.description).toBe(
      "Files go back to how they were after turn 3, and newer messages in this thread are removed. This can't be undone.",
    );
    expect(labels(model)).toEqual(["Revert files and conversation", "Rewind conversation only"]);
    expect(model.actions[0]).toMatchObject({ mode: "full", primary: true, destructive: true });
    expect(model.actions[1]).toMatchObject({ mode: "conversationOnly", primary: false });
    expect(model.dismissLabel).toBe("Cancel");
  });

  it("lists the files a shared restore changes and what other chats changed", () => {
    const model = buildRevertCheckpointDialog({
      turnCount: 3,
      provider: codex,
      preview: preview({
        restoredPaths: ["src/app.ts", "README.md", "package.json"],
        siblingChanges: {
          paths: ["package.json"],
          turns: [
            {
              threadId: ThreadId.make("panel"),
              title: "Panel, Codex",
              turns: 2,
              files: ["src/app.ts", "README.md", "a", "b"],
            },
            { threadId: ThreadId.make("side"), title: "Side chat", turns: 1, files: null },
          ],
        },
        siblingChangesToken: "token",
      }),
    });
    expect(model.restoredPaths).toEqual(["src/app.ts", "README.md", "package.json"]);
    expect(model.outsideChanges).toEqual([
      "Panel, Codex: 2 turns, src/app.ts, README.md, a and 1 more",
      "Side chat: 1 turn, files not known",
      "Changed since this chat's last turn: package.json",
    ]);
    expect(model.siblingChangesToken).toBe("token");
  });

  it("refuses the file restore while a sibling writes and offers the conversation rewind", () => {
    const model = buildRevertCheckpointDialog({
      turnCount: 3,
      provider: codex,
      preview: preview({
        writingSiblings: [
          { threadId: ThreadId.make("panel"), title: "Panel, Codex", reason: "turn" },
        ],
      }),
    });
    expect(model.title).toBe("Can't restore files right now");
    expect(model.description).toBe(
      "Panel, Codex is running a turn in this checkout. Stop it or wait for it to finish, then revert. You can rewind only this conversation now; files stay as they are.",
    );
    expect(labels(model)).toEqual(["Rewind conversation only"]);
    expect(model.actions[0]).toMatchObject({ primary: true, destructive: false });
    expect(model.dismissLabel).toBe("Cancel");
  });

  it("only closes when a sibling writes and the conversation cannot be rewound alone", () => {
    const model = buildRevertCheckpointDialog({
      turnCount: 3,
      provider: codex,
      preview: preview({
        writingSiblings: [
          { threadId: ThreadId.make("grok"), title: "Panel, Grok", reason: "unobservable" },
        ],
        conversationRewind: "rewindRestoresFiles",
      }),
    });
    expect(model.description).toBe(
      "BiBCode can't tell whether Panel, Grok is still working. Stop its session, then revert.",
    );
    expect(model.actions).toEqual([]);
    expect(model.dismissLabel).toBe("Close");
  });

  it("refuses turn 0's HEAD fallback on a shared checkout", () => {
    const model = buildRevertCheckpointDialog({
      turnCount: 0,
      provider: codex,
      preview: preview({ headFallbackRefused: true }),
    });
    expect(model.title).toBe("Can't restore files right now");
    expect(model.description).toContain("no starting checkpoint");
    expect(labels(model)).toEqual(["Rewind conversation only"]);
  });

  it("restores only files for a provider that cannot rewind", () => {
    for (const input of [
      { preview: preview({ conversationRewind: "filesOnlyProvider" as const }) },
      { preview: null },
    ]) {
      const model = buildRevertCheckpointDialog({ turnCount: 2, provider: claude, ...input });
      expect(model.title).toBe("Restore files to checkpoint 2?");
      expect(model.description).toBe(
        "Work Claude can't rewind its conversation, so the newer messages stay. This can't be undone.",
      );
      expect(labels(model)).toEqual(["Restore files"]);
    }
  });

  it("leaves out the conversation rewind for OpenCode 1 and for an older server", () => {
    for (const input of [
      { preview: preview({ conversationRewind: "rewindRestoresFiles" as const }) },
      { preview: null },
    ]) {
      const model = buildRevertCheckpointDialog({ turnCount: 1, provider: codex, ...input });
      expect(labels(model)).toEqual(["Revert files and conversation"]);
    }
    // An older server omits the capability flag even for Codex: the full revert stays.
    expect(buildRevertCheckpointDialog({ turnCount: 1, provider: null, preview: null }).title).toBe(
      "Revert to checkpoint 1?",
    );
  });
});
