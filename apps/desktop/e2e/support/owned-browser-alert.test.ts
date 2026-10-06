// @effect-diagnostics nodeBuiltinImport:off - An inert loopback WebDriver fixture exercises the installed SDK without launching a browser.
import * as NodeHttp from "node:http";
import { afterEach, expect, it } from "vite-plus/test";
import { attach } from "webdriverio";
import { bindOwnedBrowserAlertObservation } from "./owned-browser-alert.ts";

const servers: NodeHttp.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function fixture(mode: "absent" | "open" | "failure") {
  let alertReads = 0;
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
          value: { sessionId: "inert-owned-session", capabilities: { browserName: "wry" } },
        }),
      );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Inert fixture address refused.");
  const browser = await attach({
    sessionId: "inert-owned-session",
    capabilities: { browserName: "wry" },
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
    bindOwnedBrowserAlertObservation(value.browser);
    expect(await value.browser.isAlertOpen()).toBe(mode === "open");
    expect(value.alertReads()).toBe(1);
  },
);

it("preserves unexpected protocol failures instead of treating them as no alert", async () => {
  const value = await fixture("failure");
  bindOwnedBrowserAlertObservation(value.browser);
  await expect(value.browser.isAlertOpen()).rejects.toMatchObject({ name: "unknown error" });
  expect(value.alertReads()).toBe(1);
});

it("refuses an existing unowned alert observation command", async () => {
  const value = await fixture("absent");
  value.browser.addCommand("isAlertOpen", async () => false);
  expect(() => bindOwnedBrowserAlertObservation(value.browser)).toThrow();
  expect(value.alertReads()).toBe(0);
});
