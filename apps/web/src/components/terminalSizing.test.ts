// @vitest-environment happy-dom
import { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vite-plus/test";
import { terminalInputKey } from "@bibcode/client-runtime/state/terminal";
import {
  isTerminalSizingMinimum,
  proposeTerminalDimensions,
  readTerminalFittedSize,
  registerTerminalSizeReader,
} from "./terminalSizing";

/** The real fit addon over a stub xterm whose screen sits in `host` (#348). */
function fitAddonIn(host: HTMLElement): FitAddon {
  const element = document.createElement("div");
  element.style.padding = "0px";
  host.append(element);
  const terminal = {
    element,
    cols: 80,
    rows: 24,
    options: { scrollback: 5_000 },
    _core: { _renderService: { dimensions: { css: { cell: { width: 7, height: 14 } } } } },
  };
  const fit = new FitAddon();
  fit.activate(terminal as unknown as Terminal);
  return fit;
}

describe("terminal fitting", () => {
  it("proposes no size for a laid-out host with no area instead of the addon's 2-column floor", () => {
    const host = document.createElement("div");
    host.style.width = "0px";
    host.style.height = "336px";
    document.body.append(host);
    const fit = fitAddonIn(host);
    // A zero-width host, such as a center panel behind a maximized right panel,
    // makes the upstream addon propose its minimum width rather than nothing.
    expect(fit.proposeDimensions()).toEqual({ cols: 2, rows: 24 });
    expect(proposeTerminalDimensions(fit, host)).toBeNull();

    host.style.width = "574px";
    host.style.height = "0px";
    expect(fit.proposeDimensions()).toEqual({ cols: 80, rows: 1 });
    expect(proposeTerminalDimensions(fit, host)).toBeNull();

    host.style.height = "336px";
    expect(proposeTerminalDimensions(fit, host)).toEqual({ cols: 80, rows: 24 });
    host.remove();
  });

  it("uses the protocol bounds for fitted sizes and ignores unmeasurable geometry", () => {
    expect(
      proposeTerminalDimensions({ proposeDimensions: () => ({ cols: 3000, rows: 900 }) }),
    ).toEqual({ cols: 1000, rows: 500 });
    expect(proposeTerminalDimensions({ proposeDimensions: () => ({ cols: 0, rows: 0 }) })).toEqual({
      cols: 1,
      rows: 1,
    });
    expect(proposeTerminalDimensions({ proposeDimensions: () => undefined })).toBeNull();
    expect(
      proposeTerminalDimensions({ proposeDimensions: () => ({ cols: NaN, rows: 20 }) }),
    ).toBeNull();
    expect(
      proposeTerminalDimensions({
        proposeDimensions: () => {
          throw new Error("detached");
        },
      }),
    ).toBeNull();
  });

  it("reads only mounted renderer sizes on demand and does not remove a replacement reader", () => {
    const key = terminalInputKey("env", "thread", "term");
    expect(readTerminalFittedSize("env", "thread", "term")).toBeNull();
    let dimensions = { cols: 91, rows: 42 };
    const unregister = registerTerminalSizeReader(key, () => dimensions);
    expect(readTerminalFittedSize("env", "thread", "term")).toEqual({ cols: 91, rows: 42 });
    dimensions = { cols: 151, rows: 50 };
    expect(readTerminalFittedSize("env", "thread", "term")).toEqual({ cols: 151, rows: 50 });
    const replace = registerTerminalSizeReader(key, () => ({ cols: 80, rows: 24 }));
    unregister();
    expect(readTerminalFittedSize("env", "thread", "term")).toEqual({ cols: 80, rows: 24 });
    replace();
    expect(readTerminalFittedSize("env", "thread", "term")).toBeNull();
  });
});

describe("terminal sizing minimum (#348)", () => {
  it("marks what the fit proposes for a mount a few pixels wide or tall", () => {
    expect(isTerminalSizingMinimum({ cols: 2, rows: 26 })).toBe(true);
    expect(isTerminalSizingMinimum({ cols: 85, rows: 1 })).toBe(true);
    expect(isTerminalSizingMinimum({ cols: 5, rows: 26 })).toBe(false);
    expect(isTerminalSizingMinimum({ cols: 18, rows: 4 })).toBe(false);
  });
});
