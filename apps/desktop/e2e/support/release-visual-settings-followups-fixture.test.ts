// @effect-diagnostics nodeBuiltinImport:off - Inert native JSONL replay and private filesystem tests only.
import * as NodeVM from "node:vm";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  settingsFollowupUsageSource,
  prepareSettingsFollowupUsageFixture,
} from "./release-visual-settings-followups-fixture.ts";
function replay(CI = "true") {
  const listeners = new Map<string, (line: string) => void>(),
    frames: unknown[] = [];
  const context = {
    process: {
      env: { CI },
      argv: ["node", "owned-usage.mjs", "-s", "read-only", "-a", "untrusted", "app-server"],
      stdin: {},
      stdout: { write: (value: string) => frames.push(JSON.parse(value)) },
    },
    createInterface: () => ({
      on: (event: string, run: (line: string) => void) => {
        listeners.set(event, run);
      },
    }),
    Buffer,
    Date: { now: () => 1800000000000 },
    JSON,
    Math,
  };
  NodeVM.runInNewContext(settingsFollowupUsageSource().replace(/^import .*\n/gm, ""), context);
  return { frames, line: (value: object) => listeners.get("line")!(JSON.stringify(value)) };
}
it("speaks the actual production fallback initialize/initialized/account-rateLimits JSONL sequence with no credentials or reset", () => {
  const f = replay();
  f.line({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "bibcode", title: "BiBCode", version: "0.7.4" },
      capabilities: { experimentalApi: true },
    },
  });
  f.line({ jsonrpc: "2.0", method: "initialized", params: {} });
  f.line({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
  expect(f.frames).toEqual([
    { id: 1, result: {} },
    {
      id: 2,
      result: {
        rateLimits: {
          primary: { usedPercent: 7, resetsAt: 1800003600 },
          secondary: { usedPercent: 41, resetsAt: 1800604800 },
        },
      },
    },
  ]);
  expect(JSON.stringify(f.frames)).not.toMatch(/token|credential|resetCredit|account_id/);
});
it("refuses non-CI and unsupported/reset native methods instead of fabricating successful results", () => {
  expect(() => replay("false")).toThrow();
  const f = replay();
  f.line({ id: 1, method: "initialize", params: {} });
  expect(() => f.line({ id: 2, method: "account/rateLimits/reset", params: {} })).toThrow();
  expect(f.frames).toHaveLength(1);
});
it("refuses duplicates, out-of-order and malformed native requests", () => {
  const first = replay();
  expect(() => first.line({ id: 2, method: "account/rateLimits/read", params: {} })).toThrow();
  const second = replay();
  second.line({ id: 1, method: "initialize", params: {} });
  expect(() => second.line({ id: 1, method: "initialize", params: {} })).toThrow();
  const third = replay();
  expect(() => third.line({ id: "unexpected", method: "initialize", params: {} })).toThrow();
});
async function files(mode = "owned") {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-usage-owned-")),
  );
  NodeFS.chmodSync(root, 0o700);
  const home = NodePath.join(root, "home"),
    node = NodePath.join(root, "node");
  NodeFS.mkdirSync(home, { mode: 0o700 });
  NodeFS.writeFileSync(node, "inert-node-input", { mode: 0o700 });
  const auth = NodePath.join(home, ".codex", "auth.json");
  if (mode === "existing") {
    NodeFS.mkdirSync(NodePath.dirname(auth), { mode: 0o700 });
    NodeFS.writeFileSync(auth, '{"preserved":true}\n', { mode: 0o600 });
  }
  const input = {
    CI: mode === "non-CI" ? undefined : "true",
    root,
    home,
    node,
    admitOwner: async () => {},
  };
  return {
    root,
    home,
    node,
    auth,
    input,
    close: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}
it("creates only owned empty auth precondition and exact private usage executable, then restores its files", async () => {
  const f = await files();
  try {
    const owned = await prepareSettingsFollowupUsageFixture(f.input);
    expect(NodeFS.readFileSync(f.auth, "utf8")).toBe("{}\n");
    expect(NodeFS.statSync(f.auth).mode & 0o777).toBe(0o600);
    expect(NodeFS.statSync(owned.executable).mode & 0o777).toBe(0o700);
    expect(NodeFS.readFileSync(owned.executable, "utf8")).toBe(
      "#!" + f.node + "\n" + settingsFollowupUsageSource(),
    );
    owned.verify();
    owned.close();
    expect(NodeFS.existsSync(f.auth)).toBe(false);
    expect(NodeFS.existsSync(owned.executable)).toBe(false);
    expect(NodeFS.readFileSync(f.node, "utf8")).toBe("inert-node-input");
  } finally {
    f.close();
  }
});
it.each(["existing", "non-CI"])(
  "refuses unowned/default-sensitive filesystem inputs before adopting them: %s",
  async (mode) => {
    const f = await files(mode);
    try {
      await expect(prepareSettingsFollowupUsageFixture(f.input)).rejects.toThrow();
      if (mode === "existing")
        expect(NodeFS.readFileSync(f.auth, "utf8")).toBe('{"preserved":true}\n');
      else expect(NodeFS.existsSync(f.auth)).toBe(false);
    } finally {
      f.close();
    }
  },
);
it("refuses a substituted auth/executable and preserves private evidence instead of unlinking it", async () => {
  const f = await files();
  try {
    const owned = await prepareSettingsFollowupUsageFixture(f.input);
    NodeFS.writeFileSync(f.auth, "changed\n");
    expect(() => owned.verify()).toThrow();
    expect(() => owned.close()).toThrow();
    expect(NodeFS.existsSync(f.auth)).toBe(true);
    expect(NodeFS.existsSync(owned.executable)).toBe(true);
  } finally {
    f.close();
  }
});
it("rolls back partial owned creation after the second exclusive file already exists and preserves that input", async () => {
  const f = await files();
  try {
    const executable = NodePath.join(f.home, "owned-settings-usage.mjs");
    NodeFS.writeFileSync(executable, "preserved existing input\n", { mode: 0o600 });
    await expect(prepareSettingsFollowupUsageFixture(f.input)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(NodeFS.readFileSync(executable, "utf8")).toBe("preserved existing input\n");
    expect(NodeFS.existsSync(f.auth)).toBe(false);
    expect(NodeFS.existsSync(NodePath.dirname(f.auth))).toBe(false);
  } finally {
    f.close();
  }
});
it("refuses parent inode substitution without removing either the old owned files or the replacement", async () => {
  const f = await files();
  try {
    let unsafe = 0;
    const owned = await prepareSettingsFollowupUsageFixture({
      ...f.input,
      observeUnsafeCleanup: () => {
        unsafe++;
      },
    });
    const oldHome = NodePath.join(f.root, "saved-home");
    NodeFS.renameSync(f.home, oldHome);
    NodeFS.mkdirSync(f.home, { mode: 0o700 });
    NodeFS.writeFileSync(NodePath.join(f.home, "preserved.txt"), "unowned replacement", {
      mode: 0o600,
    });
    expect(() => owned.close()).toThrow();
    expect(unsafe).toBe(1);
    expect(NodeFS.readFileSync(NodePath.join(oldHome, ".codex", "auth.json"), "utf8")).toBe("{}\n");
    expect(NodeFS.readFileSync(NodePath.join(f.home, "preserved.txt"), "utf8")).toBe(
      "unowned replacement",
    );
  } finally {
    f.close();
  }
});
