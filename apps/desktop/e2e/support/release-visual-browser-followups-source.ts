// @effect-diagnostics nodeBuiltinImport:off - Typed source receipts are confirmed against original owned fixture bytes.
import * as NodeCrypto from "node:crypto";
import type { TerminalSessionSnapshot } from "../../../../packages/contracts/src/terminal.ts";
import type { ReviewDiffPreviewResult } from "../../../../packages/contracts/src/review.ts";
export interface BrowserFollowupSlowReceipt {
  requestObserved: true;
  originalReplyHeld: true;
  elapsedBeyondThreshold: true;
  method: "server.getTraceDiagnostics";
  thresholdMs: 15000;
}
export interface BrowserFollowupUploadReceipt {
  originalPngMatched: true;
  stagedBeginObserved: true;
  appendObserved: true;
  unfinished: true;
  actualSlowTransport: true;
  bytes: number;
  sha256: string;
}
export interface BrowserFollowupTerminalReceipt {
  sameTerminalMatched: true;
  twoAttachmentsObserved: true;
  distinctSizeClaims: true;
  originalOutputMatched: true;
  sizeOwnerMatched: true;
}
export interface BrowserFollowupDiffReceipt {
  ownedRepositoryMatched: true;
  originalPatchMatched: true;
  sourceHashMatched: true;
  untruncated: true;
}
export interface BrowserFollowupHostedReceipt {
  genuineHostedBuild: true;
  backendConfigAbsent: true;
  sameSourceMatched: true;
  validOwnedEntry: true;
  consentUnsubmitted: true;
}
const refused = () => new Error("Owned browser follow-up source refused.");

/** Current typed public review result joined with the real temporary Git patch. */
export function verifyBrowserFollowupDiff(input: {
  cwd: string;
  file: string;
  patch: string;
  result: ReviewDiffPreviewResult;
}): BrowserFollowupDiffReceipt {
  const sources = input.result.sources.filter((source) => source.kind === "working-tree");
  const source = sources.length === 1 ? sources[0] : undefined;
  // production/runtime.rs join_review_diffs trims each original Git segment before joining it.
  const expected = input.patch.trimEnd();
  if (
    !input.cwd ||
    input.result.cwd !== input.cwd ||
    input.file !== "pierre-step5.ts" ||
    !input.patch.includes("diff --git a/" + input.file + " b/" + input.file) ||
    !source ||
    source.truncated ||
    source.diff !== expected ||
    source.diffHash !== NodeCrypto.createHash("sha256").update(expected).digest("hex")
  )
    throw refused();
  return {
    ownedRepositoryMatched: true,
    originalPatchMatched: true,
    sourceHashMatched: true,
    untruncated: true,
  };
}

/** Both values must be the original terminal.attach snapshot replies, never synthesized metadata. */
export function verifyBrowserFollowupTerminal(input: {
  threadId: string;
  terminalId: string;
  cwd: string;
  firstClaim: string;
  secondClaim: string;
  first: TerminalSessionSnapshot;
  second: TerminalSessionSnapshot;
  output: "Owned shared terminal output";
}): BrowserFollowupTerminalReceipt {
  if (
    !input.firstClaim ||
    !input.secondClaim ||
    input.firstClaim === input.secondClaim ||
    !input.first.size ||
    !input.second.size ||
    input.first.size.sizeClaim !== input.firstClaim ||
    input.second.size.sizeClaim !== input.firstClaim ||
    input.first.size.cols !== input.second.size.cols ||
    input.first.size.rows !== input.second.size.rows ||
    ![input.first, input.second].every(
      (value) =>
        value.threadId === input.threadId &&
        value.terminalId === input.terminalId &&
        value.cwd === input.cwd &&
        value.status === "running" &&
        value.history.includes(input.output) &&
        value.pid !== null,
    ) ||
    input.first.pid !== input.second.pid
  )
    throw refused();
  return {
    sameTerminalMatched: true,
    twoAttachmentsObserved: true,
    distinctSizeClaims: true,
    originalOutputMatched: true,
    sizeOwnerMatched: true,
  };
}
