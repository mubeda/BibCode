// @effect-diagnostics nodeBuiltinImport:off - Original SDK-shaped replies and bytes are inert source evidence only.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "vite-plus/test";
import {
  verifyBrowserFollowupDiff,
  verifyBrowserFollowupTerminal,
} from "./release-visual-browser-followups-source.ts";
import type { TerminalSessionSnapshot } from "../../../../packages/contracts/src/terminal.ts";
import type { ReviewDiffPreviewResult } from "../../../../packages/contracts/src/review.ts";
function diff() {
  const patch =
    "diff --git a/pierre-step5.ts b/pierre-step5.ts\n--- a/pierre-step5.ts\n+++ b/pierre-step5.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const result = {
    cwd: "/owned/project",
    sources: [
      {
        kind: "working-tree",
        diff: patch.trimEnd(),
        diffHash: NodeCrypto.createHash("sha256").update(patch.trimEnd()).digest("hex"),
        truncated: false,
      },
    ],
  };
  return { cwd: "/owned/project", file: "pierre-step5.ts", patch, result };
}
it("joins the actual working-tree review patch, digest and owned repository", () => {
  const value = diff();
  expect(
    verifyBrowserFollowupDiff({
      ...value,
      result: value.result as unknown as ReviewDiffPreviewResult,
    }).originalPatchMatched,
  ).toBe(true);
});
it.each(["repository", "patch", "digest", "truncated", "duplicate"])(
  "rejects a %s review source",
  (mode) => {
    const value = diff();
    if (mode === "repository") value.result.cwd = "/other";
    if (mode === "patch") value.result.sources[0]!.diff += "different";
    if (mode === "digest") value.result.sources[0]!.diffHash = "a".repeat(64);
    if (mode === "truncated") value.result.sources[0]!.truncated = true;
    if (mode === "duplicate") value.result.sources.push(value.result.sources[0]!);
    expect(() =>
      verifyBrowserFollowupDiff({
        ...value,
        result: value.result as unknown as ReviewDiffPreviewResult,
      }),
    ).toThrow();
  },
);
const snapshot = () => ({
  threadId: "owned-thread",
  terminalId: "term-1",
  cwd: "/owned/project",
  status: "running",
  pid: 123,
  history: "Owned shared terminal output\r\n",
  size: { cols: 91, rows: 24, sizeClaim: "first-owner" },
});
const terminal = () => ({
  threadId: "owned-thread",
  terminalId: "term-1",
  cwd: "/owned/project",
  firstClaim: "first-owner",
  secondClaim: "second-owner",
  first: snapshot(),
  second: snapshot(),
  output: "Owned shared terminal output" as const,
});
it("requires the same live terminal, output and original owner in both attachments", () => {
  const value = terminal();
  expect(
    verifyBrowserFollowupTerminal({
      ...value,
      first: value.first as unknown as TerminalSessionSnapshot,
      second: value.second as unknown as TerminalSessionSnapshot,
    }).sameTerminalMatched,
  ).toBe(true);
});
it.each(["terminal", "process", "claim", "dimensions", "output", "status"])(
  "rejects a %s terminal mismatch",
  (mode) => {
    const value = terminal();
    if (mode === "terminal") value.second.terminalId = "term-2";
    if (mode === "process") value.second.pid = 456;
    if (mode === "claim") value.second.size!.sizeClaim = "second-owner";
    if (mode === "dimensions") value.second.size!.rows++;
    if (mode === "output") value.second.history = "different";
    if (mode === "status") value.second.status = "exited";
    expect(() =>
      verifyBrowserFollowupTerminal({
        ...value,
        first: value.first as unknown as TerminalSessionSnapshot,
        second: value.second as unknown as TerminalSessionSnapshot,
      }),
    ).toThrow();
  },
);
