import type { PipelinesListPage, PipelinesRow } from "@bibcode/contracts";

export const pipelineRow: PipelinesRow = {
  id: 4821,
  label: "#4821",
  title: "Fix connection recovery",
  status: "failed",
  warnings: false,
  reason: null,
  terminal: true,
  ref: { kind: "branch", name: "main", number: null, url: null },
  sha: "abc1234def5678",
  actor: { login: "ana", name: "Ana Rossi", isBot: false },
  badges: ["latest", "branch"],
  createdAt: "2026-10-25T10:00:00Z",
  startedAt: "2026-10-25T10:00:05Z",
  finishedAt: "2026-10-25T10:04:17Z",
  durationSeconds: 252,
  queuedSeconds: 5,
  stages: [
    { name: "build", status: "success", warnings: false },
    { name: "test", status: "failed", warnings: false },
  ],
  attempt: null,
  permissions: { retry: "granted", cancel: "granted" },
  url: "https://gitlab.com/acme/repo/-/pipelines/4821",
};

export function pipelinesPage(
  rows: readonly PipelinesRow[],
  options: { revision?: number; nextCursor?: string | null } = {},
): PipelinesListPage {
  return {
    revision: options.revision ?? 1,
    rows,
    nextCursor: options.nextCursor ?? null,
    total: { count: rows.length, capped: false },
  };
}
