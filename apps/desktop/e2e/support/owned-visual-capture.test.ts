// @effect-diagnostics nodeBuiltinImport:off - Own synthetic PNG/filesystem and inert capture ports only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { expect, it } from "vite-plus/test";
import { captureOwnedVisualScene } from "./owned-visual-capture.ts";

function originalPng(width = 1280, height = 960): Buffer {
  const chunk = (kind: string, data: Buffer) => {
    const buffer = Buffer.alloc(data.length + 12);
    buffer.writeUInt32BE(data.length);
    buffer.write(kind, 4, "ascii");
    data.copy(buffer, 8);
    buffer.writeUInt32BE(NodeZlib.crc32(buffer.subarray(4, buffer.length - 4)), buffer.length - 4);
    return buffer;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      rows[offset] = x < width / 2 ? 200 : 20;
      rows[offset + 1] = 40;
      rows[offset + 2] = x < width / 2 ? 20 : 200;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

it("retains the exact existing identity/read/original/write capture order", async () => {
  const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "owned-original-capture-"));
  const calls: string[] = [],
    captured = new Set<string>();
  const bytes = originalPng();
  const witness = { admitted: true } as const;
  try {
    const receipt = await captureOwnedVisualScene({
      browser: {
        isAlertOpen: async () => {
          calls.push("alert");
          return false;
        },
        takeScreenshot: async () => {
          calls.push("screenshot");
          return bytes.toString("base64");
        },
      } as never,
      owner: {
        until: async (read: () => Promise<boolean>) => {
          calls.push("until");
          expect(await read()).toBe(true);
        },
      } as never,
      evidence,
      file: "owned-light.png",
      captured,
      observation: () => {
        calls.push("observation");
        return { scene: "owned" };
      },
      read: async (input) => {
        expect(input).toEqual({ scene: "owned" });
        calls.push("read");
        return witness;
      },
      verifyOwnedIdentity: async () => {
        calls.push("identity");
      },
      validate: (input) => {
        expect(input).toBe(witness);
        calls.push("validate");
        return witness;
      },
      project: (input) => {
        calls.push("project");
        expect(input.witness).toBe(witness);
        return { ...input };
      },
      refused: () => new Error("Owned capture refused."),
    });
    expect(calls).toEqual([
      "alert",
      "observation",
      "identity",
      "until",
      "read",
      "validate",
      "screenshot",
      "identity",
      "read",
      "validate",
      "project",
    ]);
    expect(receipt).toMatchObject({
      width: 1280,
      height: 960,
      nonBlank: true,
      file: "owned-light.png",
    });
    expect(NodeFS.readFileSync(NodePath.join(evidence, "owned-light.png"))).toEqual(bytes);
    expect(NodeFS.statSync(NodePath.join(evidence, "owned-light.png")).mode & 0o777).toBe(0o600);
    expect(captured).toEqual(new Set(["owned-light.png"]));
  } finally {
    NodeFS.rmSync(evidence, { recursive: true, force: true });
  }
});

it.each([
  { viewport: undefined, width: 1280, height: 960, accepted: true },
  { viewport: "standard", width: 1280, height: 960, accepted: true },
  { viewport: "activity-narrow", width: 960, height: 800, accepted: true },
  { viewport: undefined, width: 960, height: 800, accepted: false },
  { viewport: "standard", width: 960, height: 800, accepted: false },
  { viewport: "activity-narrow", width: 1280, height: 960, accepted: false },
  { viewport: "activity-narrow", width: 960, height: 799, accepted: false },
] as const)("admits only the selected closed original viewport %#", async (row) => {
  const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "owned-viewport-preset-"));
  const calls: string[] = [],
    captured = new Set<string>();
  const bytes = originalPng(row.width, row.height);
  const witness = { admitted: true } as const;
  try {
    const result = captureOwnedVisualScene({
      ...(row.viewport === undefined ? {} : { viewport: row.viewport }),
      browser: {
        isAlertOpen: async () => {
          calls.push("alert");
          return false;
        },
        takeScreenshot: async () => {
          calls.push("screenshot");
          return bytes.toString("base64");
        },
      } as never,
      owner: {
        until: async (read: () => Promise<boolean>) => {
          calls.push("until");
          expect(await read()).toBe(true);
        },
      } as never,
      evidence,
      file: "owned-light.png",
      captured,
      observation: () => {
        calls.push("observation");
        return { admitted: true };
      },
      read: async () => {
        calls.push("read");
        return witness;
      },
      verifyOwnedIdentity: async () => {
        calls.push("identity");
      },
      validate: () => {
        calls.push("validate");
        return witness;
      },
      project: (input) => {
        calls.push("project");
        return input;
      },
      refused: () => new Error("Owned capture refused."),
    });
    if (row.accepted) {
      await expect(result).resolves.toMatchObject({ width: row.width, height: row.height });
      expect(calls).toEqual([
        "alert",
        "observation",
        "identity",
        "until",
        "read",
        "validate",
        "screenshot",
        "identity",
        "read",
        "validate",
        "project",
      ]);
      expect(NodeFS.readFileSync(NodePath.join(evidence, "owned-light.png"))).toEqual(bytes);
      expect(NodeFS.statSync(NodePath.join(evidence, "owned-light.png")).mode & 0o777).toBe(0o600);
      expect(captured.size).toBe(1);
    } else {
      await expect(result).rejects.toThrow("Owned capture refused.");
      expect(calls).toEqual([
        "alert",
        "observation",
        "identity",
        "until",
        "read",
        "validate",
        "screenshot",
        "identity",
        "read",
        "validate",
      ]);
      expect(NodeFS.existsSync(NodePath.join(evidence, "owned-light.png"))).toBe(false);
      expect(captured.size).toBe(0);
    }
  } finally {
    NodeFS.rmSync(evidence, { recursive: true, force: true });
  }
});

