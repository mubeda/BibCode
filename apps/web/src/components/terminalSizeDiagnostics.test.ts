import { beforeEach, expect, it } from "vite-plus/test";
import {
  clearTerminalSizeDiagnostics,
  readTerminalSizeDiagnostics,
  recordTerminalSizeDiagnostic,
  setTerminalSizeDiagnosticsEnabled,
  type TerminalSizeDiagnosticRecord,
} from "./terminalSizeDiagnostics";

function record(rendererGeneration: number): Omit<TerminalSizeDiagnosticRecord, "at"> {
  return {
    trigger: "layout",
    rendererGeneration,
    mountWidth: 640,
    mountHeight: 320,
    fitted: { cols: 80, rows: 24 },
    applied: null,
    role: "legacy",
    devicePixelRatio: 1,
    fontStatus: "loaded",
    renderer: "standard",
    request: null,
    repaint: "none",
  };
}

beforeEach(() => {
  setTerminalSizeDiagnosticsEnabled(true);
  clearTerminalSizeDiagnostics();
});

it("size diagnostics keep the last 200 records, oldest first", () => {
  for (let index = 0; index < 205; index += 1) recordTerminalSizeDiagnostic(record(index));
  const records = readTerminalSizeDiagnostics();
  expect(records).toHaveLength(200);
  expect(records[0]!.rendererGeneration).toBe(5);
  expect(records.at(-1)!.rendererGeneration).toBe(204);
});

it("size diagnostics record nothing while disabled", () => {
  setTerminalSizeDiagnosticsEnabled(false);
  recordTerminalSizeDiagnostic(record(1));
  setTerminalSizeDiagnosticsEnabled(true);
  expect(readTerminalSizeDiagnostics()).toEqual([]);
});

it("size diagnostics clear the ring when disabled", () => {
  recordTerminalSizeDiagnostic(record(1));
  expect(readTerminalSizeDiagnostics()).toHaveLength(1);
  setTerminalSizeDiagnosticsEnabled(false);
  setTerminalSizeDiagnosticsEnabled(true);
  expect(readTerminalSizeDiagnostics()).toEqual([]);
});
