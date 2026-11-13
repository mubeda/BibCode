// @vitest-environment happy-dom

/** R51: what a caught render error's record may hold, and how it reaches every server. */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createClientCollector } from "./clientCollector";

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setHidden(): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}

const named = (name: string) => Object.assign(new Error("secret"), { name });

describe("render error records", () => {
  it("keeps plain identifiers and known error types only, at most 12 names", async () => {
    const send = vi.fn(async (_environmentId: string, _batch: any) => ({ accepted: true }));
    const c = createClientCollector({
      now: () => 0,
      send,
      supportedEntryTypes: [],
      clientId: "c1",
    });
    c.setEnabledEnvironments(new Set(["env-a"]));
    const webkit = [
      "Panel@https://example.test/assets/app.js:1:200",
      "@https://example.test/assets/app.js:2:10",
      "List@https://example.test/assets/app.js:3:30",
    ].join("\n");
    const v8 = [
      "",
      "    at Panel (https://example.test/assets/app.js:1:200)",
      "    at https://example.test/assets/app.js:2:10",
      ...Array.from({ length: 20 }, (_, n) => `    at Frame${n} (/home/test-user/src/x.tsx:1:1)`),
    ].join("\n");
    // Content where a name should be: a sentence, a path, a dotted name, quotes.
    const hostile = [
      "    at private prompt words (x)",
      "    at /home/test-user/private-project/file.ts",
      "    at Context.Provider (x)",
      '    at "quoted" (x)',
    ].join("\n");
    c.recordRenderError(new Error("secret"), webkit, () => "/settings/general");
    c.recordRenderError(new TypeError("secret"), v8, () => undefined);
    c.recordRenderError(named("private_document.txt"), hostile, () => undefined);
    c.recordRenderError(named("PrivateDocumentError"), null, () => undefined);
    c.recordRenderError("thrown text", null, () => undefined);
    await c.flush();
    const [, batch] = send.mock.calls[0]! as [string, any];
    const [first, second, third, fourth, fifth] = batch.renderErrors;
    expect(first.componentNames).toEqual(["Panel", "Unnamed", "List"]);
    expect(first.routePattern).toBe("/settings/general");
    expect(second.errorType).toBe("TypeError");
    expect(second.componentNames).toHaveLength(12);
    expect(second.componentNames.slice(0, 3)).toEqual(["Panel", "Unnamed", "Frame0"]);
    expect(second.routePattern).toBeNull();
    expect(third).toMatchObject({ errorType: "Other", componentNames: Array(4).fill("Unnamed") });
    expect(fourth.errorType).toBe("Other");
    expect(fifth).toMatchObject({ errorType: "Other", componentNames: [] });
    expect(JSON.stringify(batch)).not.toMatch(
      /secret|thrown text|example\.test|test-user|private|quoted|Provider/i,
    );
    c.dispose();
  });

  it("keeps the newest 8 pending render errors", async () => {
    const send = vi.fn(async (_environmentId: string, _batch: any) => ({ accepted: true }));
    const c = createClientCollector({
      now: () => 0,
      send,
      supportedEntryTypes: [],
      clientId: "c1",
    });
    c.setEnabledEnvironments(new Set(["env-a"]));
    for (let n = 0; n < 10; n += 1) {
      c.recordRenderError(new Error("x"), `at Panel${n} (x)`, () => undefined);
    }
    await c.flush();
    const [, batch] = send.mock.calls[0]! as [string, any];
    expect(batch.renderErrors.map((e: any) => e.componentNames[0])).toEqual(
      Array.from({ length: 8 }, (_, n) => `Panel${n + 2}`),
    );
    c.dispose();
  });

  it("keeps a render error until its environment accepted it, waiting out the pacing", async () => {
    vi.useFakeTimers();
    let t = 0;
    const answers: unknown[] = [{ accepted: true }, { accepted: false, reason: "too-frequent" }];
    const send = vi.fn(
      async (_environmentId: string, _batch: any) => answers.shift() ?? { accepted: true },
    );
    const c = createClientCollector({
      now: () => t,
      send,
      supportedEntryTypes: [],
      clientId: "c1",
    });
    c.setEnabledEnvironments(new Set(["env-a"]));
    c.recordRenderError(new Error("a"), "at First (x)", () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    // Hidden 1 s after an accepted batch: the server would refuse it, so it waits.
    t = 1_000;
    c.recordRenderError(new Error("b"), "at Second (x)", () => undefined);
    setHidden();
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    // The page lived: it goes once the interval allows, and a too-frequent answer keeps it.
    t = 5_000;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(send).toHaveBeenCalledTimes(2);
    t = 10_000;
    await vi.advanceTimersByTimeAsync(5_000);
    const carried = () =>
      send.mock.calls
        .map(([, batch]) => (batch.renderErrors ?? []).map((e: any) => e.componentNames[0]))
        .filter((names) => names.length > 0);
    expect(carried()).toEqual([["First"], ["Second"], ["Second"]]);
    // Accepted: it is not sent again.
    t = 30_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(carried()).toHaveLength(3);
    c.dispose();
  });

  it("reaches every environment, also one with an upload in flight", async () => {
    vi.useFakeTimers();
    let t = 0;
    let release: (value: unknown) => void = () => undefined;
    const received = new Map<string, string[]>();
    const send = vi.fn((environmentId: string, batch: any): Promise<unknown> => {
      for (const e of batch.renderErrors ?? []) {
        received.set(environmentId, [...(received.get(environmentId) ?? []), e.errorType]);
      }
      if (environmentId === "env-a" && send.mock.calls.length === 1) {
        return new Promise((resolve) => (release = resolve));
      }
      return Promise.resolve({ accepted: true });
    });
    const c = createClientCollector({
      now: () => t,
      send,
      supportedEntryTypes: [],
      clientId: "c1",
    });
    c.setEnabledEnvironments(new Set(["env-a"]));
    c.recordRenderError(new Error("first"), null, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    c.setEnabledEnvironments(new Set(["env-a", "env-b"]));
    t = 6_000;
    c.recordRenderError(new RangeError("second"), null, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(received.get("env-b")).toEqual(["RangeError"]);
    release({ accepted: true });
    t = 12_000;
    await vi.advanceTimersByTimeAsync(6_000);
    // The first batch was accepted once released, so only the second error goes after it.
    expect(received.get("env-a")).toEqual(["Error", "RangeError"]);
    c.dispose();
  });

  // Codex finding 6: a flush the pacing holds back must not drop the window's measurements.
  it("keeps the window's measurements while the pacing holds a batch back", async () => {
    vi.useFakeTimers();
    let t = 0;
    const send = vi.fn(async (_environmentId: string, _batch: any) => ({ accepted: true }));
    const c = createClientCollector({
      now: () => t,
      send,
      supportedEntryTypes: [],
      clientId: "c1",
    });
    c.setEnabledEnvironments(new Set(["env-a"]));
    t = 9_000;
    c.recordRenderError(new Error("a"), null, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    const request = c.observeRequest("env-a", "server.getConfig");
    t = 9_200;
    request.complete();
    t = 10_000;
    await c.flush();
    expect(send).toHaveBeenCalledTimes(1);
    t = 20_000;
    await c.flush();
    expect(send).toHaveBeenCalledTimes(2);
    const [, batch] = send.mock.calls[1]! as [string, any];
    expect(batch.histograms.map((h: any) => h.method)).toEqual(["server.getConfig"]);
    // The window runs from the batch at 9 s, so it holds the request.
    expect(batch.windowMs).toBe(11_000);
    c.dispose();
  });

  // Codex finding 7: a pending record leaves only on an explicit acceptance, or on purpose when
  // that server's profiler is off (`{ accepted: false }` with no reason).
  it.each([
    ["accepted", { accepted: true }, "dropped"],
    ["too frequent", { accepted: false, reason: "too-frequent" }, "kept"],
    ["profiler off", { accepted: false }, "dropped"],
    ["unknown reason", { accepted: false, reason: "something-new" }, "kept"],
    ["no answer", undefined, "kept"],
    ["a thrown error", "throw", "kept"],
  ])("after %s, the record is %s", async (_name, answer, outcome) => {
    let t = 0;
    let first = true;
    const send = vi.fn(async (_environmentId: string, _batch: any) => {
      if (!first) return { accepted: true };
      first = false;
      if (answer === "throw") throw new Error("socket closed");
      return answer;
    });
    const c = createClientCollector({
      now: () => t,
      send,
      supportedEntryTypes: [],
      clientId: "c1",
    });
    c.setEnabledEnvironments(new Set(["env-a"]));
    c.recordRenderError(new Error("a"), null, () => undefined);
    await c.flush();
    t = 6_000;
    await c.flush();
    const again = send.mock.calls.slice(1).some(([, batch]) => batch.renderErrors !== undefined);
    expect(again).toBe(outcome === "kept");
    c.dispose();
  });
});
