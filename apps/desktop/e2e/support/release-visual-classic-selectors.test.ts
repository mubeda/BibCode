// @effect-diagnostics nodeBuiltinImport:off - Actual registered callsite strings drive the installed Classic SDK on an inert protocol port only.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeVM from "node:vm";
import { attach } from "webdriverio";
import { expect, it } from "vite-plus/test";
const popup = '[data-slot="dialog-popup"][role="dialog"]';
const cases = [
  {
    file: "release-visual-project-lifecycle.ts",
    label: "Delete Git worktree and remove",
    old: 'popup + " button=Delete Git worktree and remove"',
    role: "dialog",
  },
  {
    file: "release-visual-project-lifecycle.ts",
    label: "Cancel",
    old: 'popup + " button=Cancel"',
    role: "dialog",
  },
  {
    file: "release-visual-project-lifecycle.ts",
    label: "Cancel clone",
    old: 'popup + " button=Cancel clone"',
    role: "dialog",
  },
  {
    file: "release-visual-settings-followups-caller.ts",
    label: "Remove server",
    old: "'[role=\"alertdialog\"] button=Remove server'",
    role: "alertdialog",
  },
  {
    file: "release-visual-settings-followups-caller.ts",
    label: "Add Server",
    old: "`${dialog} button=Add Server`",
    role: "dialog",
  },
  {
    file: "release-visual-settings-followups-public.ts",
    label: "Save",
    old: 'popup + " button=Save"',
    role: "dialog",
  },
  {
    file: "release-visual-settings-followups-public.ts",
    label: "Cancel",
    old: 'popup + " button=Cancel"',
    role: "dialog",
  },
  {
    file: "release-visual-git-project.ts",
    label: "Abort Merge",
    old: "`${popup} button=Abort Merge`",
    role: "dialog",
  },
] as const;
it.each(cases)(
  "keeps the actual $file $label control scoped with a supported Classic selector",
  async (entry) => {
    const source = NodeFS.readFileSync(new URL("./" + entry.file, import.meta.url), "utf8");
    let expression: string;
    if (source.includes(entry.old))
      expression = source.slice(
        source.indexOf(entry.old),
        source.indexOf(entry.old) + entry.old.length,
      );
    else {
      const marker = 'normalize-space()="' + entry.label + '"]';
      const index = source.indexOf(marker);
      expect(index).toBeGreaterThan(0);
      const begin = source.lastIndexOf("'//*[@", index),
        end = source.indexOf("'", index + marker.length);
      expect(begin).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(begin);
      expression = source.slice(begin, end + 1);
    }
    const selector: string = NodeVM.runInNewContext("(" + expression + ")", {
      popup,
      dialog: popup,
    });
    const requests: Array<{ using: string; value: string }> = [];
    const server = NodeHttp.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url?.endsWith("/window")) {
          response.end(JSON.stringify({ value: "owned-inert-window" }));
          return;
        }
        if (request.url?.endsWith("/element")) {
          const value = JSON.parse(raw);
          requests.push(value);
          if (value.using === "css selector" && value.value.includes(" button=")) {
            response.statusCode = 400;
            response.end(
              JSON.stringify({
                value: {
                  error: "invalid selector",
                  message: "Inert invalid CSS selector.",
                  stacktrace: "",
                },
              }),
            );
            return;
          }
          response.end(
            JSON.stringify({
              value: { "element-6066-11e4-a52e-4f735466cecf": "owned-inert-control" },
            }),
          );
          return;
        }
        response.end(JSON.stringify({ value: null }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Inert protocol address refused.");
      const browser = await attach({
        sessionId: "owned-inert-session",
        capabilities: {
          browserName: "chrome",
          webSocketUrl: false,
          "wdio:enforceWebDriverClassic": true,
        },
        hostname: "127.0.0.1",
        port: address.port,
        logLevel: "silent",
        connectionRetryCount: 0,
        transformRequest: (options: RequestInit) => {
          const headers = new Headers(options.headers);
          headers.delete("Content-Length");
          return { ...options, headers };
        },
      });
      const control = await browser.$(selector);
      expect(control.error).toBeUndefined();
      expect(control.elementId).toBe("owned-inert-control");
      expect(selector).toBe(
        entry.role === "alertdialog"
          ? '//*[@role="alertdialog"]//button[normalize-space()="' + entry.label + '"]'
          : '//*[@data-slot="dialog-popup" and @role="dialog"]//button[normalize-space()="' +
              entry.label +
              '"]',
      );
      expect(requests).toEqual([{ using: "xpath", value: selector }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
