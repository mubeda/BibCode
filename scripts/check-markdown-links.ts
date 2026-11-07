#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Repository guard runs before any Effect runtime exists.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Local check only: external URLs are skipped, so CI wiring should run a network checker such as
// lychee separately.
const INLINE_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_ATTRIBUTE = /\b(src|srcset|href)="([^"]*)"/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Lines outside fenced code blocks, following CommonMark fence open and close rules. */
function linesOutsideFences(markdown: string): string[] {
  const kept: string[] = [];
  let open: { char: string; length: number } | undefined;
  for (const line of markdown.split("\n")) {
    if (!open) {
      const match = FENCE_OPEN.exec(line);
      if (match?.[1]) {
        open = { char: match[1][0] ?? "`", length: match[1].length };
      } else {
        kept.push(line);
      }
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
    if (close && close[0] === open.char && close.length >= open.length) open = undefined;
  }
  return kept;
}

function headingText(raw: string): string {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/(^|\W)_+(?=\S)/g, "$1")
    .replace(/(?<=\S)_+(?=\W|$)/g, "");
}

function anchorsOf(markdown: string): Set<string> {
  const emitted = new Set<string>();
  const counters = new Map<string, number>();
  for (const line of linesOutsideFences(markdown)) {
    const match = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match?.[1]) continue;
    const base = githubSlug(headingText(match[1]));
    let slug = base;
    let n = counters.get(base) ?? 0;
    while (emitted.has(slug)) slug = `${base}-${++n}`;
    counters.set(base, n);
    emitted.add(slug);
  }
  return emitted;
}

function targetsOf(markdown: string): string[] {
  const lines = linesOutsideFences(markdown);
  const text = lines.join("\n");
  const targets: string[] = [];
  for (const match of text.matchAll(INLINE_LINK)) if (match[1]) targets.push(match[1]);
  for (const match of text.matchAll(HTML_ATTRIBUTE)) {
    const value = match[2] ?? "";
    if (match[1] === "srcset") {
      for (const candidate of value.split(",")) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) targets.push(url);
      }
    } else if (value) {
      targets.push(value);
    }
  }
  for (const line of lines) {
    const url = REFERENCE_DEFINITION.exec(line)?.[1];
    if (url) targets.push(url);
  }
  return targets;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function checkMarkdownLinks(file: string): string[] {
  const failures: string[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (path: string) => {
    let anchors = anchorCache.get(path);
    if (!anchors) {
      anchors = anchorsOf(NodeFS.readFileSync(path, "utf8"));
      anchorCache.set(path, anchors);
    }
    return anchors;
  };

  for (const target of targetsOf(NodeFS.readFileSync(file, "utf8"))) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
    const hash = target.indexOf("#");
    const rawPath = (hash === -1 ? target : target.slice(0, hash)).replace(/\?.*$/, "");
    const fragment = hash === -1 ? "" : decode(target.slice(hash + 1));
    const path = decode(rawPath);
    const resolved = path === "" ? file : NodePath.resolve(NodePath.dirname(file), path);
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
