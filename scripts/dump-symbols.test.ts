// @effect-diagnostics nodeBuiltinImport:off - These tests read a real ZIP written to a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DumpSymbolsError,
  assertUsableSymbols,
  countStackRecords,
  dumpSymbols,
  parseDumpSymbolsArguments,
  symbolStorePath,
  writeZip,
} from "./dump-symbols.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

const LINUX_SYM = [
  "MODULE Linux x86_64 A83437E178428CE331F11613797F1E660 crash-smoke",
  "INFO CODE_ID E13734A8427817CE31F11613797F1E66",
  "FILE 0 /work/apps/server/src/bin/crash_smoke.rs",
  "FUNC 1000 20 0 crash_smoke::crash_here_in_named_function",
  "1000 20 42 0",
  "STACK CFI INIT 1000 20 .cfa: $rsp 8 + .ra: .cfa -8 + ^",
  "",
].join("\n");

describe("dump-symbols", () => {
  it("rejects a missing --binary", () => {
    expect(() =>
      parseDumpSymbolsArguments(["--module-name", "crash-smoke", "--out", "symbols"]),
    ).toThrow(DumpSymbolsError);
    expect(() =>
      parseDumpSymbolsArguments(["--module-name", "crash-smoke", "--out", "symbols"]),
    ).toThrow("--binary");
  });

  it("reads the binary, its shipped name, the store, and the optional debug files", () => {
    expect(
      parseDumpSymbolsArguments([
        "--binary",
        "target/release/crash-smoke.exe",
        "--module-name",
        "crash-smoke.exe",
        "--out",
        "symbols",
        "--pdb",
        "target/release/crash_smoke.pdb",
        "--zip",
        "symbols.zip",
      ]),
    ).toEqual({
      binary: "target/release/crash-smoke.exe",
      moduleName: "crash-smoke.exe",
      out: "symbols",
      pdb: "target/release/crash_smoke.pdb",
      zip: "symbols.zip",
    });
  });

  it("fails a .sym that names functions but has no STACK CFI", () => {
    const withoutCfi = LINUX_SYM.split("\n")
      .filter((line) => !line.startsWith("STACK"))
      .join("\n");
    expect(() => assertUsableSymbols(withoutCfi, "crash-smoke")).toThrow(DumpSymbolsError);
    expect(() => assertUsableSymbols(withoutCfi, "crash-smoke")).toThrow("STACK CFI");
  });

  it("fails a .sym without source lines: a stripped binary, or a Windows binary without its PDB", () => {
    const stripped = LINUX_SYM.split("\n")
      .filter((line) => !line.startsWith("FUNC") && !line.startsWith("1000"))
      .join("\n");
    // Without its PDB, dump_syms names every .pdata function `<unknown in ...>` and has no lines.
    const withoutPdb = [
      "MODULE windows x86_64 3F0A1B2C4D5E6F708192A3B4C5D6E7F81 crash-smoke.exe",
      "INFO CODE_ID 66F0A1B21F000 crash-smoke.exe",
      "FUNC 1000 20 0 <unknown in crash-smoke.exe>",
      "FUNC 1020 40 0 <unknown in crash-smoke.exe>",
      "STACK CFI INIT 1000 20 .cfa: $rsp 8 + .ra: .cfa -8 + ^",
      "",
    ].join("\n");
    for (const sym of [stripped, withoutPdb]) {
      expect(() => assertUsableSymbols(sym, "crash-smoke")).toThrow("source lines");
      expect(() => assertUsableSymbols(Buffer.from(sym), "crash-smoke")).toThrow("source lines");
    }
    expect(() => assertUsableSymbols(LINUX_SYM, "crash-smoke")).not.toThrow();
    expect(() => assertUsableSymbols(Buffer.from(LINUX_SYM), "crash-smoke")).not.toThrow();
  });

  it("files a .sym where dump_syms --store does, keyed by the PDB name on Windows", () => {
    expect(symbolStorePath(LINUX_SYM)).toBe(
      "crash-smoke/A83437E178428CE331F11613797F1E660/crash-smoke.sym",
    );
    expect(symbolStorePath(Buffer.from(LINUX_SYM))).toBe(symbolStorePath(LINUX_SYM));
    expect(
      symbolStorePath("MODULE windows x86_64 3F0A1B2C4D5E6F708192A3B4C5D6E7F81 crash_smoke.pdb\n"),
    ).toBe("crash_smoke.pdb/3F0A1B2C4D5E6F708192A3B4C5D6E7F81/crash_smoke.sym");
    expect(() => symbolStorePath("FUNC 1000 20 0 f\n")).toThrow("MODULE");
  });

  it("writes a deflated ZIP whose single entry round-trips", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-dump-symbols-"));
    temporaryRoots.push(root);
    const zipPath = NodePath.join(root, "nested", "symbols.zip");
    const name = symbolStorePath(LINUX_SYM);
    writeZip(zipPath, [{ name, data: Buffer.from(LINUX_SYM) }]);

    const zip = NodeFS.readFileSync(zipPath);
    // Local file header: signature, deflate, CRC and sizes, then the name and the data.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(8)).toBe(8);
    const compressedSize = zip.readUInt32LE(18);
    const nameLength = zip.readUInt16LE(26);
    expect(zip.toString("utf8", 30, 30 + nameLength)).toBe(name);
    const dataStart = 30 + nameLength + zip.readUInt16LE(28);
    const data = NodeZlib.inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize));
    expect(data.toString("utf8")).toBe(LINUX_SYM);
    expect(zip.readUInt32LE(14)).toBe(NodeZlib.crc32(data));
    // The end of central directory record lists one entry.
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(1);
    expect(zip.readUInt32LE(zip.readUInt32LE(end + 16))).toBe(0x02014b50);
  });
  it("counts STACK records at the start of the file and after a newline", () => {
    const sym =
      "STACK CFI INIT 1000 20 .cfa: $rsp 8 +\nFUNC 1000 20 0 f\nSTACK CFI 1004 .cfa: $rsp 16 +\n";
    expect(countStackRecords(sym)).toBe(2);
    expect(countStackRecords(Buffer.from(sym))).toBe(2);
    expect(countStackRecords("FUNC 1000 20 0 not_a_STACK record\n")).toBe(0);
  });

  // A stand-in for dump_syms: the first run (with --store) and the binary-only rerun each write
  // the configured .sym and standard error, and every invocation is recorded.
  const CFI_ERROR =
    "[ERROR] CFI: CfiError { kind: BadDebugInfo, source: Some(UnknownVersion(0)) }\n";
  const withStack = (count: number) =>
    LINUX_SYM + "STACK CFI 1004 .cfa: $rsp 16 +\n".repeat(count - 1);
  function fakeDumpSyms(runs: {
    readonly stored: { readonly sym: string; readonly stderr?: string };
    readonly binaryOnly?: { readonly sym: string; readonly stderr?: string };
  }) {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-fake-dump-syms-"));
    temporaryRoots.push(root);
    const calls = NodePath.join(root, "calls.log");
    const tool = NodePath.join(root, "dump_syms");
    NodeFS.writeFileSync(
      tool,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const runs = ${JSON.stringify(runs)};`,
        "const args = process.argv.slice(2);",
        `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");`,
        'const run = args.includes("--store") ? runs.stored : runs.binaryOnly;',
        'fs.writeFileSync(args[args.indexOf("--output") + 1], run.sym);',
        'process.stderr.write(run.stderr ?? "");',
      ].join("\n"),
      { mode: 0o755 },
    );
    const binary = NodePath.join(root, "bibcode-desktop-1234");
    NodeFS.writeFileSync(binary, "binary");
    const dwarf = NodePath.join(root, "app.dSYM", "Contents", "Resources", "DWARF");
    NodeFS.mkdirSync(dwarf, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dwarf, "bibcode_desktop-1234"), "dwarf");
    const input = { binary, moduleName: "bibcode-desktop", out: NodePath.join(root, "symbols") };
    return {
      tool,
      input,
      withDsym: { ...input, dsym: NodePath.join(root, "app.dSYM") },
      calls: () =>
        NodeFS.readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]),
    };
  }
  // The stand-in is a shebang script, which Windows cannot spawn without a shell.
  // oxlint-disable-next-line bibcode/no-global-process-runtime -- A standalone script test samples its host once to skip a POSIX-only stand-in.
  const onPosix = it.skipIf(NodeOS.platform() === "win32");

  onPosix("runs dump_syms once when it reports nothing", () => {
    const fake = fakeDumpSyms({ stored: { sym: withStack(3) } });
    expect(dumpSymbols(fake.withDsym, fake.tool)).toContain("crash-smoke.sym");
    expect(fake.calls()).toHaveLength(1);
  });

  onPosix("accepts an error that the binary alone does not produce: it came from the dSYM", () => {
    const fake = fakeDumpSyms({
      stored: { sym: withStack(3), stderr: CFI_ERROR },
      binaryOnly: { sym: withStack(3) },
    });
    expect(dumpSymbols(fake.withDsym, fake.tool)).toContain("crash-smoke.sym");
    const [, rerun] = fake.calls();
    // One input, the staged binary under its shipped name, and no --store.
    expect(rerun).not.toContain("--store");
    expect(rerun?.filter((argument) => argument.endsWith("bibcode-desktop"))).toHaveLength(1);
  });

  onPosix("fails when the binary alone reports the error too", () => {
    const fake = fakeDumpSyms({
      stored: { sym: withStack(3), stderr: CFI_ERROR },
      binaryOnly: { sym: withStack(3), stderr: CFI_ERROR },
    });
    expect(() => dumpSymbols(fake.withDsym, fake.tool)).toThrow(
      "dump_syms reported an error while reading the unwind tables of the binary",
    );
  });

  onPosix("fails when the stored symbols hold fewer STACK records than the binary", () => {
    const fake = fakeDumpSyms({
      stored: { sym: withStack(3), stderr: CFI_ERROR },
      binaryOnly: { sym: withStack(5) },
    });
    expect(() => dumpSymbols(fake.withDsym, fake.tool)).toThrow(
      "the stored symbols hold 3 STACK records, the binary 5",
    );
  });

  onPosix("fails on an error it cannot attribute: there is no dSYM to set aside", () => {
    const fake = fakeDumpSyms({ stored: { sym: withStack(3), stderr: CFI_ERROR } });
    expect(() => dumpSymbols(fake.input, fake.tool)).toThrow("dump_syms reported an error");
    expect(fake.calls()).toHaveLength(1);
  });
});
