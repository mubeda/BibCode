// @effect-diagnostics nodeBuiltinImport:off - Source policy and inert owner execution never start native services.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
const controller = NodeFS.readFileSync(
  new URL("../qualify-delivery-retry.ts", import.meta.url),
  "utf8",
);
function readOnlyPolicy(source: string) {
  const executable = NodeModule.stripTypeScriptTypes(source);
  if (
    /\bimport\s|\b(?:localStorage|sessionStorage|indexedDB)\b|\.(?:setState|getState|dispatchEvent|click|focus|setAttribute|removeAttribute|setItem|removeItem|write|evaluate|execCommand|scrollIntoView)\s*\(|\.[A-Za-z_$][\w$]*\s*=(?!=|>)/.test(
      executable,
    )
  )
    throw new Error("Visual reader mutation refused.");
  return new NodeVM.Script(executable.replaceAll("export ", ""));
}
describe("visual preparation source boundaries", () => {
  it("keeps browser readers import-free after type stripping and rejects DOM/store mutation regressions", () => {
    const source = NodeFS.readFileSync(
      new URL("./release-visual-observation.ts", import.meta.url),
      "utf8",
    );
    expect(() => readOnlyPolicy(source)).not.toThrow();
    for (const mutation of [
      "document.body.click()",
      "document.body.innerHTML = 'fixture'",
      "window.store.setState({})",
      "localStorage.setItem('token','x')",
      "document.body.dispatchEvent(new Event('click'))",
    ])
      expect(() => readOnlyPolicy(source + "\n" + mutation)).toThrow(
        "Visual reader mutation refused.",
      );
  });
  it.each(["delivery-retry-ui", "release-visual-core"])(
    "executes the shared finally owner and closed failure result for %s",
    async (selection) => {
      let cleanup = 0;
      const receipts: Record<string, object> = {};
      const start = controller.indexOf("export async function runDeliveryRetryQualification()");
      const end = controller.indexOf("if (import.meta.main)", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const run = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          controller.slice(start, end).replace("export ", "") + "\nrunDeliveryRetryQualification",
        ),
        {
          deliveryConfiguration: () => ({
            fixture: "/owned",
            evidence: "/evidence",
            selection,
            source: "a".repeat(40),
          }),
          QualificationOwner: class {
            processes = [];
            failures = [];
            async close() {
              cleanup++;
            }
            childrenClosed() {
              return true;
            }
          },
          root: "/source",
          process: { env: {} },
          NodeFS: {
            writeFileSync: (path: string, bytes: string) => {
              receipts[path] = JSON.parse(bytes);
            },
          },
          NodePath: { join: (...parts: string[]) => parts.join("/") },
          prepareOwnedNetwork: async () => {
            throw new Error("private-token?grant=secret");
          },
          classifyQualificationFailure: () => "other",
        },
      );
      expect(await run()).toBe(1);
      expect(cleanup).toBe(1);
      expect(receipts["/evidence/result.json"]).toMatchObject({
        success: false,
        selection,
        childProcessesClosed: true,
        captures: [],
      });
      expect(JSON.stringify(receipts)).not.toMatch(/private-token|grant=secret/);
    },
  );
  it("routes the fixed sequence through the shared worktree opener, identity proofs, and capture owner", () => {
    const visualStart = controller.indexOf("const proof = await runVisualCore({");
    const visualEnd = controller.indexOf("assertions.push({ theme, ...proof });", visualStart);
    expect(visualStart).toBeGreaterThan(0);
    expect(visualEnd).toBeGreaterThan(visualStart);
    const actualOptions = controller.slice(visualStart, visualEnd);
    for (const boundary of [
      "openWorktreeDialog,",
      "readSelectedDeliveryWorktree",
      "readOwnedDeliveryWorktree(visualInput)",
      "captureVisualScene",
      "visualPartialStageMatches(visualInput)",
    ])
      expect(actualOptions).toContain(boundary);
    const source = NodeFS.readFileSync(
      new URL("./release-visual-core.ts", import.meta.url),
      "utf8",
    );
    const sequence = source.slice(source.indexOf("export async function runVisualCore("));
    expect(sequence).not.toMatch(
      /takeScreenshot|saveScreenshot|writeFile|setState|dispatchEvent|browser\.url\(/,
    );
    const reads = [...sequence.matchAll(/browser\.execute\(([^,)]+)/g)].map((match) => match[1]);
    expect(reads).toEqual([
      "readVisualImageLoaded",
      "readVisualPageScroll",
      "readVisualPageScroll",
    ]);
  });
});
it.each([false, true])(
  "waits for the same public managed card before reading Git; permanently stale=%s",
  async (stale) => {
    const begin = controller.indexOf("          verifyManaged: async () => {");
    const end = controller.indexOf("          partialStageMatches:", begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    let reads = 0,
      gitReads = 0;
    const identity = {
      path: "/private/managed",
      branch: "codex/delivery-retry-light",
      commonDirectory: "/private/project/.git",
    };
    const fn = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes("({" + controller.slice(begin, end) + "}).verifyManaged"),
      {
        b: () => ({
          execute: async () => ({ threadId: ++reads === 1 || stale ? "other" : "owned" }),
        }),
        readSelectedDeliveryWorktree: () => {},
        readOwnedDeliveryWorktree: () => {
          gitReads++;
          return identity;
        },
        visualInput: {},
        origin: "http://127.0.0.1:4885",
        workspace: { ...identity, threadId: "owned" },
        check: (value: unknown) => {
          if (!value) throw new Error("Owned refusal.");
        },
        owner: {
          until: async (read: () => Promise<boolean>) => {
            for (let attempt = 0; attempt < 2; attempt++) if (await read()) return;
            throw new Error("Owned refusal.");
          },
        },
      },
    );
    if (stale) {
      await expect(fn()).rejects.toThrow("Owned refusal.");
      expect(gitReads).toBe(0);
    } else {
      await fn();
      expect(reads).toBe(2);
      expect(gitReads).toBe(1);
    }
  },
);
