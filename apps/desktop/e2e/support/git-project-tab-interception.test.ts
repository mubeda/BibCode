// @effect-diagnostics nodeBuiltinImport:off - The exact helper source runs over inert command ports only.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import * as Evidence from "./git-project-tab-interception.ts";

const project = (error: unknown, phase: unknown, selection: unknown) =>
  Reflect.get(Evidence, "projectGitProjectTabInterception")?.(error, phase, selection) ?? null;
const intercepted = () =>
  new Error(
    'element click intercepted: Other element would receive the click: <div data-slot="toast-viewport" data-ending-style>',
  );

it.each(["click", "displayed", "unique", "enabled", "reporter"])(
  "attributes the exact existing tab await and preserves its original outcome: %s",
  async (failureAt) => {
    const source = NodeFS.readFileSync(
      NodePath.resolve("apps/desktop/e2e/support/release-visual-git-project.ts"),
      "utf8",
    );
    const body = source.indexOf("export async function runGitProjectVisual(");
    const first = source.indexOf("  const click = async (", body);
    const last = source.indexOf("  const capture = async (", first);
    const tabFirst = source.indexOf("  const tab = async (", last);
    const tabLast = source.indexOf("  const openGit = async (", tabFirst);
    expect(first).toBeGreaterThan(body);
    expect(last).toBeGreaterThan(first);
    expect(tabLast).toBeGreaterThan(tabFirst);
    const phases: string[] = [],
      calls: string[] = [];
    const original = new Error("Inert original tab command failure.");
    const command = async (operation: string) => {
      calls.push(operation);
      if (failureAt === operation) throw original;
    };
    const input = {
      step: (phase: string) => {
        if (failureAt === "reporter") throw new Error("Inert optional reporter failure.");
        phases.push(phase);
      },
    };
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){" +
          source.slice(first, last) +
          source.slice(tabFirst, tabLast) +
          'await tab("Changes");}\nrun',
      ),
      {
        input,
        observeDirectoryAwait: () => {},
        refused: () => original,
        browser: {
          $: () => ({
            waitForDisplayed: () => command("displayed"),
            waitForEnabled: () => command("enabled"),
            click: () => command("click"),
          }),
          $$: () => ({ length: command("unique").then(() => 1) }),
        },
      },
    ) as () => Promise<void>;
    if (failureAt === "reporter") {
      await run();
      expect(calls).toEqual(["displayed", "unique", "enabled", "click"]);
    } else {
      expect(await run().catch((error: unknown) => error)).toBe(original);
      expect(phases.at(-1)).toBe(`visual-git-project-tab-changes-${failureAt}`);
      expect(calls).toEqual(["displayed", "unique", "enabled", "click"].slice(0, calls.length));
    }
  },
);

describe("original Git/project tab click attribution", () => {
  it.each(["changes", "history", "tags"])(
    "retains only closed facts at the actual %s click",
    (tab) => {
      const error = intercepted();
      expect(
        project(error, `visual-git-project-tab-${tab}-click`, "release-visual-git-project"),
      ).toEqual({
        tab,
        receiverSlot: "toast-viewport",
        receiverEndingStyle: true,
      });
    },
  );

  it.each([
    "import-verify-claude-opus",
    "visual-git-project-tab-changes-displayed",
    "visual-git-project-tab-changes-enabled",
    "visual-git-project-tab-changes-completed",
    "visual-git-project-tab-unknown-click",
    "visual-git-project-tab-Changes-click",
    null,
    {},
  ])("refuses attribution outside the exact controlled click phase: %j", (phase) => {
    expect(project(intercepted(), phase, "release-visual-git-project")).toBeNull();
  });

  it.each(["release-visual-core", "release-visual-settings", null, {}])(
    "refuses unrelated selections: %j",
    (selection) => {
      expect(project(intercepted(), "visual-git-project-tab-changes-click", selection)).toBeNull();
    },
  );

  it("does not read live accessors, replace the original error, or retain raw markup", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "message", {
      get: () => {
        reads++;
        throw new Error("Inert accessor must not run.");
      },
    });
    expect(
      project(accessor, "visual-git-project-tab-changes-click", "release-visual-git-project"),
    ).toBeNull();
    expect(reads).toBe(0);
    const error = intercepted();
    const message = error.message;
    const result = project(
      error,
      "visual-git-project-tab-changes-click",
      "release-visual-git-project",
    );
    expect(result).toEqual({
      tab: "changes",
      receiverSlot: "toast-viewport",
      receiverEndingStyle: true,
    });
    expect(error.message).toBe(message);
    expect(JSON.stringify(result)).not.toContain("<div");
    expect(
      project(
        new Error("Inert unrelated failure."),
        "visual-git-project-tab-changes-click",
        "release-visual-git-project",
      ),
    ).toBeNull();
  });
});
