// @effect-diagnostics nodeBuiltinImport:off - Fixed hosting fixture admission rejects executable metadata before reflection.
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
export type PullRequestsFixtureProvider = "github" | "gitlab";
export type PullRequestsHostCommandKind =
  | "version"
  | "auth"
  | "context-user"
  | "context-repository"
  | "comment";
export interface PullRequestsHostCommandInput {
  provider: PullRequestsFixtureProvider;
  root: string;
  cwd: string;
  sourceSha: string;
  expectedSourceSha: string;
  host: string;
  repository: string;
  argv: readonly string[];
  stdin: string;
}
export interface PullRequestsHostCommandAdmission {
  kind: PullRequestsHostCommandKind;
  provider: PullRequestsFixtureProvider;
  number: number | null;
  body: string | null;
}
const fields = [
  "provider",
  "root",
  "cwd",
  "sourceSha",
  "expectedSourceSha",
  "host",
  "repository",
  "argv",
  "stdin",
] as const;
function ownData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || NodeUtil.types.isProxy(value) || Array.isArray(value))
    return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    !keys.every((key) => typeof key === "string" && fields.some((field) => field === key))
  )
    return null;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
    result[field] = descriptor.value;
  }
  return result;
}
function stringArguments(value: unknown): readonly string[] | null {
  if (!value || typeof value !== "object" || NodeUtil.types.isProxy(value) || !Array.isArray(value))
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length: unknown = lengthDescriptor?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 64 ||
    Reflect.ownKeys(value).length !== length + 1
  )
    return null;
  const result: string[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    const text: unknown =
      descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
    if (
      !descriptor?.enumerable ||
      typeof text !== "string" ||
      text.length > 4096 ||
      /[\0\r\n]/.test(text)
    )
      return null;
    result.push(text);
  }
  return result;
}
/** No command is forwarded: only this finite owned protocol is admitted. */
function admittedInput(value: unknown): PullRequestsHostCommandInput | null {
  try {
    const data = ownData(value);
    if (!data || (data.provider !== "github" && data.provider !== "gitlab")) return null;
    const provider = data.provider;
    const root = data.root;
    const expectedHost = provider === "github" ? "github.visual.invalid" : "gitlab.visual.invalid";
    if (
      typeof root !== "string" ||
      !NodePath.isAbsolute(root) ||
      NodePath.normalize(root) !== root ||
      !/\/(light|dark)$/.test(root) ||
      root.length > 4096 ||
      /[\0\r\n]/.test(root) ||
      data.cwd !== NodePath.join(root, "requests", provider) ||
      data.host !== expectedHost ||
      data.repository !== "owned/requests" ||
      typeof data.sourceSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(data.sourceSha) ||
      data.expectedSourceSha !== data.sourceSha ||
      typeof data.stdin !== "string" ||
      Buffer.byteLength(data.stdin) > 65536 ||
      data.stdin.includes("\0")
    )
      return null;
    const argv = stringArguments(data.argv);
    if (!argv) return null;
    return {
      provider,
      root,
      cwd: data.cwd as string,
      sourceSha: data.sourceSha,
      expectedSourceSha: data.sourceSha,
      host: expectedHost,
      repository: "owned/requests",
      argv,
      stdin: data.stdin,
    };
  } catch {
    return null;
  }
}
/** No command is forwarded: only this finite owned protocol is admitted. */
export function admitPullRequestsHostCommand(
  value: unknown,
): PullRequestsHostCommandAdmission | null {
  try {
    const data = admittedInput(value);
    if (!data) return null;
    const { provider, argv, host: expectedHost } = data;
    const exact = (expected: readonly string[]) =>
      argv.length === expected.length && argv.every((arg, index) => arg === expected[index]);
    const result = (
      kind: PullRequestsHostCommandKind,
      number: number | null = null,
      body: string | null = null,
    ) => Object.freeze({ kind, provider, number, body });
    if (exact(["--version"]) && data.stdin === "") return result("version");
    const hostSuffix = provider === "gitlab" ? ["--hostname", expectedHost] : [];
    if (exact(["api", "user", ...hostSuffix]) && data.stdin === "") return result("context-user");
    if (
      exact([
        "api",
        provider === "github" ? "repos/owned/requests" : "projects/owned%2Frequests",
        ...hostSuffix,
      ]) &&
      data.stdin === ""
    )
      return result("context-repository");
    if (
      provider === "github" &&
      exact([
        "pr",
        "comment",
        "43",
        "--body-file",
        "-",
        "--repo",
        expectedHost + "/owned/requests",
      ]) &&
      data.stdin.trim()
    )
      return result("comment", 43, data.stdin);
    return null;
  } catch {
    return null;
  }
}

