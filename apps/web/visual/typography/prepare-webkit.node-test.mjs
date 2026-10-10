import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { prepareWebkit } from "./prepare-webkit.mjs";

NodeTest.test(
  "runner-local preparation resolves dependencies, extracts owned files and publishes exact executable paths",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bibcode-webkit-caller-"));
    const calls = [];
    const environmentFile = NodePath.join(root, "environment");
    try {
      const result = await prepareWebkit({
        runnerTemp: root,
        environmentFile,
        spawnSync: (command, args, options) => {
          calls.push({ command, args });
          if (command === "apt-cache")
            return { status: 0, stdout: "  Depends: libowned-fixture\n  Depends: libc6\n" };
          if (command === "dpkg-query")
            return {
              status: args.at(-1) === "libc6" ? 0 : 1,
              stdout: args.at(-1) === "libc6" ? "install ok installed" : "",
            };
          if (command === "apt-get") {
            if (args.at(-1) === "update") return { status: 0, stdout: "" };
            // A test-owned archive substitutes only the external package transport.
            NodeFS.writeFileSync(
              NodePath.join(options.cwd, "owned-fixture.deb"),
              "owned package transport",
            );
            return { status: 0, stdout: "" };
          }
          if (command === "dpkg-deb") {
            const driver = NodePath.join(args[2], "usr/bin/WebKitWebDriver");
            const browser = NodePath.join(
              args[2],
              "usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser",
            );
            for (const path of [driver, browser]) {
              NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
              NodeFS.writeFileSync(path, "owned executable fixture");
            }
            return { status: 0, stdout: "" };
          }
          throw new Error("Unexpected preparation command.");
        },
      });
      NodeAssert.equal(result.packages.includes("libowned-fixture"), true);
      NodeAssert.equal(result.packages.includes("libc6"), false);
      NodeAssert.equal(calls.at(-1).command, "dpkg-deb");
      const aptCalls = calls.filter(({ command }) => command === "apt-get");
      NodeAssert.equal(aptCalls[0].args.at(-1), "update");
      NodeAssert.equal(
        aptCalls[1].args[1].startsWith(`Dir::State::Lists=${result.directory}`),
        true,
      );
      NodeAssert.deepEqual(aptCalls[1].args.slice(4), [
        "download",
        "webkit2gtk-driver",
        "libwebkit2gtk-4.1-0",
        "libjavascriptcoregtk-4.1-0",
        "libowned-fixture",
      ]);
      NodeAssert.match(
        await NodeFSP.readFile(environmentFile, "utf8"),
        /BIBCODE_FIXTURE_WEBKIT_DRIVER=/,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
