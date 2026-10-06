// @effect-diagnostics nodeBuiltinImport:off - Hermetic root/owner fixtures stop before any native process port.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import { withNativeFollowupsLinuxSession } from "./release-visual-native-followups-session.ts";
it("refuses a local or relabelled native session before launching any OS or browser work", async () => {
  let calls = 0;
  for (const input of [
    { environment: {}, platform: "linux", workRoot: "/missing/private-session" },
    {
      environment: { CI: "true", GITHUB_ACTIONS: "true", DISPLAY: ":99" },
      platform: "darwin",
      workRoot: "/missing/private-session",
    },
  ])
    await expect(
      withNativeFollowupsLinuxSession(input, async () => {
        calls++;
      }),
    ).rejects.toThrow();
  expect(calls).toBe(0);
});

function sessionRootFactory(uid = NodeProcess.getuid?.() ?? -1) {
  const source = NodeFS.readFileSync(
      new URL("./release-visual-native-followups-session.ts", import.meta.url),
      "utf8",
    ),
    start = source.indexOf("function createNativeFollowupsLinuxSessionRoot("),
    end = source.indexOf("export async function withNativeFollowupsLinuxSession", start);
  if (start < 0) return () => null;
  return NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(start, end)) +
      "\ncreateNativeFollowupsLinuxSessionRoot;",
    { NodeFS, NodePath, NodeProcess: { getuid: () => uid }, Buffer, Error },
  ) as (root: string, observe: (phase: string) => void) => string;
}
it("allocates only short exclusive private sibling sessions in the physical owned work root", () => {
  const parent = NodeFS.realpathSync(NodeFS.mkdtempSync("/tmp/nf-root-"));
  try {
    const create = sessionRootFactory(),
      phases: string[] = [],
      first = create(parent, (phase) => phases.push(phase)),
      second = create(parent, (phase) => phases.push(phase));
    expect(first !== null && second !== null).toBe(true);
    if (first === null || second === null) return;
    expect(first === second).toBe(false);
    for (const root of [first, second]) {
      expect(NodePath.dirname(root) === parent).toBe(true);
      expect(NodeFS.realpathSync(root) === root).toBe(true);
      expect(NodeFS.lstatSync(root).uid === NodeFS.lstatSync(parent).uid).toBe(true);
      expect(NodeFS.lstatSync(root).mode & 0o777).toBe(0o700);
      expect(Buffer.byteLength(NodePath.join(root, "runtime", "bus")) <= 99).toBe(true);
    }
    expect(phases).toEqual(["native-linux-address", "native-linux-address"]);
  } finally {
    NodeFS.rmSync(parent, { recursive: true, force: true });
  }
});
it.each([
  "public-parent",
  "alias-parent",
  "foreign-uid",
  "missing-uid",
  "file-parent",
  "long-parent",
])("refuses unsafe native session parent/address before launching a service: %s", (mode) => {
  const container = NodeFS.realpathSync(NodeFS.mkdtempSync("/tmp/nf-parent-")),
    phases: string[] = [];
  let parent = container;
  try {
    if (mode === "public-parent") NodeFS.chmodSync(parent, 0o755);
    else if (mode === "alias-parent") {
      parent = NodePath.join(container, "alias");
      NodeFS.symlinkSync(container, parent);
    } else if (mode === "file-parent") {
      parent = NodePath.join(container, "file");
      NodeFS.writeFileSync(parent, "owned", { mode: 0o600 });
    } else if (mode === "long-parent") {
      parent = NodePath.join(container, "x".repeat(90));
      NodeFS.mkdirSync(parent, { mode: 0o700 });
    }
    const create = sessionRootFactory(
      mode === "foreign-uid"
        ? (NodeProcess.getuid?.() ?? 0) + 1
        : mode === "missing-uid"
          ? -1
          : NodeProcess.getuid?.(),
    );
    expect(() => create(parent, (phase) => phases.push(phase))).toThrow();
    expect(phases).toEqual(mode === "long-parent" ? ["native-linux-address"] : []);
  } finally {
    NodeFS.rmSync(container, { recursive: true, force: true });
  }
});
it.each(["record", "throw"])(
  "keeps actual session original failure and cleanup phase under %s diagnostics",
  async (mode) => {
    const workRoot = NodeFS.realpathSync(NodeFS.mkdtempSync("/tmp/nf-effect-")),
      phases: string[] = [],
      original = Object.freeze(new Error("Inert first tool-port failure.")),
      diagnostic = new Error("Inert observer failure.");
    let launches = 0;
    const source = NodeFS.readFileSync(
      new URL("./release-visual-native-followups-session.ts", import.meta.url),
      "utf8",
    );
    const begin = source.indexOf("function createNativeFollowupsLinuxSessionRoot("),
      fallback = source.indexOf("export async function withNativeFollowupsLinuxSession(");
    const start =
      begin >= 0 ? begin : source.indexOf("export async function withNativeFollowupsLinuxSession<");
    const fs = {
      ...NodeFS,
      realpathSync: (file: string) => {
        if (file === "/usr/bin/dbus-daemon") throw original;
        return NodeFS.realpathSync(file);
      },
    };
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(start >= 0 ? start : fallback)).replace(
        /^export /gm,
        "",
      ) + "\nwithNativeFollowupsLinuxSession;",
      {
        NodeFS: fs,
        NodePath,
        NodeProcess,
        Buffer,
        Error,
        NodeChildProcess: {
          spawn: () => {
            launches++;
            throw new Error("Unexpected native launch.");
          },
        },
      },
    ) as (...args: unknown[]) => Promise<unknown>;
    try {
      const outcome = await run(
        {
          environment: { CI: "true", GITHUB_ACTIONS: "true", DISPLAY: ":99" },
          platform: "linux",
          root: NodePath.join(workRoot, "legacy"),
          workRoot,
          onStage: (phase: string) => {
            phases.push(phase);
            if (mode === "throw") throw diagnostic;
          },
        },
        () => {
          throw new Error("Unexpected driver launch.");
        },
      ).catch((error: unknown) => error);
      expect(outcome).toBe(original);
      expect(phases).toEqual(["native-linux-root", "native-linux-address", "native-linux-bus"]);
      expect(launches).toBe(0);
      expect(phases).not.toContain("native-linux-cleanup");
    } finally {
      NodeFS.rmSync(workRoot, { recursive: true, force: true });
    }
  },
);
