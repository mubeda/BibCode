// @effect-diagnostics nodeBuiltinImport:off - Native navigation fixtures use disposable logs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { readNativePageLoad, refreshDesktopUiDocument } from "./document-navigation.ts";

const previous = "11111111-1111-4111-8111-111111111111";
const next = "22222222-2222-4222-8222-222222222222";
afterEach(() => vi.unstubAllGlobals());

it("does not accept stale completions, other log lines, or an unfinished navigation", () => {
  expect(readNativePageLoad("unrelated log")).toBeUndefined();
  expect(
    readNativePageLoad(
      `INFO desktop_e2e_page_load_finished id=${previous}\nINFO desktop_e2e_page_load_started id=${next}\n`,
    ),
  ).toEqual({ phase: "started", id: next });
});

it("waits for the replacement native completion without executing JavaScript during reload", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "desktop-navigation-"));
  NodeFS.mkdirSync(NodePath.join(root, "userdata", "logs"), { recursive: true });
  const path = NodePath.join(root, "userdata", "logs", "server.log");
  const append = (phase: string, id: string) =>
    NodeFS.appendFileSync(path, `INFO desktop_e2e_page_load_${phase} id=${id}\n`);
  append("finished", previous);
  const readiness: boolean[] = [];
  vi.stubGlobal("browser", {
    execute: async () => {
      throw new Error("Script execution lost during navigation");
    },
    refresh: async () => undefined,
    waitUntil: async (predicate: () => boolean) => {
      if (predicate()) return;
      readiness.push(false);
      append("started", next);
      readiness.push(predicate());
      append("finished", next);
      readiness.push(predicate());
    },
  });
  try {
    await refreshDesktopUiDocument(root);
    expect(readiness).toEqual([false, false, true]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
