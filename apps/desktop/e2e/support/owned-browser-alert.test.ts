// @effect-diagnostics nodeBuiltinImport:off - An inert loopback WebDriver fixture exercises the installed SDK without launching a browser.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { afterEach, expect, it } from "vite-plus/test";
import { attach } from "webdriverio";
import {
  bindOwnedBrowserAlertObservation,
  observeOwnedBrowserAlert,
} from "./owned-browser-alert.ts";
import { resolveActualRetryPrompt } from "./delivery-retry-flow.ts";
import { retryPrompt } from "./delivery-retry-evidence.ts";
import { ownedBrowserOptions } from "./qualification-owner.ts";

const servers: NodeHttp.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function fixture(mode: "absent" | "open" | "failure", chromium = false) {
  let alertReads = 0;
  const capabilities = chromium
    ? {
        browserName: "chrome",
        browserVersion: "149.0.0.0",
        platformName: "linux",
        webSocketUrl: false,
        chrome: { chromedriverVersion: "149.0.0.0" },
        "goog:chromeOptions": {},
      }
    : { browserName: "wry" };
  const server = NodeHttp.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/alert/text")) {
      alertReads++;
      if (mode === "open") response.end(JSON.stringify({ value: "Inert private alert text." }));
      else {
        response.statusCode = mode === "absent" ? 404 : 500;
        response.end(
          JSON.stringify({
            value: {
              error: mode === "absent" ? "no such alert" : "unknown error",
              message: "Inert private error.",
              stacktrace: "",
            },
          }),
        );
      }
    } else
      response.end(
        JSON.stringify({
          value: { sessionId: "inert-owned-session", capabilities },
        }),
      );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Inert fixture address refused.");
  const browser = await attach({
    sessionId: "inert-owned-session",
    capabilities,
    hostname: "127.0.0.1",
    port: address.port,
    logLevel: "silent",
    connectionRetryCount: 0,
  });
  return { browser, alertReads: () => alertReads };
}

it.each(["absent", "open"] as const)(
  "observes %s alerts through the installed SDK command",
  async (mode) => {
    const value = await fixture(mode);
    expect(typeof value.browser.isAlertOpen).toBe("undefined");
    const owned = bindOwnedBrowserAlertObservation(value.browser);
    expect(await observeOwnedBrowserAlert(owned)).toBe(mode === "open");
    expect(value.alertReads()).toBe(1);
  },
);

it("preserves unexpected protocol failures instead of treating them as no alert", async () => {
  const value = await fixture("failure");
  const owned = bindOwnedBrowserAlertObservation(value.browser);
  await expect(observeOwnedBrowserAlert(owned)).rejects.toMatchObject({ name: "unknown error" });
  expect(value.alertReads()).toBe(1);
});

it("refuses an existing unowned alert observation command", async () => {
  const value = await fixture("absent");
  value.browser.addCommand("ownedIsAlertOpen", async () => false);
  expect(() => bindOwnedBrowserAlertObservation(value.browser)).toThrow();
  expect(value.alertReads()).toBe(0);
});

it.each(["absent", "open"] as const)(
  "preserves the installed Chromium alert command while observing %s through the owned command",
  async (mode) => {
    const value = await fixture(mode, true);
    const nativeCommand = value.browser.isAlertOpen;
    expect(typeof nativeCommand).toBe("function");
    const owned = bindOwnedBrowserAlertObservation(value.browser);
    expect(owned).toBe(value.browser);
    expect(owned.isAlertOpen).toBe(nativeCommand);
    expect(await observeOwnedBrowserAlert(owned)).toBe(mode === "open");
    expect(value.alertReads()).toBe(1);
  },
);

it("refuses an existing unowned command in the qualification namespace before any alert read", async () => {
  const value = await fixture("absent");
  const nativeCommand = value.browser.isAlertOpen;
  value.browser.addCommand("ownedIsAlertOpen", async () => false);
  expect(() => bindOwnedBrowserAlertObservation(value.browser)).toThrow();
  expect(value.browser.isAlertOpen).toBe(nativeCommand);
  expect(value.alertReads()).toBe(0);
});

it.each(["dismiss", "accept"] as const)(
  "composes the actual Retry caller port with the installed Chromium SDK for %s",
  async (action) => {
    let open = false;
    let reads = 0;
    let nativeReads = 0;
    const actions: string[] = [];
    const server = NodeHttp.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url?.endsWith("/window")) {
        response.end(JSON.stringify({ value: "inert-main" }));
      } else if (request.url?.endsWith("/alert/text")) {
        reads++;
        if (open) response.end(JSON.stringify({ value: retryPrompt }));
        else {
          response.statusCode = 404;
          response.end(
            JSON.stringify({
              value: { error: "no such alert", message: "Inert absent alert.", stacktrace: "" },
            }),
          );
        }
      } else if (request.url?.endsWith("/alert/" + action) && request.method === "POST") {
        actions.push(action);
        open = false;
        response.end(JSON.stringify({ value: null }));
      } else {
        if (request.url?.endsWith("/alert")) nativeReads++;
        response.statusCode = 500;
        response.end(
          JSON.stringify({
            value: { error: "unknown error", message: "Inert route refused.", stacktrace: "" },
          }),
        );
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Inert fixture address refused.");
    const capabilities = {
      browserName: "chrome",
      browserVersion: "149.0.0.0",
      platformName: "linux",
      webSocketUrl: false,
      chrome: { chromedriverVersion: "149.0.0.0" },
      "goog:chromeOptions": {},
    };
    const browser = await attach({
      ...ownedBrowserOptions("/inert/chrome", "/inert/profile", "http://127.0.0.1:4885"),
      sessionId: "inert-owned-session",
      capabilities,
      hostname: "127.0.0.1",
      port: address.port,
      logLevel: "silent",
      connectionRetryCount: 0,
    });
    const nativeCommand = browser.isAlertOpen;
    bindOwnedBrowserAlertObservation(browser);
    const source = NodeFS.readFileSync(
      new URL("../qualify-delivery-retry.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("  function retryDialogBrowser() {");
    const end = source.indexOf("  async function capture(scene: DeliveryScene", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const make = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(start, end)) + "\nretryDialogBrowser;",
      { b: () => browser, observeOwnedBrowserAlert },
    ) as () => Parameters<typeof resolveActualRetryPrompt>[0];
    const result = await resolveActualRetryPrompt(
      make(),
      async () => {
        open = true;
      },
      action,
    ).catch(() => null);
    expect({ result, reads, nativeReads, actions, open }).toEqual({
      result: { observed: true, exactCopy: true, action },
      reads: 4,
      nativeReads: 0,
      actions: [action],
      open: false,
    });
    expect(browser.isAlertOpen).toBe(nativeCommand);
  },
);
