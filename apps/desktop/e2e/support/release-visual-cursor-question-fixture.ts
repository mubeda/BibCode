export const cursorQuestionFixtureSelection = "question-multiselect-v1";
export const cursorQuestionFixturePrompt = "Owned later multiselect question";

const extension = String.raw`
if (process.env.CI !== "true" || process.env.BIBCODE_E2E_CURSOR_QUESTION_FIXTURE !== @@SELECTION@@) {
  throw new Error("Owned Cursor question fixture refused.");
}
const ownedCursorQuestion = (() => {
  const refuse = () => { throw new Error("Owned Cursor question fixture refused."); };
  const token = (value) => (typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  const shape = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  let calls = 0;
  let session = null;
  let pending = null;
  let asked = false;
  const requestIds = new Set();
  let questionId = null;
  const parse = (line) => {
    if (++calls > 128 || typeof line !== "string" || line.length > 16384) refuse();
    let message;
    try { message = JSON.parse(line); } catch { refuse(); }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") refuse();
    return message;
  };
  const receive = (message) => {
    if (message.method === undefined) {
      if (!pending || pending.cancelled || !shape(message, ["jsonrpc", "id", "result"]) || message.id !== questionId) refuse();
      if (shape(message.result, ["outcome"]) && message.result.outcome === "cancelled") {
        pending.cancelled = true;
        return true;
      }
      if (!shape(message.result, ["answers"]) || !shape(message.result.answers, ["first", "later"])) refuse();
      const answers = message.result.answers;
      if (!["Workspace", "Project"].includes(answers.first) || !Array.isArray(answers.later) ||
          answers.later.length < 2 || answers.later.length > 3 ||
          answers.later.some((label) => !["Tests", "Docs", "Types"].includes(label)) ||
          new Set(answers.later).size !== answers.later.length) refuse();
      const original = pending;
      pending = null;
      send(original.promptId, { stopReason: "end_turn" });
      return true;
    }
    if (message.method === "session/cancel") {
      if (message.params?.sessionId !== session) refuse();
      if (!pending) return false;
      if (!pending.cancelled || !shape(message, ["jsonrpc", "method", "params"]) || !shape(message.params, ["sessionId"])) refuse();
      const original = pending;
      pending = null;
      send(original.promptId, { stopReason: "cancelled" });
      return true;
    }
    if (!token(message.id) || message.id === questionId || requestIds.has(message.id)) refuse();
    requestIds.add(message.id);
    if (message.method === "session/new" || message.method === "session/load") {
      if (session !== null || pending) refuse();
      const selected = message.params?.sessionId ?? "bibcode-ui-cursor-session";
      if (typeof selected !== "string" || !token(selected)) refuse();
      session = selected;
      return false;
    }
    if (message.method !== "session/prompt") return false;
    if (session === null || message.params?.sessionId !== session || pending) refuse();
    const prompt = promptTextFromParts(message.params?.prompt);
    if (prompt !== @@PROMPT@@) return false;
    if (asked) refuse();
    asked = true;
    questionId = "owned-visual-cursor-question:" + JSON.stringify([session, message.id]);
    pending = { promptId: message.id, session, cancelled: false };
    appendProviderInput("cursor", prompt);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: questionId, method: "cursor/ask_question", params: {
      sessionId: session,
      questions: [
        { id: "first", prompt: "Choose the first scope.", allowMultiple: false, options: [
          { id: "workspace", label: "Workspace" }, { id: "project", label: "Project" }
        ] },
        { id: "later", prompt: "Choose the later checks.", allowMultiple: true, options: [
          { id: "tests", label: "Tests" }, { id: "docs", label: "Docs" }, { id: "types", label: "Types" }
        ] }
      ]
    } }) + "\n");
    return true;
  };
  return { parse, receive };
})();
`;

/** Pure opt-in extension; callers retain the existing owned shim installation/lifecycle. */
export function extendOwnedCursorQuestionFixture(source: string, selection?: string): string {
  if (selection === undefined) return source;
  const reader = 'reader.on("line", (line) => {';
  const parse = "  const message = JSON.parse(line);";
  if (
    selection !== cursorQuestionFixtureSelection ||
    typeof source !== "string" ||
    source.length > 65_536 ||
    source.includes("ownedCursorQuestion") ||
    source.split(reader).length !== 2 ||
    source.split(parse).length !== 2 ||
    !source.includes("const send = (id, result) => process.stdout.write(JSON.stringify({") ||
    !source.includes(
      'appendProviderInput("cursor", promptTextFromParts(message.params?.prompt));',
    ) ||
    !source.includes('sessionId: message.params?.sessionId ?? "bibcode-ui-cursor-session"')
  )
    throw new Error("Owned Cursor question fixture refused.");
  const output = source
    .replace(
      reader,
      extension
        .replace("@@SELECTION@@", JSON.stringify(cursorQuestionFixtureSelection))
        .replace("@@PROMPT@@", JSON.stringify(cursorQuestionFixturePrompt)) +
        "\n" +
        reader,
    )
    .replace(
      parse,
      "  const message = ownedCursorQuestion.parse(line);\n  if (ownedCursorQuestion.receive(message)) return;",
    );
  if (output.length > 65_536) throw new Error("Owned Cursor question fixture refused.");
  return output;
}
