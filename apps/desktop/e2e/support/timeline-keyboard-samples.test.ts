// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { startKeyboardSamples, type KeyboardSample } from "./timeline-keyboard-samples.ts";

const surface = '[data-center-surface-host][data-visible="true"]';
const lastLine = "Last keyboard line.";
const frames: FrameRequestCallback[] = [];
const paints: Array<() => void> = [];

function timeline(scrollTop: number, streamedParagraphs = 1) {
  const scroller = document.createElement("div");
  scroller.className = "[overflow-anchor:none]";
  Object.defineProperties(scroller, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 2_600 },
  });
  scroller.scrollTop = scrollTop;
  scroller.getBoundingClientRect = () => DOMRect.fromRect({ width: 800, height: 600 });
  const markdown = document.createElement("div");
  markdown.className = "chat-markdown";
  for (const text of [
    "Keyboard reply intro.",
    ...Array.from(
      { length: streamedParagraphs },
      (_, index) => `Keyboard streamed paragraph ${index + 1}`,
    ),
    lastLine,
  ]) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    paragraph.getBoundingClientRect = () =>
      DOMRect.fromRect({ y: 2_580 - scroller.scrollTop, height: 20 });
    markdown.append(paragraph);
  }
  scroller.append(markdown);
  return scroller;
}

async function sampleTimeline() {
  vi.stubGlobal("browser", {
    execute: async (
      callback: (surface: string, lastLine: string) => void,
      ...args: [string, string]
    ) => callback(...args),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal(
    "MessageChannel",
    class {
      listener = () => {};
      port1 = {
        addEventListener: (_type: string, listener: () => void) => {
          this.listener = listener;
        },
        start: () => {},
        close: () => {},
      };
      port2 = { postMessage: () => paints.push(this.listener), close: () => {} };
    },
  );
  await startKeyboardSamples(surface, lastLine);
  const state = Reflect.get(window, "__bibcodeKeyboard") as { samples: KeyboardSample[] };
  return () => {
    frames.shift()!(performance.now());
    paints.shift()!();
    return state.samples.at(-1)!;
  };
}

afterEach(() => {
  Reflect.get(window, "__bibcodeKeyboardStop")?.();
  document.body.replaceChildren();
  frames.length = 0;
  paints.length = 0;
  vi.unstubAllGlobals();
});

it("samples the mounted list after replacement, without mixing detached and live geometry (#215)", async () => {
  const host = document.createElement("div");
  host.dataset.centerSurfaceHost = "chat:host";
  host.dataset.visible = "true";
  const old = timeline(2_000);
  host.append(old);
  document.body.append(host);
  const sample = await sampleTimeline();
  expect(sample()).toMatchObject({ scrollTop: 2_000, endGap: 0, endBelow: 0 });

  for (let iteration = 0; iteration < 3; iteration += 1) {
    // Native detached scrollers report zero, while document queries find the new reply.
    host.firstElementChild!.replaceWith(timeline(2_000));
    old.scrollTop = 0;
    host
      .querySelector("p")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    // A detached list's events must not count toward the current list.
    old.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(sample()).toMatchObject({
      scrollTop: 2_000,
      endGap: 0,
      endBelow: 0,
      keydowns: iteration + 1,
    });
  }
});

it("still exposes a real scroll reset on the replacement list", async () => {
  const host = document.createElement("div");
  host.dataset.centerSurfaceHost = "chat:host";
  host.dataset.visible = "true";
  host.append(timeline(2_000));
  document.body.append(host);
  const sample = await sampleTimeline();
  sample();
  host.firstElementChild!.replaceWith(timeline(0));
  expect(sample()).toMatchObject({ scrollTop: 0, endGap: 2_000, endBelow: 2_000 });
});

it("leaves a still-connected inactive surface behind when the visible list changes", async () => {
  const previous = document.createElement("div");
  previous.dataset.centerSurfaceHost = "chat:old";
  previous.dataset.visible = "true";
  previous.append(timeline(2_000));
  document.body.append(previous);
  const sample = await sampleTimeline();
  sample();
  previous.dataset.visible = "false";
  previous.firstElementChild!.scrollTop = 0;
  const current = document.createElement("div");
  current.dataset.centerSurfaceHost = "chat:current";
  current.dataset.visible = "true";
  current.append(timeline(2_000));
  document.body.append(current);
  expect(previous.isConnected).toBe(true);
  expect(sample()).toMatchObject({ scrollTop: 2_000, endGap: 0, endBelow: 0 });
});

it("counts the current reply and waits for its settle even when an earlier iteration finished", async () => {
  const host = document.createElement("div");
  host.dataset.centerSurfaceHost = "chat:host";
  host.dataset.visible = "true";
  const scroller = timeline(2_000, 30);
  const previous = scroller.querySelector<HTMLElement>(".chat-markdown")!;
  previous.getBoundingClientRect = () => DOMRect.fromRect({ y: -10_000, height: 2_600 });
  const current = timeline(2_000, 30).querySelector<HTMLElement>(".chat-markdown")!;
  current.lastElementChild!.remove();
  scroller.append(current);
  const working = document.createElement("div");
  working.dataset.timelineRowKind = "working";
  scroller.append(working);
  host.append(scroller);
  document.body.append(host);
  const sample = await sampleTimeline();
  expect(sample()).toMatchObject({ delivered: 30, finished: false });
  const finalLine = document.createElement("p");
  finalLine.textContent = lastLine;
  current.append(finalLine);
  expect(sample()).toMatchObject({ delivered: 31, finished: false });
  working.remove();
  expect(sample()).toMatchObject({ delivered: 31, finished: true });
});
