// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_MESSAGE_MAX_CHARACTERS,
  AgentMessageReason,
  AgentMessageReplyInput,
  AgentMessageSendInput,
  AgentMessageStatus,
  AgentMessagingErrorTag,
  AgentSummary,
  OrchestrationHostedAgentActor,
} from "./agentMessaging.ts";

const strict = { onExcessProperty: "error" } as const;
const decodeSummary = Schema.decodeUnknownSync(AgentSummary);
const decodeSend = Schema.decodeUnknownSync(AgentMessageSendInput);
const decodeReply = Schema.decodeUnknownSync(AgentMessageReplyInput);
const decodeActor = Schema.decodeUnknownSync(OrchestrationHostedAgentActor);

const summary = {
  address: "thread:t1",
  title: "API refactor",
  provider: "codex",
  kind: "chat",
  status: "ready",
  canReceive: true,
};

describe("agentMessaging", () => {
  it("status and reason names match the server", () => {
    expect(AgentMessageStatus.literals).toEqual([
      "accepted",
      "queued",
      "held",
      "delivered",
      "consumed",
      "completed",
      "cancelled",
      "failed",
    ]);
    expect(AgentMessageReason.literals).toEqual([
      "messaging_off",
      "recipient_mode_above_sender",
      "recipient_gone",
      "recipient_turn_failed",
      "recipient_queue_held",
      "delivery_failed",
      "delivery_uncertain",
    ]);
    expect(AgentMessagingErrorTag.literals).toEqual([
      "AgentMessagingDisabledError",
      "AgentMessagingUnknownRecipientError",
      "AgentMessagingInvalidArgumentError",
      "AgentMessagingModeCeilingError",
      "AgentMessagingHopLimitError",
      "AgentMessagingRateLimitError",
      "AgentMessagingBacklogLimitError",
      "AgentMessagingConflictError",
      "AgentMessagingNotCancellableError",
      "AgentMessagingNoIdentityError",
      "AgentMessagingUnknownMessageError",
      "AgentMessagingRecipientGoneError",
    ]);
  });

  it("the address type is the one of sendRequests.ts", () => {
    expect(decodeSummary(summary).address).toBe("thread:t1");
    expect(decodeSummary({ ...summary, address: "terminal:t1/term-1" }).address).toBe(
      "terminal:t1/term-1",
    );
    expect(() => decodeSummary({ ...summary, address: "x" })).toThrow();
    const directory = new URL(".", import.meta.url);
    const declarations = NodeFS.readdirSync(directory)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => NodeFS.readFileSync(new URL(name, directory), "utf8"))
      .reduce((count, source) => count + source.split("export const AgentAddress ").length - 1, 0);
    expect(declarations).toBe(1);
  });

  it("a message text of 16,000 characters is accepted and 16,001 is refused", () => {
    expect(AGENT_MESSAGE_MAX_CHARACTERS).toBe(16_000);
    const longest = "a".repeat(16_000);
    expect(decodeSend({ to: "thread:t2", text: longest }).text).toBe(longest);
    expect(() => decodeSend({ to: "thread:t2", text: "a".repeat(16_001) })).toThrow();
    expect(() => decodeSend({ to: "thread:t2", text: "" })).toThrow();
    expect(decodeSend({ to: "thread:t2", text: "hi", clientRequestId: "r1" })).toEqual({
      to: "thread:t2",
      text: "hi",
      clientRequestId: "r1",
    });
  });

  it("the text limit counts Unicode characters, not UTF-16 units", () => {
    // Each emoji is one character and two UTF-16 units.
    const emoji = "\u{1F600}";
    const longest = emoji.repeat(16_000);
    expect(decodeSend({ to: "thread:t2", text: longest }).text).toBe(longest);
    expect(decodeReply({ inReplyTo: "m1", text: longest }).text).toBe(longest);
    expect(() => decodeSend({ to: "thread:t2", text: emoji.repeat(16_001) })).toThrow();
    expect(() => decodeReply({ inReplyTo: "m1", text: emoji.repeat(16_001) })).toThrow();
    expect(() => decodeReply({ inReplyTo: "m1", text: "" })).toThrow();
  });

  it("a hosted-agent actor decodes with its address and label", () => {
    expect(
      decodeActor({ kind: "hosted-agent", address: "thread:t1", label: "API refactor" }),
    ).toEqual({ kind: "hosted-agent", address: "thread:t1", label: "API refactor" });
    expect(
      decodeActor({ kind: "hosted-agent", address: "thread:t1", label: null }).label,
    ).toBeNull();
    expect(() => decodeActor({ kind: "mcp-client", address: "thread:t1", label: null })).toThrow();
  });

  it("an agent summary carries the six fields", () => {
    expect(decodeSummary(summary, strict)).toEqual(summary);
    expect(Object.keys(AgentSummary.fields).toSorted()).toEqual(
      ["address", "canReceive", "kind", "provider", "status", "title"].toSorted(),
    );
    expect(() => decodeSummary({ ...summary, kind: "robot" })).toThrow();
    expect(() => decodeSummary({ ...summary, status: "sleeping" })).toThrow();
  });
});
