#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Repository guard runs before any Effect runtime exists.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Matches [text](target) and src/srcset/href attributes. Local check only: external URLs are
// skipped, so CI wiring should run a network checker such as lychee separately.
const LINK_PATTERN = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|\b(?:src|srcset|href)="([^"\s]+)"/g;

export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = !inFence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match?.[1]) continue;
    const base = githubSlug(match[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, ""));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

export function checkMarkdownLinks(file: string): string[] {
  const failures: string[] = [];
  const text = NodeFS.readFileSync(file, "utf8");
  const withoutFences = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (path: string) => {
    let anchors = anchorCache.get(path);
    if (!anchors) {
      anchors = anchorsOf(NodeFS.readFileSync(path, "utf8"));
      anchorCache.set(path, anchors);
    }
    return anchors;
  };

  for (const match of withoutFences.matchAll(LINK_PATTERN)) {
    const target = match[1] ?? match[2];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
    const [pathPart = "", fragment] = target.split("#");
    const resolved = pathPart === "" ? file : NodePath.resolve(NodePath.dirname(file), pathPart);
    if (!NodeFS.existsSync(resolved)) {
      failures.push(`${file}: missing file ${target}`);
    } else if (fragment && resolved.endsWith(".md") && !anchorsFor(resolved).has(fragment)) {
      failures.push(`${file}: missing anchor ${target}`);
    }
  }
  return failures;
}

if (
  process.argv[1] &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1])
) {
  const files = process.argv.slice(2);
  const failures = (files.length > 0 ? files : ["README.md"]).flatMap(checkMarkdownLinks);
  for (const failure of failures) console.error(failure);
  if (failures.length > 0) process.exit(1);
  console.log("Markdown links OK");
}
