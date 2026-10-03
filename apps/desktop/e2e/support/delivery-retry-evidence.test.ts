// @effect-diagnostics nodeBuiltinImport:off - Owned fixture receipt and workspace lifecycle tests.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  parseDeliveryReceipts,
  verifyFreshRetry,
  withUnavailableWorkspace,
} from "./delivery-retry-evidence.ts";

const before = [
  { kind: "launch", sessionId: "old", fresh: true, resumed: false },
  { kind: "input", sessionId: "old", prompt: "baseline", withheld: false },
  { kind: "input", sessionId: "old", prompt: "retry", withheld: true },
];
const fresh = [
  { kind: "launch", sessionId: "new", fresh: true, resumed: false },
  { kind: "input", sessionId: "new", prompt: "retry", withheld: false },
];
const encode = (rows: unknown[]) => rows.map((row) => JSON.stringify(row) + "\n").join("");

describe("delivery Retry evidence", () => {
  it("verifies a single fresh no-resume acceptance without exporting private identities", () => {
    const initial = parseDeliveryReceipts(encode(before));
    const accepted = parseDeliveryReceipts(encode([...before, ...fresh]));
    expect(initial).toEqual({ complete: true, entries: before });
    const proof = verifyFreshRetry(initial, accepted, "retry");
    expect(proof).toEqual({
      freshLaunches: 1,
      acceptedInputs: 1,
      newSession: true,
      noResume: true,
    });
    expect(JSON.stringify(proof)).not.toMatch(/old|new"|sessionId|prompt/);
  });

  it.each(
    [
      [...before, fresh[0]],
      [...before, { ...fresh[0], fresh: false, resumed: true }, fresh[1]],
      [...before, ...fresh, fresh[1]],
      [...before, { ...fresh[0], sessionId: "old" }, { ...fresh[1], sessionId: "old" }],
      [...before.slice(0, 2), { ...before[2], prompt: "changed" }, ...fresh],
    ].map((rows) => ({ rows })),
  )("refuses missing, duplicate, resumed, stale or rewritten acceptance", ({ rows }) => {
    expect(() =>
      verifyFreshRetry(
        parseDeliveryReceipts(encode(before)),
        parseDeliveryReceipts(encode(rows)),
        "retry",
      ),
    ).toThrow(/receipt/i);
  });

  it.each([
    '{"kind":"launch","sessionId":"private-secret","fresh":true,"resumed":false,"token":"private-secret"}\n',
    '{"kind":"unknown","cause":"private-secret"}\n',
    '{"kind":"launch","sessionId":"private-secret","fresh":true,"resumed":true}\n',
    "private-secret\n",
    " ".repeat(65537),
  ])("rejects malformed/private receipt shapes with closed errors", (input) => {
    let error: unknown;
    try {
      parseDeliveryReceipts(input);
    } catch (failure) {
      error = failure;
    }
    expect(error instanceof Error).toBe(true);
    expect(String(error)).not.toContain("private-secret");
  });

  it("keeps a partial append explicitly incomplete and unable to verify acceptance", () => {
    const initial = parseDeliveryReceipts(encode(before));
    const partial = parseDeliveryReceipts(encode([...before, fresh[0]]) + '{"kind":"input"');
    expect(partial.complete).toBe(false);
    expect(() => verifyFreshRetry(initial, partial, "retry")).toThrow(/receipt/i);
  });

  it("restores only the owned workspace after a failed real rename stimulus", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "retry-workspace-"));
    const project = NodePath.join(root, "project");
    NodeFS.mkdirSync(project);
    NodeFS.writeFileSync(NodePath.join(project, "owned.txt"), "preserved");
    try {
      await expect(
        withUnavailableWorkspace(root, project, async () => {
          expect(NodeFS.existsSync(project)).toBe(false);
          throw new Error("owned assertion failed");
        }),
      ).rejects.toThrow("owned assertion failed");
      expect(NodeFS.readFileSync(NodePath.join(project, "owned.txt"), "utf8")).toBe("preserved");
      expect(NodeFS.readdirSync(root)).toEqual(["project"]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
