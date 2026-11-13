// @vitest-environment happy-dom
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { remeasureTerminalCharSize } from "./terminalSizing";

// happy-dom has no layout and no `OffscreenCanvas`, so xterm measures its cell with the DOM
// strategy: the width of 32 "W"s in `.xterm-char-measure-element`, and its height (#348).
let cellWidth = 8;
let cellHeight = 16;
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
let host: HTMLDivElement;
let terminal: Terminal;
let fit: FitAddon;

beforeEach(() => {
  cellWidth = 8;
  cellHeight = 16;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element")
        ? cellWidth * 32
        : offsetWidth.get!.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("xterm-char-measure-element")
        ? cellHeight
        : offsetHeight.get!.call(this);
    },
  });
  host = document.createElement("div");
  host.style.width = "640px";
  host.style.height = "320px";
  document.body.append(host);
  terminal = new Terminal({ cols: 20, rows: 5 });
  fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);
  // happy-dom computes no padding from xterm's stylesheet; the fit addon parses it.
  terminal.element!.style.padding = "0px";
  expect(host.querySelector(".xterm-char-measure-element")).not.toBeNull();
  expect(fit.proposeDimensions()).toBeDefined();
  expect(Number.isFinite(fit.proposeDimensions()!.cols)).toBe(true);
});

afterEach(() => {
  terminal.dispose();
  host.remove();
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
});

it(
  "re-measures a changed cell size under an unchanged mount before proposing dimensions",
  { timeout: 30_000 },
  () => {
    const before = fit.proposeDimensions()!;
    // The font's new glyph metrics, which xterm's cached cell size does not see.
    cellWidth = 10;
    expect(fit.proposeDimensions()).toEqual(before);

    expect(remeasureTerminalCharSize(terminal)).toBe(true);

    const after = fit.proposeDimensions()!;
    expect(after.cols).toBeLessThan(before.cols);
    expect(after.rows).toBe(before.rows);
  },
);

// `remeasureTerminalCharSize` calls a private xterm method; an upgrade that drops it must fail
// here, not silently leave a late font with stale cell metrics.
it(
  "the installed xterm still has the private char-size measure the font repaint calls",
  { timeout: 30_000 },
  () => {
    const core = (terminal as unknown as { _core?: { _charSizeService?: { measure?: unknown } } })
      ._core;
    expect(typeof core?._charSizeService?.measure).toBe("function");
  },
);
