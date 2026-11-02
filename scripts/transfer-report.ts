// @effect-diagnostics nodeBuiltinImport:off - A CI report script reads the measurement files.
// @effect-diagnostics globalConsole:off - The CLI prints the report for the job summary.
/**
 * Formats the PR transfer report (.github/workflows/transfer-report.yml): per payload, the bytes
 * the server sent on the pull request's base and head, the change, and the budget. Sizes only;
 * never fixture or user text.
 *
 *   node scripts/transfer-report.ts <base.json> <head.json> <budget.json>
 *
 * A missing or unreadable base file (the base has no measurement yet, or does not build with the
 * head's test) shows as "n/a".
 */
import * as NodeFS from "node:fs";

export type Sizes = Readonly<
  Record<string, { readonly wireBytes: number; readonly decodedBytes: number }>
>;

const PAYLOADS: ReadonlyArray<readonly [key: string, label: string]> = [
  ["shell", "Shell snapshot (`subscribeShell`, first item)"],
  ["cappedShell", "Capped shell snapshot (`subscribeShell` with `cap`, first item)"],
  ["thread", "Big thread, first `subscribeThread` item"],
  ["resume", "Big thread, resume answer (`unchanged`)"],
  ["window", "Big thread, history window (first `subscribeThread` item)"],
];
const METRICS = [
  ["wireBytes", "after deflate"],
  ["decodedBytes", "decoded"],
] as const;

const bytes = (value: number | undefined) =>
  value === undefined ? "n/a" : `${value.toLocaleString("en-US")} B`;

function change(base: number | undefined, head: number): string {
  if (base === undefined) return "n/a";
  if (base === head) return "no change";
  const percent =
    base === 0 ? "" : ` (${head > base ? "+" : ""}${(((head - base) / base) * 100).toFixed(1)}%)`;
  return `${head > base ? "+" : "-"}${Math.abs(head - base).toLocaleString("en-US")} B${percent}`;
}

export function formatTransferReport(base: Sizes | undefined, head: Sizes, budget: Sizes): string {
  const rows = PAYLOADS.flatMap(([key, label]) =>
    METRICS.map(([metric, metricLabel]) => {
      const headBytes = head[key]?.[metric];
      if (headBytes === undefined) return `| ${label} | ${metricLabel} | n/a | n/a | n/a | n/a |`;
      const limit = budget[key]?.[metric];
      const over = limit !== undefined && headBytes > limit ? " **over budget**" : "";
      return `| ${label} | ${metricLabel} | ${bytes(base?.[key]?.[metric])} | ${bytes(headBytes)} | ${change(base?.[key]?.[metric], headBytes)} | ${bytes(limit)}${over} |`;
    }),
  );
  return [
    "## Thread transfer",
    "",
    'Bytes of WebSocket payload the server sends for the large-thread fixture (a 200-turn thread and a 160-thread shell), on the pull request\'s base and head. "After deflate" is what crosses the link; TCP, TLS and WebSocket framing are not counted.',
    "",
    "| Payload | Size | Base | Head | Change | Budget |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}

function readSizes(path: string | undefined): Sizes | undefined {
  try {
    return JSON.parse(NodeFS.readFileSync(path ?? "", "utf8")) as Sizes;
  } catch {
    return undefined;
  }
}

export function runTransferReportMain(
  isMain: boolean,
  argv: ReadonlyArray<string> = process.argv.slice(2),
): boolean {
  if (!isMain) return false;
  const [basePath, headPath, budgetPath] = argv;
  const head = readSizes(headPath);
  if (head === undefined) {
    console.log(
      "## Thread transfer\n\nThe measurement did not produce a result for this commit.\n",
    );
    return true;
  }
  console.log(formatTransferReport(readSizes(basePath), head, readSizes(budgetPath) ?? {}));
  return true;
}

runTransferReportMain(import.meta.main);
