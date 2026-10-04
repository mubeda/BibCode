// @effect-diagnostics nodeBuiltinImport:off - Real Git runs only in disposable private fixture roots.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import {
  prepareVisualProject,
  prepareVisualWorktree,
  visualPartialStageMatches,
} from "./release-visual-fixture.ts";

const git = "/usr/bin/git";
function fixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "visual-git-")),
  );
  const project = NodePath.join(root, "project"),
    home = NodePath.join(root, "home");
  NodeFS.mkdirSync(project);
  NodeFS.mkdirSync(home);
  const run = (args: string[], cwd = project) =>
    NodeChildProcess.execFileSync(
      git,
      [
        "-C",
        cwd,
        "-c",
        "user.name=Owned Fixture",
        "-c",
        "user.email=fixture@example.test",
        ...args,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: home,
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
        timeout: 5_000,
      },
    );
  run(["init", "--initial-branch=main"]);
  NodeFS.writeFileSync(NodePath.join(project, "README.md"), "owned\n");
  run(["add", "README.md"]);
  run(["commit", "-m", "fixture"]);
  return {
    root,
    project,
    home,
    git,
    run,
    close: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

describe.skipIf(!NodeFS.existsSync(git))("first visual batch private Git fixture", () => {
  it("seeds bounded genuine refs, twelve stashes and nested files, then changes only the verified managed worktree", () => {
    const f = fixture();
    try {
      prepareVisualProject(f);
      expect(f.run(["status", "--porcelain"])).toBe("");
      expect(f.run(["stash", "list", "--format=%s"]).trim().split("\n")).toHaveLength(12);
      expect(f.run(["branch", "--format=%(refname:short)"]).trim().split("\n")).toEqual([
        "main",
        "visual-free",
        "visual-held",
      ]);
      expect(f.run(["tag", "--list"])).toBe("visual-base\n");
      expect(f.run(["branch", "-r", "--format=%(refname:short)"]).trim().split("\n")).toEqual([
        "origin/main",
        "origin/visual-free",
        "origin/visual-held",
      ]);
      expect(
        NodeFS.readFileSync(NodePath.join(f.project, "src/nested/visual-note.ts"), "utf8"),
      ).toContain('"Review this owned file"');
      const path = NodePath.join(f.root, "managed");
      const branch = "codex/delivery-retry-light";
      f.run(["worktree", "add", "-b", branch, path]);
      const result = prepareVisualWorktree({ ...f, branch });
      expect(result.path).toBe(path);
      expect(f.run(["status", "--porcelain"], path)).toBe(
        " M pierre-step5.ts\n M visual-swatch.png\n",
      );
      expect(f.run(["diff", "--", "pierre-step5.ts"], path)).toContain('first = "changed one"');
      const binary = f.run(
        [
          "diff",
          "--no-ext-diff",
          "--patch-with-raw",
          "-z",
          "--no-color",
          "HEAD",
          "--",
          "visual-swatch.png",
        ],
        path,
      );
      expect(binary).toContain("Binary files a/visual-swatch.png and b/visual-swatch.png differ");
      const readBlob = (ref: string) =>
        NodeChildProcess.execFileSync(git, ["-C", path, "show", ref + ":visual-swatch.png"], {
          timeout: 5_000,
          maxBuffer: 65_536,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            HOME: f.home,
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
          },
        });
      const before = readBlob("HEAD^"),
        after = readBlob("HEAD");
      expect(before.equals(after)).toBe(false);
      expect(NodeFS.readFileSync(NodePath.join(path, "visual-swatch.png")).equals(before)).toBe(
        true,
      );
      expect(f.run(["log", "-1", "--format=%s"])).toBe("Visual qualification baseline\n");
      expect(f.run(["log", "-1", "--format=%s", "HEAD^"])).toBe("Visual image comparison parent\n");
      for (const bytes of [before, after]) {
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([64, 64]);
        expect(Array.from(bytes.subarray(24, 29))).toEqual([8, 2, 0, 0, 0]);
        let cursor = 8;
        const data: Buffer[] = [];
        while (cursor < bytes.length) {
          const length = bytes.readUInt32BE(cursor);
          expect(bytes.readUInt32BE(cursor + 8 + length)).toBe(
            NodeZlib.crc32(bytes.subarray(cursor + 4, cursor + 8 + length)),
          );
          if (bytes.toString("ascii", cursor + 4, cursor + 8) === "IDAT")
            data.push(bytes.subarray(cursor + 8, cursor + 8 + length));
          cursor += length + 12;
        }
        expect(cursor).toBe(bytes.length);
        const rows = NodeZlib.inflateSync(Buffer.concat(data), {
          maxOutputLength: 64 * (1 + 64 * 3) + 1,
        });
        expect(rows).toHaveLength(64 * (1 + 64 * 3));
        for (let row = 0; row < 64; row++) expect(rows[row * (1 + 64 * 3)]).toBeLessThanOrEqual(4);
      }
      expect(f.run(["status", "--porcelain"])).toBe("");
      expect(f.run(["remote", "get-url", "origin"])).toBe(
        NodePath.join(f.root, "visual-origin.git") + "\n",
      );
    } finally {
      f.close();
    }
  });
  it.each(["dirty", "repeat", "project-alias", "outside-home", "existing-seed"])(
    "refuses %s without overwriting private inputs",
    (mode) => {
      const f = fixture();
      try {
        const input = { root: f.root, project: f.project, home: f.home, git };
        if (mode === "repeat") prepareVisualProject(input);
        if (mode === "dirty")
          NodeFS.writeFileSync(NodePath.join(f.project, "README.md"), "preserve\n");
        if (mode === "project-alias") {
          const alias = NodePath.join(f.root, "alias");
          NodeFS.symlinkSync(f.project, alias);
          input.project = alias;
        }
        if (mode === "outside-home") input.home = NodePath.dirname(f.root);
        if (mode === "existing-seed")
          NodeFS.writeFileSync(NodePath.join(f.project, "pierre-step5.ts"), "preserve\n");
        const before = f.run(["status", "--porcelain"]);
        expect(() => prepareVisualProject(input)).toThrow("Owned visual fixture refused.");
        expect(f.run(["status", "--porcelain"])).toBe(before);
      } finally {
        f.close();
      }
    },
  );
  it("requires the actual first hunk staged with the later hunks left unstaged", () => {
    const f = fixture();
    try {
      prepareVisualProject(f);
      const branch = "codex/delivery-retry-light",
        path = NodePath.join(f.root, "managed");
      f.run(["worktree", "add", "-b", branch, path]);
      const input = { ...f, branch };
      prepareVisualWorktree(input);
      expect(visualPartialStageMatches(input)).toBe(false);
      const file = NodePath.join(path, "pierre-step5.ts");
      const full = NodeFS.readFileSync(file, "utf8");
      const firstOnly = f
        .run(["show", "HEAD:pierre-step5.ts"], path)
        .replace('first = "original one"', 'first = "changed one"');
      NodeFS.writeFileSync(file, firstOnly);
      f.run(["add", "pierre-step5.ts"], path);
      NodeFS.writeFileSync(file, full);
      expect(visualPartialStageMatches(input)).toBe(true);
      f.run(["add", "pierre-step5.ts"], path);
      expect(visualPartialStageMatches(input)).toBe(false);
    } finally {
      f.close();
    }
  });
  it("cannot modify the primary checkout through the managed-worktree seed", () => {
    const f = fixture();
    try {
      prepareVisualProject(f);
      expect(() => prepareVisualWorktree({ ...f, branch: "main" })).toThrow();
      expect(f.run(["status", "--porcelain"])).toBe("");
    } finally {
      f.close();
    }
  });
});
