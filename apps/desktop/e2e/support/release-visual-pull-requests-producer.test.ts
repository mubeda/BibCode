import { expect, it } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off - The finite public driver runs only on inert browser/owner ports.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
const path = "./release-visual-pull-requests-producer.ts";
const api = await import(path).catch((error) => {
  if (NodeFS.existsSync(new NodeURL.URL(path, import.meta.url))) throw error;
  return {};
});
const run = (input: unknown) => {
  const method = Reflect.get(api, "runPullRequestsVisual");
  return typeof method === "function" ? method(input) : Promise.resolve(null);
};
function probe(failure = false) {
  const calls: string[] = [],
    captures: string[] = [],
    values = new Map<string, string>();
  const original = new Error("Inert original UI failure");
  let selected = "github";
  const input = {
    theme: "light",
    origin: "http://127.0.0.1:4885",
    fixture: {
      projects: {
        github: { cwd: "/owned/light/requests/github" },
        gitlab: { cwd: "/owned/light/requests/gitlab" },
      },
    },
    browser: {
      $: (selector: string) => ({
        waitForDisplayed: async () => {},
        waitForEnabled: async () => {},
        click: async () => {
          calls.push(selector);
          if (failure && selector.includes("Checks")) throw original;
        },
        setValue: async (value: string) => {
          values.set(selector, value);
        },
        getValue: async () => values.get(selector) ?? "",
        getText: async () => "The host rejected this operation.",
        getAttribute: async () => "text-destructive",
        isDisplayed: async () => true,
        scrollIntoView: async () => {
          calls.push("public-scroll:" + selector);
        },
      }),
      $$: () => ({ length: Promise.resolve(1) }),
      keys: async () => {},
      performActions: async () => {},
    },
    owner: {
      until: async (check: () => Promise<boolean>) => {
        expect(await check()).toBe(true);
      },
      cleanup: async (_role: string, cleanup: () => Promise<void>) => cleanup(),
    },
    step: (value: string) => calls.push(value),
    openRequests: async (provider: string) => {
      selected = provider;
      return {
        environmentId: "local",
        projectId: "project-" + provider,
        threadId: "thread-" + provider,
        cwd: "/owned/light/requests/" + provider,
      };
    },
    verifyOwnedIdentity: async () => {},
    readContext: async () => ({
      status: "available",
      provider: selected,
      host: selected + ".visual.invalid",
      repository: "owned/requests",
      account: { login: "viewer" },
    }),
    capture: async (binding: { file: string }) => {
      captures.push(binding.file);
    },
    verifyHostingBaselineRestored: async () => {
      calls.push("hosting-restored");
    },
    restoreOriginal: async () => {
      calls.push("restore-original");
    },
    verifyRestoredIdentity: async () => {
      calls.push("verify-original");
    },
  };
  return { input, calls, captures, original };
}
it("runs exactly the five approved rows and their finite substates through public controls", async () => {
  const p = probe();
  const result = await run(p.input);
  expect(result).not.toBeNull();
  expect(p.captures).toHaveLength(24);
  expect(new Set(p.captures).size).toBe(24);
  expect(p.captures.filter((file) => file.includes("-conversation"))).toHaveLength(4);
  expect(
    p.calls.filter(
      (call) =>
        call ===
        'public-scroll:section[aria-label="Pull Requests"] section[aria-label="Comment"] textarea',
    ),
  ).toHaveLength(2);
  expect(
    p.captures.filter((value) =>
      /^request-(?:github|gitlab)-detail-(?:checks|files)-light\.png$/.test(value),
    ),
  ).toHaveLength(4);
  expect(p.calls.at(-2)).toBe("restore-original");
  expect(p.calls.at(-1)).toBe("verify-original");
  const gutter = p.calls.find((selector) => selector.includes('[data-column-number="1"]'));
  expect(gutter?.startsWith(">>>")).toBe(true);
  const desktop = NodeModule.createRequire(new NodeURL.URL("../../package.json", import.meta.url));
  const sdk = NodeFS.readFileSync(
    NodePath.join(NodePath.dirname(desktop.resolve("webdriverio")), "node.js"),
    "utf8",
  );
  const begin = sdk.indexOf("var DEFAULT_STRATEGY ="),
    end = sdk.indexOf("\n//", begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const strategy = NodeVM.runInNewContext(sdk.slice(begin, end) + "\nfindStrategy", {
    DEEP_SELECTOR: ">>>",
    ARIA_SELECTOR: "aria/",
  });
  expect(strategy(gutter, true, false).using).toBe("shadow");
});
it("retains the original failing action and still restores the original public context", async () => {
  const p = probe(true);
  await expect(run(p.input)).rejects.toBe(p.original);
  expect(p.calls.at(-2)).toBe("restore-original");
  expect(p.calls.at(-1)).toBe("verify-original");
  expect(p.captures).toHaveLength(3);
});
it("refuses a foreign imported project before any capture", async () => {
  const p = probe();
  p.input.openRequests = async () => ({
    environmentId: "local",
    projectId: "foreign",
    threadId: "foreign",
    cwd: "/foreign",
  });
  await expect(run(p.input)).rejects.toThrow("Owned request producer refused.");
  expect(p.captures).toHaveLength(0);
});
it("keeps the same finite captures and restoration through the ordinary dark flow", async () => {
  const p = probe();
  p.input.theme = "dark";
  await run(p.input);
  expect(p.captures).toHaveLength(24);
  expect(p.captures.every((file) => file.endsWith("-dark.png"))).toBe(true);
  expect(p.calls.at(-1)).toBe("verify-original");
});
it("retains the original UI exception when attribution and restoration both throw", async () => {
  const p = probe(true);
  Object.assign(p.input, {
    observeFailure: () => {
      throw new Error("Inert observer refusal.");
    },
  });
  p.input.restoreOriginal = async () => {
    throw new Error("Inert restoration refusal.");
  };
  await expect(run(p.input)).rejects.toBe(p.original);
});
it("refuses a successful-looking run when owner cleanup does not execute restoration", async () => {
  const p = probe();
  p.input.owner.cleanup = async () => {};
  await expect(run(p.input)).rejects.toThrow("Owned request producer refused.");
});
it("refuses a run whose separate original public context cannot be verified", async () => {
  const p = probe();
  p.input.verifyRestoredIdentity = async () => {
    throw new Error("Inert foreign restored context.");
  };
  await expect(run(p.input)).rejects.toThrow("Owned request producer refused.");
  expect(p.calls.at(-1)).toBe("restore-original");
});

it.each(["delayed", "cancelled"] as const)(
  "joins the actual producer Undo outcome before its restoration proof: %s",
  async (mode) => {
    const p = probe();
    let returned = false,
      verifyEntered = false,
      complete: () => void = () => {},
      reject: (error: unknown) => void = () => {};
    const original = new Error("Inert cancelled hosting Undo.");
    const pending = new Promise<void>((resolve, rejectValue) => {
      complete = resolve;
      reject = rejectValue;
    });
    p.input.verifyHostingBaselineRestored = async () => {
      verifyEntered = true;
      await pending;
    };
    const execution = run(p.input).then(
      (value: unknown) => {
        returned = true;
        return value;
      },
      (error: unknown) => error,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    expect(verifyEntered).toBe(true);
    if (mode === "delayed") complete();
    else reject(original);
    const result = await execution;
    if (mode === "delayed")
      expect(result).toMatchObject({
        originalContextRestored: true,
        hostingBaselineRestored: true,
      });
    else expect(result).toBe(original);
    expect(p.calls.at(-2)).toBe("restore-original");
    expect(p.calls.at(-1)).toBe("verify-original");
  },
);