it.each(["arbitrary-size", null, 17, {}])(
  "refuses an unknown viewport before all capture ports %#",
  async (viewport) => {
    let touched = false;
    await expect(
      captureOwnedVisualScene({
        viewport,
        browser: {
          isAlertOpen: async () => {
            touched = true;
            return false;
          },
        },
        refused: () => new Error("Owned capture refused."),
      } as never),
    ).rejects.toThrow("Owned capture refused.");
    expect(touched).toBe(false);
  },
);

it.each([
  "duplicate",
  "existing",
  "alert",
  "identity-before",
  "read-before",
  "owner",
  "identity-after",
  "read-after",
  "post-witness",
  "project",
  "wrong-size",
  "write-race",
])("keeps capture failure fatal with no completed receipt/write admission (%s)", async (mode) => {
  const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "owned-capture-refusal-"));
  const path = NodePath.join(evidence, "owned-light.png");
  const captured = new Set<string>(mode === "duplicate" ? ["owned-light.png"] : []);
  const original = new Error("Owned inert capture failure.");
  let identities = 0,
    reads = 0,
    screenshots = 0;
  if (mode === "existing") NodeFS.writeFileSync(path, "retained", { mode: 0o600 });
  try {
    const run = () =>
      captureOwnedVisualScene({
        browser: {
          isAlertOpen: async () => mode === "alert",
          takeScreenshot: async () => {
            screenshots++;
            return originalPng(mode === "wrong-size" ? 1024 : 1280).toString("base64");
          },
        } as never,
        owner: {
          until: async (read: () => Promise<boolean>) => {
            if (mode === "owner" || !(await read())) throw original;
          },
        } as never,
        evidence,
        file: "owned-light.png",
        captured,
        observation: () => ({ owned: true }),
        read: async () => {
          reads++;
          if ((mode === "read-before" && reads === 1) || (mode === "read-after" && reads === 2))
            throw original;
          return { admitted: true };
        },
        verifyOwnedIdentity: async () => {
          identities++;
          if (
            (mode === "identity-before" && identities === 1) ||
            (mode === "identity-after" && identities === 2)
          )
            throw original;
        },
        validate: () => {
          if (mode === "post-witness" && reads === 2) throw original;
          return { admitted: true } as const;
        },
        project: (value) => {
          if (mode === "project") throw original;
          if (mode === "write-race") NodeFS.writeFileSync(path, "retained", { mode: 0o600 });
          return value;
        },
        refused: () => original,
      });
    if (mode === "write-race") await expect(run()).rejects.toMatchObject({ code: "EEXIST" });
    else await expect(run()).rejects.toBe(original);
    expect(captured.size).toBe(mode === "duplicate" ? 1 : 0);
    if (["existing", "write-race"].includes(mode))
      expect(NodeFS.readFileSync(path, "utf8")).toBe("retained");
    else expect(NodeFS.existsSync(path)).toBe(false);
    if (
      ["duplicate", "existing", "alert", "identity-before", "read-before", "owner"].includes(mode)
    )
      expect(screenshots).toBe(0);
  } finally {
    NodeFS.rmSync(evidence, { recursive: true, force: true });
  }
});