export const pullRequestsExchangeKinds = [
  "version",
  "auth",
  "context-user",
  "context-repository",
  "context-viewer",
  "list",
  "detail",
  "timeline",
  "checks",
  "files",
  "patch",
  "vocabulary",
  "totals",
  "host-version",
  "approvals",
  "reviewers",
  "awards",
  "events",
  "versions",
  "metadata",
  "current-request",
  "create",
  "edit-title",
  "edit-body",
  "comment",
  "review",
  "labels",
] as const;
export interface PullRequestsHostExchange {
  kind: (typeof pullRequestsExchangeKinds)[number];
  provider: PullRequestsFixtureProvider;
  number: number | null;
  argv: readonly string[];
  input: { format: "text" | "json"; value: string } | null;
  stdout: string;
  stderr: string;
  exitCode: 0 | 1;
}
function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || NodeUtil.types.isProxy(value) || Array.isArray(value))
    return null;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    !own.every((key) => typeof key === "string" && keys.includes(key))
  )
    return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
    result[key] = descriptor.value;
  }
  return result;
}
function canonicalJson(text: string): string | null {
  try {
    if (Buffer.byteLength(text) > 65536) return null;
    const parsed: unknown = JSON.parse(text);
    const stack: (Set<string> | null)[] = [];
    for (let index = 0; index < text.length; index++) {
      const token = text[index];
      if (token === '"') {
        const start = index++;
        while (index < text.length) {
          if (text[index] === "\\") {
            index += 2;
            continue;
          }
          if (text[index] === '"') break;
          index++;
        }
        const key: unknown = JSON.parse(text.slice(start, index + 1));
        let next = index + 1;
        while (/\s/.test(text[next] ?? "")) next++;
        if (text[next] === ":") {
          const keys = stack.at(-1);
          if (
            !keys ||
            typeof key !== "string" ||
            keys.has(key) ||
            keys.size >= 64 ||
            ["__proto__", "constructor", "prototype"].includes(key)
          )
            return null;
          keys.add(key);
        }
      } else if (token === "{" || token === "[") {
        stack.push(token === "{" ? new Set() : null);
        if (stack.length > 16) return null;
      } else if (token === "}" || token === "]") stack.pop();
    }
    const sort = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sort)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, sort(Reflect.get(value, key))]),
            )
          : value;
    return JSON.stringify(sort(parsed));
  } catch {
    return null;
  }
}
/** Exact source-derived CLI/body exchanges only; ambiguous tables and executable fields refuse. */
export function matchPullRequestsHostExchange(
  value: unknown,
  table: unknown,
): PullRequestsHostExchange | null {
  try {
    const data = admittedInput(value);
    if (
      !data ||
      !table ||
      typeof table !== "object" ||
      NodeUtil.types.isProxy(table) ||
      !Array.isArray(table)
    )
      return null;
    const length: unknown = Object.getOwnPropertyDescriptor(table, "length")?.value;
    if (
      typeof length !== "number" ||
      length < 1 ||
      length > 256 ||
      Reflect.ownKeys(table).length !== length + 1
    )
      return null;
    let match: PullRequestsHostExchange | null = null;
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(table, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      const entry = dataRecord(descriptor.value, [
        "kind",
        "provider",
        "number",
        "argv",
        "input",
        "stdout",
        "stderr",
        "exitCode",
      ]);
      if (
        !entry ||
        !pullRequestsExchangeKinds.some((kind) => kind === entry.kind) ||
        (entry.provider !== "github" && entry.provider !== "gitlab") ||
        (entry.number !== null && ![41, 42, 43].includes(entry.number as number)) ||
        typeof entry.stdout !== "string" ||
        typeof entry.stderr !== "string" ||
        Buffer.byteLength(entry.stdout) + Buffer.byteLength(entry.stderr) > 65536 ||
        (entry.exitCode !== 0 && entry.exitCode !== 1)
      )
        return null;
      const argv = stringArguments(entry.argv);
      if (!argv) return null;
      let body: PullRequestsHostExchange["input"] = null;
      if (entry.input !== null) {
        const input = dataRecord(entry.input, ["format", "value"]);
        if (
          !input ||
          (input.format !== "text" && input.format !== "json") ||
          typeof input.value !== "string" ||
          Buffer.byteLength(input.value) > 65536
        )
          return null;
        body = { format: input.format, value: input.value };
      }
      if (
        entry.provider !== data.provider ||
        argv.length !== data.argv.length ||
        !argv.every((arg, at) => arg === data.argv[at])
      )
        continue;
      if (
        body === null
          ? data.stdin !== ""
          : body.format === "text"
            ? data.stdin !== body.value
            : canonicalJson(data.stdin) === null ||
              canonicalJson(data.stdin) !== canonicalJson(body.value)
      )
        continue;
      if (match) return null;
      match = Object.freeze({
        kind: entry.kind,
        provider: entry.provider,
        number: entry.number,
        argv,
        input: body,
        stdout: entry.stdout,
        stderr: entry.stderr,
        exitCode: entry.exitCode,
      }) as PullRequestsHostExchange;
    }
    return match;
  } catch {
    return null;
  }
}
