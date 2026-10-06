// @effect-diagnostics nodeBuiltinImport:off - Exercise fixed hosting CLI admission over inert owned ports.
import { expect, it } from "vite-plus/test";
const path = "./release-visual-pull-requests-protocol.ts";
const api = await import(path);
const admit = (input: unknown) => {
  const method = Reflect.get(api, "admitPullRequestsHostCommand");
  return typeof method === "function" ? method(input) : null;
};
const root = "/owned/visual/light";
const sourceSha = "a".repeat(40);
const input = (provider = "github") => ({
  provider,
  root,
  cwd: root + (provider === "github" ? "/requests/github" : "/requests/gitlab"),
  sourceSha,
  expectedSourceSha: sourceSha,
  host: provider === "github" ? "github.visual.invalid" : "gitlab.visual.invalid",
  repository: "owned/requests",
  argv: ["--version"],
  stdin: "",
});
it.each(["github", "gitlab"])("admits only the fixed provider's version probe: %s", (provider) => {
  expect(admit(input(provider))).toEqual({ kind: "version", provider, number: null, body: null });
});
it("admits the actual GitHub context user command with its exact pinned host", () => {
  expect(admit({ ...input(), argv: ["api", "user"] })).toEqual({
    kind: "context-user",
    provider: "github",
    number: null,
    body: null,
  });
});
it("admits the actual GitLab context user command with its explicit hostname", () => {
  expect(
    admit({ ...input("gitlab"), argv: ["api", "user", "--hostname", "gitlab.visual.invalid"] }),
  ).toEqual({ kind: "context-user", provider: "gitlab", number: null, body: null });
});
it.each(["github", "gitlab"])(
  "admits a fixed context repository endpoint only for its matching driver: %s",
  (provider) => {
    const argv =
      provider === "github"
        ? ["api", "repos/owned/requests"]
        : ["api", "projects/owned%2Frequests", "--hostname", "gitlab.visual.invalid"];
    expect(admit({ ...input(provider), argv })).toEqual({
      kind: "context-repository",
      provider,
      number: null,
      body: null,
    });
  },
);
it("preserves the production GitHub comment stdin transport without putting its body in a receipt", () => {
  const body = "Owned retained comment";
  expect(
    admit({
      ...input(),
      argv: [
        "pr",
        "comment",
        "43",
        "--body-file",
        "-",
        "--repo",
        "github.visual.invalid/owned/requests",
      ],
      stdin: body,
    }),
  ).toEqual({ kind: "comment", provider: "github", number: 43, body });
});
it.each([
  "cwd",
  "root",
  "source",
  "host",
  "repo",
  "driver",
  "number",
  "duplicate",
  "body-argv",
  "suffix",
  "input",
  "length",
  "hostname",
])("refuses a foreign or malformed hosting command: %s", (mode) => {
  const value = {
    ...input(),
    argv: [
      "pr",
      "comment",
      "43",
      "--body-file",
      "-",
      "--repo",
      "github.visual.invalid/owned/requests",
    ],
    stdin: "Owned retained comment",
  };
  if (mode === "cwd") value.cwd = "/foreign/github";
  if (mode === "root") value.root = "/owned/visual/light/..";
  if (mode === "source") value.sourceSha = "b".repeat(40);
  if (mode === "host") value.host = "github.com";
  if (mode === "repo") value.repository = "foreign/requests";
  if (mode === "driver") value.provider = "other";
  if (mode === "number") value.argv[2] = "999";
  if (mode === "duplicate") value.argv.push("--repo", "github.visual.invalid/owned/requests");
  if (mode === "body-argv") value.argv.splice(3, 2, "--body", value.stdin);
  if (mode === "suffix") value.argv.push("--web");
  if (mode === "input") value.stdin = "";
  if (mode === "length") value.stdin = "x".repeat(65537);
  if (mode === "hostname") value.argv.push("--hostname", "foreign.invalid");
  expect(admit(value)).toBeNull();
});
it("does not execute foreign accessors or proxy traps during admission", () => {
  let reads = 0;
  const getter = { ...input() };
  Object.defineProperty(getter, "host", {
    enumerable: true,
    get: () => {
      reads++;
      throw new Error("Private accessor");
    },
  });
  const proxy = new Proxy(input(), {
    get: () => {
      reads++;
      throw new Error("Private trap");
    },
    ownKeys: () => {
      reads++;
      return [];
    },
  });
  for (const value of [getter, proxy]) expect(admit(value)).toBeNull();
  expect(reads).toBe(0);
});

