import { describe, expect, it } from "vite-plus/test";
import { resolveActualRetryPrompt } from "./delivery-retry-flow.ts";
import { retryPrompt } from "./delivery-retry-evidence.ts";

const fixture = (options: { initial?: boolean; opens?: boolean; text?: string } = {}) => {
  const calls: string[] = [];
  let open = options.initial === true;
  return {
    calls,
    click: async () => {
      calls.push("click");
      open = options.opens !== false;
    },
    browser: {
      isAlertOpen: async () => open,
      getAlertText: async () => {
        calls.push("read-prompt");
        return options.text ?? retryPrompt;
      },
      dismissAlert: async () => {
        calls.push("dismiss");
        open = false;
      },
      acceptAlert: async () => {
        calls.push("accept");
        open = false;
      },
      waitUntil: async (probe: () => Promise<boolean>, options: { timeout: number }) => {
        expect(options.timeout).toBe(5000);
        if (!(await probe())) throw new Error("Owned prompt did not arrive.");
      },
    },
  };
};

describe("actual Retry prompt interaction", () => {
  it.each(["dismiss", "accept"] as const)(
    "uses only prompt APIs after the actual click: %s",
    async (action) => {
      const f = fixture();
      expect(await resolveActualRetryPrompt(f.browser, f.click, action)).toEqual({
        observed: true,
        exactCopy: true,
        action,
      });
      expect(f.calls).toEqual(["click", "read-prompt", action]);
    },
  );
  it("refuses an already open unrelated prompt before clicking", async () => {
    const f = fixture({ initial: true });
    await expect(resolveActualRetryPrompt(f.browser, f.click, "accept")).rejects.toThrow(/prompt/i);
    expect(f.calls).toEqual([]);
  });
  it("does not confirm a missing or different prompt", async () => {
    for (const options of [{ opens: false }, { text: "private-unexpected-prompt" }]) {
      const f = fixture(options);
      let failure: unknown;
      try {
        await resolveActualRetryPrompt(f.browser, f.click, "accept");
      } catch (error) {
        failure = error;
      }
      expect(failure instanceof Error).toBe(true);
      expect(String(failure)).not.toContain("private-unexpected-prompt");
      expect(f.calls).not.toContain("accept");
      expect(f.calls).not.toContain("dismiss");
    }
  });
});
