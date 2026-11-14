import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { McpActivityRow } from "./mcpActivity.ts";

const decodeRow = Schema.decodeUnknownSync(McpActivityRow, { onExcessProperty: "error" });

const row = (target: unknown) => ({
  id: 1,
  occurredAt: "2026-11-14T10:00:00.000Z",
  clientId: "thread:t1",
  label: "Claude thread",
  tool: "agent_message_send",
  threadId: "t1",
  outcome: "success",
  target,
});

describe("McpActivityRow", () => {
  it("a row with an agent message target decodes", () => {
    const target = {
      recipient: "thread:t2",
      recipientTitle: "Codex panel",
      messageId: "m1",
      conversationId: "c1",
      status: "delivered",
      reason: "recipient_turn_failed",
    };
    expect(decodeRow(row(target)).target).toEqual(target);
  });

  it("a row without them still decodes", () => {
    expect(decodeRow({ ...row({ sha: "abc1234" }), tool: "git_commit" }).target).toEqual({
      sha: "abc1234",
    });
  });
});
