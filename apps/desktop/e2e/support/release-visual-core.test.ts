// @effect-diagnostics nodeBuiltinImport:off - Synthetic PNG and inert WebDriver boundary only; no browser or server starts.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { describe, expect, it, vi } from "vite-plus/test";
import { captureVisualScene, type VisualCaptureInput } from "./release-visual-core.ts";
import { readVisualWitness } from "./release-visual-observation.ts";

function png() {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    out.write(type, 4);
    data.copy(out, 8);
    out.writeUInt32BE(NodeZlib.crc32(out.subarray(4, -4)), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1280, 0);
  header.writeUInt32BE(960, 4);
  header[8] = 8;
  header[9] = 2;
  const data = Buffer.alloc((1280 * 3 + 1) * 960);
  for (let y = 0; y < 960; y++) {
    data.fill(y % 256, y * 3841 + 1, (y + 1) * 3841);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(data)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const proof = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: true,
  targetInView: true,
  credentialAbsent: true,
  bootShellAbsent: true,
  singlePalette: true,
  filteredAction: true,
  singleActiveRow: true,
  inputFocused: true,
};
function boundary() {
  const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "visual-evidence-test-"));
  const bytes = png();
  const browser = {
    isAlertOpen: vi.fn(async () => false),
    execute: vi.fn(async (read: unknown) => {
      expect(read).toBe(readVisualWitness);
      return proof;
    }),
    takeScreenshot: vi.fn(async () => bytes.toString("base64")),
  };
  const input = {
    scene: "command-palette",
    theme: "light",
    origin: "http://127.0.0.1:4885",
    threadId: "owned",
    branch: "codex/delivery-retry-light",
    evidence,
    browser,
    captured: new Set<string>(),
    owner: {
      until: async (read: () => Promise<boolean>) => {
        if (!(await read())) throw new Error("Owned observation timeout.");
      },
    },
  } as unknown as VisualCaptureInput;
  return {
    input,
    browser,
    bytes,
    close: () => NodeFS.rmSync(evidence, { recursive: true, force: true }),
  };
}
describe("original visual capture boundary", () => {
  it("writes original bytes only after both read-only witnesses pass and refuses a duplicate", async () => {
    const f = boundary();
    try {
      const capture = await captureVisualScene(f.input);
      expect(capture).toMatchObject({
        scene: "command-palette",
        theme: "light",
        file: "command-palette-light.png",
        width: 1280,
        height: 960,
        nonBlank: true,
        witness: proof,
      });
      expect(
        NodeFS.readFileSync(NodePath.join(f.input.evidence, "command-palette-light.png")),
      ).toEqual(f.bytes);
      expect(f.browser.execute).toHaveBeenCalledTimes(2);
      await expect(captureVisualScene(f.input)).rejects.toThrow();
      expect(f.browser.takeScreenshot).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(capture)).not.toMatch(/owned|4885|delivery-retry/);
    } finally {
      f.close();
    }
  });
  it.each(["invalid-scene", "alert", "before", "after", "driver"])(
    "retains no PNG after %s failure",
    async (failure) => {
      const f = boundary();
      try {
        if (failure === "invalid-scene") f.input.scene = "native-share-refresh" as never;
        if (failure === "alert") f.browser.isAlertOpen.mockResolvedValue(true);
        if (failure === "before")
          f.browser.execute.mockResolvedValue({ ...proof, credentialAbsent: false });
        if (failure === "after")
          f.browser.execute
            .mockResolvedValueOnce(proof)
            .mockResolvedValue({ ...proof, selectedMatched: false });
        if (failure === "driver")
          f.browser.takeScreenshot.mockRejectedValue(new Error("private-token"));
        await expect(captureVisualScene(f.input)).rejects.toThrow();
        expect(NodeFS.readdirSync(f.input.evidence)).toEqual([]);
        expect(f.input.captured.size).toBe(0);
        if (["invalid-scene", "alert", "before"].includes(failure))
          expect(f.browser.takeScreenshot).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );
});

import { runVisualCore, type VisualCoreInput } from "./release-visual-core.ts";
it("checks the shared managed-worktree identity before the first exact scene and propagates capture failure", async () => {
  const order: string[] = [];
  const stopped = new Error("fixture capture stopped");
  const input = {
    browser: {},
    owner: {},
    threadId: "owned",
    branch: "codex/delivery-retry-light",
    step: (phase: string) => order.push(phase),
    verifyManaged: async () => {
      order.push("verified-managed");
    },
    capture: async (scene: string) => {
      order.push(scene);
      throw stopped;
    },
  } as unknown as VisualCoreInput;
  await expect(runVisualCore(input)).rejects.toBe(stopped);
  expect(order).toEqual(["verified-managed", "visual-workspace-composite", "workspace-composite"]);
});
it("runs only the eight fixed scenes via public controls and keeps image inspection separate from PNG coverage", async () => {
  const calls: string[] = [],
    captures: string[] = [];
  const element = (selector: string): object => ({
    waitForDisplayed: async () => {},
    waitForEnabled: async () => {},
    isFocused: async () => true,
    isDisplayed: async () => selector !== "[data-right-panel-tabbar]",
    click: async () => {
      calls.push(`click:${selector}`);
    },
    setValue: async (value: string) => {
      calls.push(`input:${selector}:${value}`);
    },
    moveTo: async () => {
      calls.push(`hover:${selector}`);
    },
    scrollIntoView: async () => {
      calls.push(`scroll:${selector}`);
    },
    getText: async () => "Owned visual review draft",
    shadow$: (next: string) => element(selector + " >> " + next),
  });
  const input = {
    browser: {
      $: element,
      $$: () => ({ length: Promise.resolve(1) }),
      keys: async (key: unknown) => {
        calls.push(`key:${JSON.stringify(key)}`);
      },
      execute: async (read: { name: string }) =>
        read.name === "readVisualImageLoaded" ? true : { x: 0, y: 0 },
    },
    owner: {
      until: async (read: () => Promise<boolean>) => {
        expect(await read()).toBe(true);
      },
    },
    threadId: "owned",
    branch: "codex/delivery-retry-light",
    step: () => {},
    verifyManaged: async () => {
      calls.push("verify-managed");
    },
    openWorktreeDialog: async () => {
      calls.push("shared-worktree-opener");
    },
    partialStageMatches: () => {
      calls.push("read-actual-partial-stage");
      return true;
    },
    capture: async (scene: string) => {
      calls.push(`capture:${scene}`);
      captures.push(scene);
    },
  } as unknown as VisualCoreInput;
  const result = await runVisualCore(input);
  expect(captures).toEqual([
    "workspace-composite",
    "workspace-card-menu",
    "worktree-create-ref",
    "git-changes-diff",
    "git-history-stashes",
    "git-branch-menu",
    "files-editor-comment",
    "command-palette",
  ]);
  expect(calls.filter((call) => call === "shared-worktree-opener")).toHaveLength(1);
  expect(calls).toContain(
    'input:[data-slot="dialog-popup"][role="dialog"] input[placeholder="Worktree name"]:',
  );
  expect(calls).not.toContain(
    'click://*[@data-slot="dialog-popup"]//button[normalize-space()="visual-held"]',
  );

  expect(calls).toContain('key:["Shift","F10"]');
  expect(calls.indexOf("read-actual-partial-stage")).toBeLessThan(
    calls.indexOf("capture:git-changes-diff"),
  );
  expect(calls).toContain('scroll:button[aria-label="Select stash stash@{11}"]');
  expect(result).toEqual({
    managedIdentityMatched: true,
    partialStageVerified: true,
    imageDiffInspected: true,
    dialogCancelled: true,
    draftRetained: true,
    noCommandExecuted: true,
    unpictured: ["git-image-diff", "files-context-menu", "workspace-terminal-and-other-chat"],
  });
});
