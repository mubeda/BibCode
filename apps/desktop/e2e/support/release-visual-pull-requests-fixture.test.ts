// @effect-diagnostics nodeBuiltinImport:off - Raw host fixtures join current source documents to inert owned Git facts.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import { expect, it } from "vite-plus/test";
import { matchPullRequestsHostExchange } from "./release-visual-pull-requests-protocol.ts";
const path = "./release-visual-pull-requests-fixture.ts";
const api = await import(path).catch((error) => {
  if (NodeFS.existsSync(new NodeURL.URL(path, import.meta.url))) throw error;
  return {};
});
const build = (provider: string, extra: object = {}) => {
  const method = Reflect.get(api, "buildPullRequestsHostExchanges");
  return typeof method === "function"
    ? method({
        provider,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        patch:
          "diff --git a/visual-request.ts b/visual-request.ts\n--- a/visual-request.ts\n+++ b/visual-request.ts\n@@ -1 +1 @@\n-export const approved = false;\n+export const approved = true;\n",
        ...extra,
      })
    : null;
};
it.each(["github", "gitlab"])(
  "builds only raw host protocol replies with genuine patch/ref joins: %s",
  (provider) => {
    const entries = build(provider);
    expect(entries).toBeInstanceOf(Array);
    expect(entries.some((entry: { kind: string }) => entry.kind === "list")).toBe(true);
    expect(entries.some((entry: { kind: string }) => entry.kind === "detail")).toBe(true);
    expect(entries.some((entry: { kind: string }) => entry.kind === "checks")).toBe(true);
    expect(
      entries.some((entry: { kind: string }) => entry.kind === "files" || entry.kind === "patch"),
    ).toBe(true);
    expect(JSON.stringify(entries)).toContain("visual-request.ts");
    expect(JSON.stringify(entries)).toContain("a".repeat(40));
    expect(JSON.stringify(entries)).toContain("b".repeat(40));
    expect(JSON.stringify(entries)).not.toContain('"permissions":{"editPullRequest"');
  },
);
it("matches the actual Rust GitHub list document through exact owned variables", () => {
  const entries = build("github");
  expect(entries).toBeInstanceOf(Array);
  const entry = entries.find((value: { kind: string }) => value.kind === "list");
  const frame = {
    provider: "github",
    root: "/owned/light",
    cwd: "/owned/light/requests/github",
    sourceSha: "a".repeat(40),
    expectedSourceSha: "a".repeat(40),
    host: "github.visual.invalid",
    repository: "owned/requests",
    argv: entry.argv,
    stdin: entry.input.value,
  };
  expect(matchPullRequestsHostExchange(frame, entries)).toEqual(entry);
  const document = JSON.parse(entry.input.value).query;
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../../../server/src/pull_requests/github/graphql.rs", import.meta.url),
    "utf8",
  );
  expect(source).toContain(document);
});
it.each(["provider", "base", "head", "path", "hunk", "size"])(
  "refuses unverifiable fixture inputs: %s",
  (mode) => {
    const extra: Record<string, unknown> = {};
    if (mode === "base") extra.baseSha = "foreign";
    if (mode === "head") extra.headSha = "foreign";
    if (mode === "path")
      extra.patch = "diff --git a/private.ts b/private.ts\n@@ -1 +1 @@\n-old\n+new\n";
    if (mode === "hunk")
      extra.patch = "diff --git a/visual-request.ts b/visual-request.ts\nprivate";
    if (mode === "size") extra.patch = "x".repeat(65537);
    expect(build(mode === "provider" ? "other" : "github", extra)).toBeNull();
  },
);

it("keeps GitLab total endpoints byte-for-byte aligned with the current host source", () => {
  const entries = build("gitlab");
  expect(entries).toBeInstanceOf(Array);
  const totals = entries.filter((entry: { kind: string }) => entry.kind === "totals");
  expect(totals.map((entry: { argv: string[] }) => entry.argv[2])).toEqual(
    ["opened", "closed", "merged"].map(
      (state) => "projects/owned%2Frequests/merge_requests?state=" + state + "&per_page=1",
    ),
  );
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../../../server/src/pull_requests/gitlab/mod.rs", import.meta.url),
    "utf8",
  );
  expect(source).toContain("{}/merge_requests?state={state}&per_page=1");
});

it("retains the actual GitLab private-body Content-Type header and never places bodies in argv", () => {
  const entries = build("gitlab");
  expect(entries).toBeInstanceOf(Array);
  const entry = entries.find((value: { kind: string }) => value.kind === "metadata");
  expect(entry.argv).toEqual([
    "api",
    "--method",
    "POST",
    "graphql",
    "-H",
    "Content-Type: application/json",
    "--input",
    "<OWNED_BODY_FILE>",
    "--hostname",
    "gitlab.visual.invalid",
  ]);
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../../../server/src/pull_requests/host.rs", import.meta.url),
    "utf8",
  );
  expect(source).toContain('OsStr::new("Content-Type: application/json")');
  expect(entry.argv.join(" ")).not.toContain(JSON.parse(entry.input.value).query);
});

