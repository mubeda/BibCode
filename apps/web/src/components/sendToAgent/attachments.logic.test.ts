import { describe, expect, it } from "vite-plus/test";

import {
  ATTACHMENT_MAX_CHARS,
  buildSecondOpinionContent,
  cutAtCharacters,
  formatLeftOut,
  lastFinishedAnswer,
  lastPersonMessage,
  SECOND_OPINION_LEAD_IN,
} from "./attachments.logic";
import type { SendToAgentSource } from "./sendToAgent.logic";

type Messages = SendToAgentSource["messages"];

const person = (id: string, text: string) => ({ id, role: "user", text, streaming: false });
const agentEnvelope = (id: string, text: string) => ({
  id,
  role: "user",
  text,
  streaming: false,
  actor: { kind: "hosted-agent", address: "thread:other", label: "Other" },
});
const answer = (id: string, text: string, streaming = false) => ({
  id,
  role: "assistant",
  text,
  streaming,
});
const messages = (...entries: unknown[]) => entries as Messages;

describe("second opinion attachments", () => {
  it("attaches the user's last message and the last finished answer, each under its label", () => {
    const content = buildSecondOpinionContent(
      messages(
        person("m1", "first question"),
        answer("m2", "first answer"),
        person("m3", "second question"),
        answer("m4", "second answer"),
      ),
    );
    expect(content.attachments).toEqual([
      {
        id: "last-user-message",
        label: "The user's last message",
        text: "second question",
        leftOut: null,
      },
      {
        id: "last-answer",
        label: "The agent's last finished answer",
        text: "second answer",
        leftOut: null,
      },
    ]);
  });

  it("the last message from the person skips an agent's user-role message", () => {
    const list = messages(
      person("m1", "what the person asked"),
      agentEnvelope("m2", "an agent's request"),
      answer("m3", "the answer"),
    );
    expect(lastPersonMessage(list)).toEqual({ id: "m1", text: "what the person asked" });
    const attached = buildSecondOpinionContent(list).attachments;
    expect(attached.map((entry) => entry.text)).toEqual(["what the person asked", "the answer"]);
  });

  it('long answer: a 40,000 character answer shows the first 16,000 characters and says "24,000 characters left out"', () => {
    const long = "a".repeat(40_000);
    const [, attachment] = buildSecondOpinionContent(
      messages(person("m1", "q"), answer("m2", long)),
    ).attachments;
    expect(attachment!.text).toBe("a".repeat(16_000));
    expect(attachment!.leftOut).toBe("24,000 characters left out");
    expect(formatLeftOut(24_000)).toBe("24,000 characters left out");
    expect(formatLeftOut(0)).toBeNull();
  });

  it("answer still streaming: the last finished answer is attached", () => {
    const list = messages(
      person("m1", "q"),
      answer("m2", "finished"),
      person("m3", "q2"),
      answer("m4", "half of a new ans", true),
    );
    expect(lastFinishedAnswer(list)).toEqual({ id: "m2", text: "finished" });
  });

  it("an answer of exactly 16,000 characters leaves nothing out and has no left-out note", () => {
    const exact = "b".repeat(ATTACHMENT_MAX_CHARS);
    expect(cutAtCharacters(exact, ATTACHMENT_MAX_CHARS)).toEqual({ text: exact, leftOut: 0 });
    const [, attachment] = buildSecondOpinionContent(
      messages(person("m1", "q"), answer("m2", exact)),
    ).attachments;
    expect(attachment!.leftOut).toBeNull();
  });

  it("cutting counts Unicode characters: an answer of 16,001 non-BMP characters leaves out 1", () => {
    const text = "\u{1F600}".repeat(16_001);
    const cut = cutAtCharacters(text, 16_000);
    expect(cut.leftOut).toBe(1);
    expect(cut.text).toBe("\u{1F600}".repeat(16_000));
  });

  it("with no message from the person, including a thread whose only user-role message came from an agent, only the answer is attached", () => {
    const content = buildSecondOpinionContent(
      messages(agentEnvelope("m1", "an agent asked"), answer("m2", "the answer")),
    );
    expect(content.attachments.map((entry) => entry.id)).toEqual(["last-answer"]);
  });

  it("the lead-in asks for an assessment and forbids changing files", () => {
    expect(SECOND_OPINION_LEAD_IN).toBe(
      "A second opinion was requested from BiBCode. Below are the last message the user sent to another agent and that agent's last finished answer. Assess the answer: say what is right, what is wrong or missing, and what you would do differently. Do not edit files and do not run commands that change anything.",
    );
    expect(buildSecondOpinionContent(messages(answer("m1", "a"))).leadIn).toBe(
      SECOND_OPINION_LEAD_IN,
    );
  });
});
