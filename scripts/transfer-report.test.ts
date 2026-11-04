import { describe, expect, it } from "vite-plus/test";

import { formatTransferReport, runTransferReportMain, type Sizes } from "./transfer-report.ts";

const sizes = (shell: number, thread: number, resume: number): Sizes => ({
  shell: { wireBytes: shell, decodedBytes: shell * 4 },
  thread: { wireBytes: thread, decodedBytes: thread * 4 },
  resume: { wireBytes: resume, decodedBytes: resume * 4 },
});

describe("formatTransferReport", () => {
  it("shows base, head, the change and the budget per payload", () => {
    const report = formatTransferReport(
      sizes(1000, 5000, 200),
      sizes(1100, 5000, 100),
      sizes(2000, 6000, 300),
    );
    expect(report).toContain(
      "| Shell snapshot (`subscribeShell`, first item) | after deflate | 1,000 B | 1,100 B | +100 B (+10.0%) | 2,000 B |",
    );
    expect(report).toContain(
      "| Big thread, first `subscribeThread` item | after deflate | 5,000 B | 5,000 B | no change | 6,000 B |",
    );
    expect(report).toContain(
      "| Big thread, resume answer (`unchanged`) | decoded | 800 B | 400 B | -400 B (-50.0%) | 1,200 B |",
    );
  });

  it("shows the capped shell (#223), and n/a for a base measured before it", () => {
    const capped = { cappedShell: { wireBytes: 900, decodedBytes: 3600 } };
    const report = formatTransferReport(
      sizes(1000, 5000, 200),
      { ...sizes(1000, 5000, 200), ...capped },
      {
        ...sizes(2000, 6000, 300),
        cappedShell: { wireBytes: 950, decodedBytes: 3700 },
      },
    );
    expect(report).toContain(
      "| Capped shell snapshot (`subscribeShell` with `cap`, first item) | after deflate | n/a | 900 B | n/a | 950 B |",
    );
  });

  it("marks a payload over its budget and a base that has no measurement", () => {
    const report = formatTransferReport(undefined, sizes(3000, 1, 1), sizes(2000, 1, 1));
    expect(report).toContain("| n/a | 3,000 B | n/a | 2,000 B **over budget** |");
  });
});

it("does not run when imported", () => {
  expect(runTransferReportMain(false, [])).toBe(false);
});