it.each(["sparse", "extra", "hidden", "getter", "proxy", "revoked", "symbol", "oversized"])(
  "refuses malformed argument arrays before executing getters or proxy traps: %s",
  (mode) => {
    let reads = 0;
    let argv: unknown = ["--version"];
    if (mode === "sparse") argv = new Array(1);
    if (mode === "extra") Object.assign(argv as object, { private: "value" });
    if (mode === "hidden")
      Object.defineProperty(argv, "0", { value: "--version", enumerable: false });
    if (mode === "getter")
      Object.defineProperty(argv, "0", {
        enumerable: true,
        get: () => {
          reads++;
          return "--version";
        },
      });
    if (mode === "proxy")
      argv = new Proxy(["--version"], {
        ownKeys: () => {
          reads++;
          throw new Error("Private trap");
        },
        get: () => {
          reads++;
          throw new Error("Private trap");
        },
      });
    if (mode === "revoked") {
      const proxy = Proxy.revocable(["--version"], {});
      proxy.revoke();
      argv = proxy.proxy;
    }
    if (mode === "symbol") Object.defineProperty(argv, Symbol("private"), { value: "value" });
    if (mode === "oversized") argv = new Array(65).fill("--version");
    expect(admit({ ...input(), argv })).toBeNull();
    expect(reads).toBe(0);
  },
);

const exchange = (value: unknown, entries: unknown) => {
  const method = Reflect.get(api, "matchPullRequestsHostExchange");
  return typeof method === "function" ? method(value, entries) : null;
};
const query =
  "query OwnedFixture($owner:String!, $name:String!){repository(owner:$owner,name:$name){viewerPermission}}";
const queryEntry = {
  kind: "context-viewer",
  provider: "github",
  number: null,
  argv: ["api", "graphql", "--input", "-"],
  input: {
    format: "json",
    value: JSON.stringify({ query, variables: { owner: "owned", name: "requests" } }),
  },
  stdout: '{"data":{"repository":{"viewerPermission":"WRITE"}}}',
  stderr: "",
  exitCode: 0,
};
it("matches a fixed typed hosting query independent of JSON object-key order", () => {
  const value = {
    ...input(),
    argv: queryEntry.argv,
    stdin: JSON.stringify({ variables: { name: "requests", owner: "owned" }, query }),
  };
  expect(exchange(value, [queryEntry])).toEqual(queryEntry);
});
it("retains a controlled host failure as the original CLI result without forwarding", () => {
  const entry = {
    kind: "comment",
    provider: "github",
    number: 43,
    argv: [
      "pr",
      "comment",
      "43",
      "--body-file",
      "-",
      "--repo",
      "github.visual.invalid/owned/requests",
    ],
    input: { format: "text", value: "Owned retained comment" },
    stdout: "",
    stderr: "HTTP 422: Owned fixture refusal.",
    exitCode: 1,
  };
  expect(exchange({ ...input(), argv: entry.argv, stdin: entry.input.value }, [entry])).toEqual(
    entry,
  );
});
it.each([
  "foreign-owner",
  "foreign-name",
  "extra-variable",
  "mutation",
  "malformed",
  "duplicate-field",
  "wrong-source",
  "duplicate-entry",
  "oversized-output",
  "unknown-kind",
  "table-getter",
  "table-proxy",
])("refuses ambiguous or foreign fixture exchanges: %s", (mode) => {
  let reads = 0;
  const vars: Record<string, unknown> = { owner: "owned", name: "requests" };
  let document = query;
  if (mode === "foreign-owner") vars.owner = "foreign";
  if (mode === "foreign-name") vars.name = "foreign";
  if (mode === "extra-variable") vars.private = true;
  if (mode === "mutation") document = "mutation OwnedFixture { deleteRepository(id:1) }";
  const value = {
    ...input(),
    argv: queryEntry.argv,
    stdin: JSON.stringify({ query: document, variables: vars }),
  };
  if (mode === "malformed") value.stdin = "{";
  if (mode === "duplicate-field") value.stdin = '{"query":"one","query":"two","variables":{}}';
  if (mode === "wrong-source") value.sourceSha = "b".repeat(40);
  let table: unknown = [{ ...queryEntry }];
  if (mode === "duplicate-entry") table = [queryEntry, queryEntry];
  if (mode === "oversized-output") table = [{ ...queryEntry, stdout: "x".repeat(65537) }];
  if (mode === "unknown-kind") table = [{ ...queryEntry, kind: "forward-real-cli" }];
  if (mode === "table-getter")
    Object.defineProperty((table as object[])[0], "stdout", {
      enumerable: true,
      get: () => {
        reads++;
        return "private";
      },
    });
  if (mode === "table-proxy")
    table = new Proxy([queryEntry], {
      get: () => {
        reads++;
        throw new Error("Private trap");
      },
      ownKeys: () => {
        reads++;
        throw new Error("Private trap");
      },
    });
  expect(exchange(value, table)).toBeNull();
  expect(reads).toBe(0);
});
