// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentAddress,
  SEND_REQUEST_ANSWER_MAX_CHARS,
  SEND_REQUEST_LEAD_IN_MAX_CHARS,
  SEND_REQUEST_MAX_CHARS,
  SendRequestAction,
  SendRequestError,
  SendRequestState,
  SendRequestsGetAnswerResult,
  SendRequestsSendInput,
  SendRequestsStreamEvent,
} from "./sendRequests.ts";

const strict = { onExcessProperty: "error" } as const;
const decodeSendInput = Schema.decodeUnknownSync(SendRequestsSendInput);
const decodeStreamEvent = Schema.decodeUnknownSync(SendRequestsStreamEvent);
const decodeAnswer = Schema.decodeUnknownSync(SendRequestsGetAnswerResult);
const decodeError = Schema.decodeUnknownSync(SendRequestError);
const isAddress = Schema.is(AgentAddress);

const sendInput = {
  requestId: "request-1",
  action: "review",
  source: "thread:thread-a",
  target: "thread:thread-b",
  leadIn: "Please review.",
  note: "Look at the parser.",
  attachments: [{ label: "Diff", text: "+ a line" }],
};

const request = {
  requestId: "request-1",
  projectId: "project-1",
  action: "review",
  source: "thread:thread-a",
  sourceThreadId: "thread-a",
  target: "thread:thread-b",
  targetThreadId: "thread-b",
  takenOver: null,
  targetMessageId: "person-send:request-1",
  state: "queued",
  reason: null,
  answerMessageId: null,
  answeringTurnId: null,
  createdAt: "2026-11-13T00:00:00Z",
  updatedAt: "2026-11-13T00:00:00Z",
  dismissedAt: null,
};

describe("send request contracts", () => {
  it("SendRequestAction lists exactly the five action ids", () => {
    expect(SendRequestAction.literals).toEqual([
      "review",
      "second-opinion",
      "hand-off",
      "take-over",
      "message",
    ]);
  });

  it("SendRequestState lists exactly the seven states", () => {
    expect(SendRequestState.literals).toEqual([
      "queued",
      "waiting",
      "delivered",
      "read",
      "answered",
      "not_answered",
      "cancelled",
    ]);
  });

  it("a send input decodes its person fields and refuses an actor, a mode or a sender field", () => {
    expect(decodeSendInput(sendInput, strict)).toEqual(sendInput);
    expect(
      decodeSendInput({ ...sendInput, action: "take-over", takenOver: "thread:thread-c" }, strict)
        .takenOver,
    ).toBe("thread:thread-c");
    for (const extra of [
      { actor: { kind: "mcp-client", clientId: "s1", label: null } },
      { runtimeMode: "full-access" },
      { interactionMode: "plan" },
      { sender: "thread:thread-c" },
    ]) {
      expect(() => decodeSendInput({ ...sendInput, ...extra }, strict)).toThrow();
    }
  });

  it("AgentAddress accepts thread and terminal addresses and refuses anything else", () => {
    expect(isAddress("thread:thread-1")).toBe(true);
    expect(isAddress("terminal:thread-1/terminal-1")).toBe(true);
    for (const value of [
      "",
      "thread:",
      "thread:a/b",
      "terminal:thread-1",
      "terminal:/terminal-1",
      "terminal:a/b/c",
      "project:p1",
      "thread-1",
      "thread: a",
    ]) {
      expect(isAddress(value), value).toBe(false);
    }
  });

  it("AgentAddress has exactly one declaration in packages/contracts/src", () => {
    const directory = new URL(".", import.meta.url);
    const declarations = NodeFS.readdirSync(directory)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => NodeFS.readFileSync(new URL(name, directory), "utf8"))
      .reduce((count, source) => count + source.split("export const AgentAddress ").length - 1, 0);
    expect(declarations).toBe(1);
  });

  it("a stream event decodes a snapshot, a page, an upsert and a remove", () => {
    const decode = decodeStreamEvent;
    expect(decode({ type: "snapshot", requests: [request] })).toEqual({
      type: "snapshot",
      requests: [request],
    });
    expect(decode({ type: "page", requests: [] })).toEqual({ type: "page", requests: [] });
    expect(decode({ type: "upsert", request })).toEqual({ type: "upsert", request });
    expect(decode({ type: "remove", requestId: "request-1" })).toEqual({
      type: "remove",
      requestId: "request-1",
    });
  });

  it("a get-answer result carries text and a truncated flag", () => {
    const result = { requestId: "request-1", text: "The answer.", truncated: true };
    expect(decodeAnswer(result, strict)).toEqual(result);
  });

  it("SendRequestError decodes every reason", () => {
    const decode = decodeError;
    for (const reason of [
      "person_only",
      "invalid",
      "too_long",
      "other_project",
      "unknown_thread",
      "target_not_notifiable",
      "request_conflict",
      "not_found",
      "not_final",
      "not_answered",
      "not_cancellable",
      "storage",
    ]) {
      expect(decode({ _tag: "SendRequestError", reason, message: "m" }).reason).toBe(reason);
    }
    expect(() => decode({ _tag: "SendRequestError", reason: "other", message: "m" })).toThrow();
  });

  it("the limits are 48000, 16000 and 48000", () => {
    expect([
      SEND_REQUEST_MAX_CHARS,
      SEND_REQUEST_LEAD_IN_MAX_CHARS,
      SEND_REQUEST_ANSWER_MAX_CHARS,
    ]).toEqual([48_000, 16_000, 48_000]);
  });
});
