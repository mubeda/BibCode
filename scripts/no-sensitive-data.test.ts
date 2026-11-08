// @effect-diagnostics nodeBuiltinImport:off - Sensitive-data guard scans Git-owned files directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const SELF = "scripts/no-sensitive-data.test.ts";

// The public repository must hold no personal or company-sensitive values (#331).
// The values are stored only as SHA-256 hashes of lowercased tokens, so this file
// leaks nothing. Text is split on every non-alphanumeric run; each token and each
// adjacent token pair ("first second") is hashed and looked up here.
// To ban a value: `printf '%s' 'lowercased token or two words' | shasum -a 256`,
// then add only the hash. Never add the clear text, here or in a commit message.
const BANNED_HASHES: ReadonlySet<string> = new Set([
  "8c99b12d354cf7be92bdd31ddf0380ea2920f36a6076a3f1edca030a26f699e4",
  "0e43650b148e1557def21ef7ae16ebd8f7c21ccfa676e0d9f64e042681855970",
  "5a04cb3d0046a9621231e450cf596c0b8fd307f0239bf11d12c7b95259db2290",
  "d741ae075d1c842bc61c2dd281cb880a1f04074bfb373ad8bc7b737383965d03",
  "3a29c3568756ecd1ab63f2e56d8158f300d9bf19bc11b6cbae8ff3cb74bd5416",
  "e4d23a0e5044537a137a57d7727b721c993e893e357068bf23bbbff0cfe4992e",
  "19e37c4dfe9a2e1570be1f4cbafca76f3ed757231c0865e02465c909d916b1d1",
  "970ec274ca867815174ebe4eff19282000f9495a6c7254e94991d1fb4dc3df30",
]);

const SKIPPED_NAMES = new Set(["pnpm-lock.yaml", "Cargo.lock", "package-lock.json", "yarn.lock"]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".icns",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".zip",
  ".gz",
  ".wasm",
  ".mp4",
  ".mov",
]);

function sha256(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

/** Returns the short hash of the first banned token or token pair in `text`, else null. */
function findBanned(text: string, banned: ReadonlySet<string> = BANNED_HASHES): string | null {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/u);
  for (const [index, token] of tokens.entries()) {
    if (token === "") continue;
    const single = sha256(token);
    if (banned.has(single)) return single.slice(0, 8);
    const next = tokens[index + 1];
    if (next) {
      const pair = sha256(`${token} ${next}`);
      if (banned.has(pair)) return pair.slice(0, 8);
    }
  }
  return null;
}

/** Short SHA plus banned hash for each commit whose message holds a banned token. */
function findBannedInCommits(log: string, banned: ReadonlySet<string> = BANNED_HASHES): string[] {
  const findings: string[] = [];
  // The log is NUL-separated: SHA, message, SHA, message, ... Git forbids NUL inside
  // a message, so no message can swallow the next record.
  const parts = log.split("\0");
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const sha = parts[index]?.trim() ?? "";
    const hit = findBanned(parts[index + 1] ?? "", banned);
    if (sha && hit) findings.push(`${sha.slice(0, 10)}: commit message matches banned hash ${hit}`);
  }
  return findings;
}

function projectFiles(): string[] {
  return NodeChildProcess.execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
      ":(exclude).repos/**",
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .filter((path) => path !== SELF)
    .filter((path) => !SKIPPED_NAMES.has(NodePath.basename(path)))
    .filter((path) => !BINARY_EXTENSIONS.has(NodePath.extname(path).toLowerCase()))
    .filter((path) => {
      const absolutePath = NodePath.join(REPOSITORY_ROOT, path);
      return NodeFS.existsSync(absolutePath) && NodeFS.statSync(absolutePath).isFile();
    });
}

describe("sensitive data guard", () => {
  it("matches a banned token or pair in hosts, paths and prose, and nothing else", () => {
    const banned = new Set([sha256("samplevalue"), sha256("sample pair")]);
    expect(findBanned("https://SampleValue.example.test/x", banned)).not.toBeNull();
    expect(findBanned("see C:\\users\\samplevalue\\repo", banned)).not.toBeNull();
    expect(findBanned("A Sample   Pair here", banned)).not.toBeNull();
    expect(findBanned("sample then pair, value sample", banned)).toBeNull();
    expect(findBanned("gitlab.example.test/example-group/sample-project", banned)).toBeNull();
  });

  it("keeps tracked files free of banned names, hosts and paths", () => {
    const findings: string[] = [];
    for (const path of projectFiles()) {
      const normalizedPath = path.replaceAll("\\", "/");
      const pathHit = findBanned(normalizedPath);
      if (pathHit) findings.push(`${normalizedPath}: path matches banned hash ${pathHit}`);
      const content = NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, path));
      if (content.includes(0)) continue;
      for (const [index, line] of content.toString("utf8").split(/\r?\n/u).entries()) {
        const hit = findBanned(line);
        if (hit) findings.push(`${normalizedPath}:${String(index + 1)} matches banned hash ${hit}`);
      }
    }
    expect(findings, findings.slice(0, 200).join("\n")).toEqual([]);
  });

  it("flags a banned token in a commit message log and names only the commit", () => {
    const banned = new Set([sha256("samplevalue")]);
    const log = "aaaaaaaaaaaa\0fix: clean\n\0bbbbbbbbbbbb\0chore: SampleValue slipped in\n\0";
    expect(findBannedInCommits(log, banned)).toEqual([
      `bbbbbbbbbb: commit message matches banned hash ${sha256("samplevalue").slice(0, 8)}`,
    ]);
    expect(findBannedInCommits("", banned)).toEqual([]);
    // A \x01 inside a message must not hide a later banned token.
    const sneaky = "cccccccccccc\0ok \x01 then SampleValue\n\0";
    expect(findBannedInCommits(sneaky, banned)).toHaveLength(1);
  });

  // CI sets BIBCODE_SENSITIVE_RANGE (e.g. base..head) so every commit a pull
  // request or push adds is checked, merged branches included.
  const range = process.env.BIBCODE_SENSITIVE_RANGE;
  it.skipIf(!range)(
    "keeps commit messages in BIBCODE_SENSITIVE_RANGE free of banned values",
    () => {
      const log = NodeChildProcess.execFileSync(
        "git",
        ["log", "-z", String(range), "--format=%H%x00%B"],
        { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      const findings = findBannedInCommits(log);
      expect(findings, findings.slice(0, 200).join("\n")).toEqual([]);
    },
  );
});