it("requires actual raw timeline connections before iterating them", () => {
  const source = NodeFS.readFileSync(
    new NodeURL.URL("./release-visual-pull-requests-fixture.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function requireGithubTimelineConnections(");
  const end = source.indexOf("\n/** Raw upstream", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const requireConnections = NodeVM.runInNewContext(
    "(" + NodeModule.stripTypeScriptTypes(source.slice(start, end)) + ")",
  );
  const comments = { nodes: [{ body: "Owned comment" }] },
    reviewThreads = { nodes: [{ path: "visual-request.ts" }] };
  expect(requireConnections({ comments, reviewThreads })).toEqual({ comments, reviewThreads });
  for (const malformed of [
    { comments },
    { reviewThreads },
    { comments: { nodes: null }, reviewThreads },
    { comments, reviewThreads: { nodes: {} } },
  ])
    expect(() => requireConnections(malformed)).toThrow("Owned hosting fixture timeline refused.");
});
it.each(["github", "gitlab"])(
  "preserves a raw owned Git-bound suggestion alongside feedback: %s",
  (provider) => {
    const entries = build(provider);
    const suggestions: Record<string, unknown>[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) for (const child of value) walk(child);
      else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record.body === "string" && record.body.includes("```suggestion"))
          suggestions.push(record);
        for (const child of Object.values(record)) walk(child);
      }
    };
    for (const entry of entries.filter((entry: { kind: string }) => entry.kind === "timeline"))
      walk(JSON.parse(entry.stdout));
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion.body).toContain("Owned inline feedback");
      expect(suggestion.body).toContain("export const approved = true; // suggested");
      if (provider === "github") {
        expect(suggestion.path).toBe("visual-request.ts");
        expect(suggestion.line).toBe(1);
        expect(suggestion.diffHunk).toContain("+export const approved = true;");
      } else {
        expect(suggestion.position).toMatchObject({ newPath: "visual-request.ts", newLine: 1 });
      }
    }
    if (provider === "gitlab") {
      const note = entries.find((entry: { argv: string[] }) =>
        entry.argv.includes("projects/owned%2Frequests/merge_requests/42/notes/10"),
      );
      expect(note).toBeDefined();
      expect(JSON.parse(note.stdout).suggestions).toEqual([
        {
          id: 77,
          appliable: false,
          applied: false,
          from_line: 1,
          to_line: 1,
          from_content: "export const approved = true;",
          to_content: "export const approved = true; // suggested",
        },
      ]);
      const source = NodeFS.readFileSync(
        new NodeURL.URL("../../../server/src/pull_requests/gitlab/timeline.rs", import.meta.url),
        "utf8",
      );
      expect(source).toContain('format!("{path}/notes/{id}")');
      expect(
        matchPullRequestsHostExchange(
          {
            provider,
            root: "/owned/light",
            cwd: "/owned/light/requests/gitlab",
            sourceSha: "c".repeat(40),
            expectedSourceSha: "c".repeat(40),
            host: "gitlab.visual.invalid",
            repository: "owned/requests",
            argv: note.argv,
            stdin: "",
          },
          entries,
        ),
      ).toEqual(note);
    }
  },
);
it("binds the GitHub suggestion explanation and GitLab synthetic review to actual owner source", () => {
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../../../server/src/pull_requests/permissions.rs", import.meta.url),
    "utf8",
  );
  expect(source).toContain(Reflect.get(api, "pullRequestsFixtureValues").githubSuggestionReason);
  const entries = build("gitlab");
  const approval = entries.find(
    (entry: { kind: string; argv: string[] }) =>
      entry.kind === "approvals" &&
      entry.argv.includes("projects/owned%2Frequests/merge_requests/42/approvals"),
  );
  const reviewers = entries.find((entry: { kind: string }) => entry.kind === "reviewers");
  const raw = JSON.parse(approval.stdout),
    candidates = JSON.parse(reviewers.stdout);
  expect(raw.approved_by).toEqual([
    { user: candidates.find((entry: { user: { id: number } }) => entry.user.id === 9).user },
  ]);
  expect(raw.approvals_left).toBe(0);
  const normalizer = NodeFS.readFileSync(
    new NodeURL.URL("../../../server/src/pull_requests/gitlab/parse.rs", import.meta.url),
    "utf8",
  );
  expect(normalizer).toContain('nodes(&approvals["approved_by"])');
  expect(normalizer).toContain("ReviewState::Approved");
});
it("provides raw hosting permissions and vocabulary for canceled public conditional dialogs", () => {
  const github = build("github"),
    gitlab = build("gitlab");
  const repository = JSON.parse(
    github.find((entry: { kind: string }) => entry.kind === "context-repository").stdout,
  );
  expect(repository.allow_merge_commit).toBe(true);
  const review = JSON.parse(
    github.find(
      (entry: { kind: string; number: number; argv: string[] }) =>
        entry.kind === "detail" && entry.number === 43 && entry.argv[0] === "pr",
    ).stdout,
  );
  expect(review.reviewDecision).toBe("APPROVED");
  expect(review.mergeStateStatus).toBe("CLEAN");
  expect(review.latestReviews[0].state).toBe("APPROVED");
  const branches = github.find(
    (entry: { kind: string; argv: string[] }) =>
      entry.kind === "vocabulary" &&
      entry.argv.includes("repos/owned/requests/branches?per_page=100"),
  );
  expect(branches).toBeDefined();
  expect(JSON.parse(branches.stdout)).toEqual([{ name: "main" }, { name: "visual-create" }]);
  const project = JSON.parse(
    gitlab.find((entry: { kind: string }) => entry.kind === "context-repository").stdout,
  );
  expect(project.permissions.project_access.access_level).toBe(50);
  expect(JSON.stringify([...github, ...gitlab])).not.toContain('"permissions":{"editPullRequest"');
});
