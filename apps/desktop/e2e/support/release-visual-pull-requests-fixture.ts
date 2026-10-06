// @effect-diagnostics nodeBuiltinImport:off - Build raw hosting protocol fixtures from current driver documents and supplied owned Git facts.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import type {
  PullRequestsFixtureProvider,
  PullRequestsHostExchange,
} from "./release-visual-pull-requests-protocol.ts";
export const pullRequestsFixtureValues = {
  title: "Owned retained request title",
  body: "Owned retained request description",
  comment: "Owned retained request comment",
  review: "Owned retained review summary",
  createTitle: "Owned new request title",
  createBody: "Owned new request description",
  label: "owned-label",
  suggestion: "export const approved = true; // suggested",
  author: "owned-author",
  githubSuggestionReason:
    "GitHub has no public API for applying review suggestions. Apply it on GitHub.",
  inline: "Owned retained inline review comment",
  dismiss: "Owned dismissal explanation",
  mergeSubject: "Owned reviewed merge subject",
  mergeBody: "Owned retained merge description",
} as const;
const fixtureUrl = (name: string) =>
  new NodeURL.URL("../../../server/tests/fixtures/pull_requests/" + name, import.meta.url);
const read = (name: string): Record<string, unknown> =>
  JSON.parse(NodeFS.readFileSync(fixtureUrl(name), "utf8"));
function queries(provider: PullRequestsFixtureProvider): Record<string, string> {
  const text = NodeFS.readFileSync(
    new NodeURL.URL(
      "../../../server/src/pull_requests/" + provider + "/graphql.rs",
      import.meta.url,
    ),
    "utf8",
  );
  return Object.fromEntries(
    [...text.matchAll(/pub const ([A-Z_]+): &str = r#"([\s\S]*?)"#;/g)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  );
}
function githubDetailFields(): string {
  const text = NodeFS.readFileSync(
    new NodeURL.URL("../../../server/src/pull_requests/github/mod.rs", import.meta.url),
    "utf8",
  );
  const fields = [...text.matchAll(/\.view\(\s*scope,\s*number,\s*"([^"]+)"/g)].map(
    (match) => match[1]!,
  );
  const value = fields.find((field) => field.startsWith("number,title,body,state"));
  if (!value) throw new Error("Owned hosting fixture source is unavailable.");
  return value;
}
function transform(
  value: unknown,
  provider: PullRequestsFixtureProvider,
  baseSha: string,
  headSha: string,
): unknown {
  if (Array.isArray(value)) return value.map((item) => transform(item, provider, baseSha, headSha));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        transform(item, provider, baseSha, headSha),
      ]),
    );
  if (typeof value !== "string") return value;
  return value
    .replaceAll("head-sha", headSha)
    .replaceAll("base-sha", baseSha)
    .replaceAll("start-sha", baseSha)
    .replaceAll("version-base", baseSha)
    .replaceAll("version-start", baseSha)
    .replaceAll("https://github.com/openai/codex", "https://github.visual.invalid/owned/requests")
    .replaceAll("https://gitlab.com/gitlab-org/cli", "https://gitlab.visual.invalid/owned/requests")
    .replaceAll("codex-rs/rust-toolchain.toml", "visual-request.ts")
    .replaceAll("src/main.rs", "visual-request.ts");
}
export interface PullRequestsHostFixtureFacts {
  provider: PullRequestsFixtureProvider;
  baseSha: string;
  headSha: string;
  patch: string;
}
function requireGithubTimelineConnections(
  pullRequest: Record<string, { nodes: Record<string, unknown>[] }>,
) {
  const comments = pullRequest.comments;
  const reviewThreads = pullRequest.reviewThreads;
  if (
    !comments ||
    !reviewThreads ||
    !Array.isArray(comments.nodes) ||
    !Array.isArray(reviewThreads.nodes)
  )
    throw new Error("Owned hosting fixture timeline refused.");
  return { comments, reviewThreads };
}
/** Raw upstream wire replies only: all canonical contract normalization remains in the real Rust host. */
export function buildPullRequestsHostExchanges(
  value: unknown,
): readonly PullRequestsHostExchange[] | null {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      NodeUtil.types.isProxy(value) ||
      Array.isArray(value)
    )
      return null;
    const keys = ["provider", "baseSha", "headSha", "patch"];
    if (
      Reflect.ownKeys(value).length !== keys.length ||
      !Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key))
    )
      return null;
    const data: Record<string, unknown> = {};
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field?.enumerable || !Object.hasOwn(field, "value")) return null;
      data[key] = field.value;
    }
    if (
      (data.provider !== "github" && data.provider !== "gitlab") ||
      typeof data.baseSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(data.baseSha) ||
      typeof data.headSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(data.headSha) ||
      data.baseSha === data.headSha ||
      typeof data.patch !== "string" ||
      Buffer.byteLength(data.patch) > 32768 ||
      !data.patch.startsWith("diff --git a/visual-request.ts b/visual-request.ts\n") ||
      !data.patch.includes(
        "@@ -1 +1 @@\n-export const approved = false;\n+export const approved = true;",
      )
    )
      return null;
    const { provider, baseSha, headSha, patch } = data as unknown as PullRequestsHostFixtureFacts;
    const host = provider + ".visual.invalid";
    const repo = "owned/requests";
    const suffix = provider === "gitlab" ? ["--hostname", host] : [];
    const repoSuffix = ["--repo", host + "/" + repo];
    const docs = queries(provider);
    const entries: PullRequestsHostExchange[] = [];
    const add = (
      kind: PullRequestsHostExchange["kind"],
      argv: readonly string[],
      output: unknown,
      number: number | null = null,
      input: PullRequestsHostExchange["input"] = null,
      exitCode: 0 | 1 = 0,
    ) =>
      entries.push({
        kind,
        provider,
        number,
        argv,
        input,
        stdout: exitCode ? "" : typeof output === "string" ? output : JSON.stringify(output),
        stderr: exitCode ? "HTTP 422: Owned fixture action was refused." : "",
        exitCode,
      });
    const api = (
      kind: PullRequestsHostExchange["kind"],
      path: string,
      output: unknown,
      number: number | null = null,
    ) => add(kind, ["api", path, ...suffix], output, number);
    add(
      "version",
      ["--version"],
      provider === "github"
        ? "gh version 2.65.0 (owned fixture)\n"
        : "glab version 1.114.0 (owned fixture)\n",
    );
    if (provider === "github") {
      const auth = {
        hosts: {
          [host]: [
            { host, login: "viewer", active: true, state: "success", tokenSource: "owned-fixture" },
          ],
        },
      };
      add("auth", ["auth", "status", "--json", "hosts"], auth);
      add("auth", ["auth", "status", "--hostname", host, "--json", "hosts"], auth);
      api("context-user", "user", { login: "viewer", name: "Owned reviewer" });
      api("context-repository", "repos/" + repo, {
        permissions: { push: true, pull: true },
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
        default_branch: "main",
        html_url: "https://" + host + "/" + repo,
      });
      const gql = (
        kind: PullRequestsHostExchange["kind"],
        name: string,
        variables: object,
        output: unknown,
        number: number | null = null,
      ) => {
        const query = docs[name];
        if (!query) throw new Error("Owned query is unavailable.");
        add(kind, ["api", "graphql", "--input", "-"], output, number, {
          format: "json",
          value: JSON.stringify({ query, variables }),
        });
      };
      gql(
        "context-viewer",
        "CONTEXT",
        { owner: "owned", name: "requests" },
        { data: { repository: { viewerPermission: "WRITE" } } },
      );
      const rows: unknown[] = [];
      for (const number of [41, 43]) {
        const detail = transform(read("github_detail.json"), provider, baseSha, headSha) as Record<
          string,
          unknown
        >;
        Object.assign(detail, {
          number,
          title: number === 41 ? "Owned GitHub request" : "Owned review and edit request",
          body: "Owned request description",
          author: { login: pullRequestsFixtureValues.author, name: "Owned author" },
          headRefName: "visual-request",
          isCrossRepository: false,
          headRepository: { name: "requests" },
          headRepositoryOwner: { login: "owned" },
          additions: 1,
          deletions: 1,
          changedFiles: 1,
          url: "https://" + host + "/" + repo + "/pull/" + number,
        });
        if (number === 43)
          Object.assign(detail, {
            reviewDecision: "APPROVED",
            mergeStateStatus: "CLEAN",
            latestReviews: [{ author: { login: "reviewer" }, state: "APPROVED" }],
          });
        const viewer = transform(read("github_detail_viewer.json"), provider, baseSha, headSha) as {
          data: { repository: { viewerPermission: string; pullRequest: Record<string, unknown> } };
        };
        viewer.data.repository.viewerPermission = "WRITE";
        viewer.data.repository.pullRequest.viewerCanUpdate = true;
        gql(
          "detail",
          "DETAIL_VIEWER_QUERY",
          { owner: "owned", name: "requests", number },
          viewer,
          number,
        );
        add(
          "detail",
          ["pr", "view", String(number), "--json", githubDetailFields(), ...repoSuffix],
          detail,
          number,
        );
        add(
          "checks",
          ["pr", "view", String(number), "--json", "statusCheckRollup", ...repoSuffix],
          { statusCheckRollup: detail.statusCheckRollup },
          number,
        );
        add(
          "files",
          ["pr", "view", String(number), "--json", "files,baseRefOid,headRefOid", ...repoSuffix],
          {
            files: [{ path: "visual-request.ts", additions: 1, deletions: 1 }],
            baseRefOid: baseSha,
            headRefOid: headSha,
          },
          number,
        );
        add("patch", ["pr", "diff", String(number), "--patch", ...repoSuffix], patch, number);
        const timeline = transform(read("github_timeline.json"), provider, baseSha, headSha) as {
          data: {
            repository: {
              viewerPermission: string;
              pullRequest: Record<string, { nodes: Record<string, unknown>[] }>;
            };
          };
        };
        timeline.data.repository.viewerPermission = "WRITE";
        const connections = requireGithubTimelineConnections(timeline.data.repository.pullRequest);
        for (const item of connections.comments.nodes)
          Object.assign(item, {
            body: "Owned existing comment",
            author: { login: "viewer", name: "Owned reviewer" },
            viewerDidAuthor: true,
            isMinimized: false,
            reactionGroups: [
              { content: "THUMBS_UP", users: { totalCount: 2 }, viewerHasReacted: false },
            ],
          });
        for (const thread of connections.reviewThreads.nodes) {
          Object.assign(thread, { path: "visual-request.ts", line: 1, isOutdated: false });
          const nested = thread.comments;
          if (!nested || typeof nested !== "object" || Array.isArray(nested))
            throw new Error("Owned hosting fixture timeline refused.");
          const nodes: unknown = Object.getOwnPropertyDescriptor(nested, "nodes")?.value;
          if (
            !Array.isArray(nodes) ||
            !nodes.every(
              (node: unknown): node is Record<string, unknown> =>
                node !== null && typeof node === "object" && !Array.isArray(node),
            )
          )
            throw new Error("Owned hosting fixture timeline refused.");
          for (const comment of nodes) {
            const hasSuggestion =
              typeof comment.body === "string" && comment.body.includes("```suggestion");
            Object.assign(comment, {
              path: "visual-request.ts",
              line: 1,
              originalLine: 1,
              isMinimized: false,
              body:
                "Owned inline feedback" +
                (hasSuggestion
                  ? "\n\n```suggestion\n" + pullRequestsFixtureValues.suggestion + "\n```"
                  : ""),
              diffHunk: patch.slice(patch.indexOf("@@")),
              reactionGroups: [
                { content: "THUMBS_UP", users: { totalCount: 2 }, viewerHasReacted: false },
              ],
            });
          }
        }
        for (const name of [
          "TIMELINE_COMMENTS_QUERY",
          "TIMELINE_REVIEWS_QUERY",
          "TIMELINE_THREADS_QUERY",
          "TIMELINE_EVENTS_QUERY",
        ])
          gql(
            "timeline",
            name,
            { owner: "owned", name: "requests", number, cursor: null },
            timeline,
            number,
          );
        rows.push({
          ...detail,
          labels: { nodes: detail.labels },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
          totalCommentsCount: 3,
        });
      }
      gql(
        "list",
        "LIST",
        {
          owner: "owned",
          name: "requests",
          cursor: null,
          states: ["OPEN"],
          field: "CREATED_AT",
          dir: "DESC",
        },
        {
          data: {
            repository: {
              pullRequests: {
                totalCount: 2,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: rows,
              },
              closed: { totalCount: 0 },
            },
          },
        },
      );
      api("vocabulary", "repos/" + repo + "/labels?per_page=100", [
        {
          name: pullRequestsFixtureValues.label,
          color: "0052cc",
          description: "Owned fixture label",
        },
      ]);
      api("vocabulary", "repos/" + repo + "/branches?per_page=100", [
        { name: "main" },
        { name: "visual-create" },
      ]);
      for (const [flag, text, kind] of [
        ["--title", pullRequestsFixtureValues.title, "edit-title"],
        ["--body-file", "-", "edit-body"],
      ] as const)
        add(
          kind,
          ["pr", "edit", "43", flag, text, ...repoSuffix],
          "",
          43,
          kind === "edit-body" ? { format: "text", value: pullRequestsFixtureValues.body } : null,
          1,
        );
      add(
        "comment",
        ["pr", "comment", "43", "--body-file", "-", ...repoSuffix],
        "",
        43,
        { format: "text", value: pullRequestsFixtureValues.comment },
        1,
      );
      add(
        "review",
        ["api", "--method", "POST", "repos/" + repo + "/pulls/43/reviews", "--input", "-"],
        "",
        43,
        {
          format: "json",
          value: JSON.stringify({
            commit_id: headSha,
            event: "COMMENT",
            body: pullRequestsFixtureValues.review,
            comments: [],
          }),
        },
        1,
      );
      for (const action of ["--add-label", "--remove-label"])
        add(
          "labels",
          ["pr", "edit", "43", action, pullRequestsFixtureValues.label, ...repoSuffix],
          "",
          43,
        );
      add(
        "create",
        [
          "pr",
          "create",
          "--base",
          "main",
          "--head",
          "visual-create",
          "--title",
          pullRequestsFixtureValues.createTitle,
          "--body",
          pullRequestsFixtureValues.createBody,
        ],
        "",
        null,
        null,
        1,
      );
      for (const branch of ["main", "visual-request", "visual-create"])
        add(
          "current-request",
          [
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "open",
            "--limit",
            "1",
            "--json",
            "number,title,url,baseRefName,headRefName,state",
          ],
          [],
        );
    } else {
      const auth = host + "\n  ✓ Logged in to " + host + " as viewer (owned fixture)\n";
      add("auth", ["auth", "status"], auth);
      add("auth", ["auth", "status", "--hostname", host], auth);
      api("context-user", "user", { id: 8, username: "viewer", name: "Owned reviewer" });
      api("host-version", "version", { version: "17.9.1" });
      const project = transform(read("gitlab_project.json"), provider, baseSha, headSha) as Record<
        string,
        unknown
      >;
      Object.assign(project, { web_url: "https://" + host + "/" + repo });
      const permissions = project.permissions;
      if (!permissions || typeof permissions !== "object" || Array.isArray(permissions))
        throw new Error("Owned project permission source refused.");
      Object.assign(permissions, { project_access: { access_level: 50 } });
      api("context-repository", "projects/owned%2Frequests", project);
      const detail = transform(read("gitlab_detail.json"), provider, baseSha, headSha) as Record<
        string,
        unknown
      >;
      Object.assign(detail, {
        iid: 42,
        title: "Owned GitLab request",
        description: "Owned request description",
        author: { id: 1, username: pullRequestsFixtureValues.author, name: "Owned author" },
        source_branch: "visual-request",
        changes_count: "1",
        references: { short: "!42", relative: "!42", full: "owned/requests!42" },
        web_url: "https://" + host + "/" + repo + "/-/merge_requests/42",
      });
      const path = "projects/owned%2Frequests/merge_requests/42";
      api("detail", path, detail, 42);
      const approvals = read("gitlab_approvals.json"),
        reviewers: unknown = read("gitlab_reviewers.json");
      if (!Array.isArray(reviewers)) throw new Error("Owned review source refused.");
      const approved = reviewers.filter(
        (entry) => entry?.user?.id === 9 && entry.user.username === "reviewer",
      );
      if (approved.length !== 1) throw new Error("Owned review source refused.");
      approvals.approved_by = [{ user: approved[0]!.user }];
      approvals.approvals_left = 0;
      api("approvals", path + "/approvals", approvals, 42);
      api("reviewers", path + "/reviewers", reviewers, 42);
      api("approvals", path + "/approval_state", { rules: [] }, 42);
      api(
        "awards",
        path + "/award_emoji?per_page=100&page=1",
        [{ name: "thumbsup", user: { username: "viewer" } }],
        42,
      );
      api("detail", path + "/closes_issues?per_page=100", [], 42);
      api(
        "versions",
        path + "/versions",
        [{ base_commit_sha: baseSha, start_commit_sha: baseSha, head_commit_sha: headSha }],
        42,
      );
      api(
        "files",
        path + "/diffs?per_page=50&page=1",
        [
          {
            old_path: "visual-request.ts",
            new_path: "visual-request.ts",
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            diff: patch.slice(patch.indexOf("@@")),
            collapsed: false,
            too_large: false,
          },
        ],
        42,
      );
      api(
        "checks",
        path + "/pipelines?per_page=1",
        [{ id: 9, project_id: 2, web_url: "https://" + host + "/" + repo + "/-/pipelines/9" }],
        42,
      );
      api(
        "checks",
        "projects/2/pipelines/9/jobs?per_page=100",
        [
          {
            id: 1,
            name: "build",
            stage: "test",
            status: "success",
            web_url: "https://" + host + "/" + repo + "/-/jobs/1",
            started_at: "2026-09-20T10:00:00Z",
            finished_at: "2026-09-20T10:01:00Z",
            duration: 60,
          },
        ],
        42,
      );
      for (const event of ["label", "milestone", "state"])
        api("events", path + "/resource_" + event + "_events?per_page=100", [], 42);
      const timeline = transform(
        read("gitlab_timeline_graphql.json"),
        provider,
        baseSha,
        headSha,
      ) as {
        data: {
          project: {
            mergeRequest: {
              discussions: { nodes: { notes: { nodes: Record<string, unknown>[] } }[] };
            };
          };
        };
      };
      for (const discussion of timeline.data.project.mergeRequest.discussions.nodes)
        for (const note of discussion.notes.nodes)
          if (note.position) {
            const hasSuggestion =
              typeof note.body === "string" && note.body.includes("```suggestion");
            Object.assign(note, {
              body:
                "Owned inline feedback" +
                (hasSuggestion
                  ? "\n\n```suggestion\n" + pullRequestsFixtureValues.suggestion + "\n```"
                  : ""),
              awardEmoji: {
                nodes: [{ name: "thumbsup", user: { username: "viewer" } }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            });
            Object.assign(note.position as object, {
              newPath: "visual-request.ts",
              oldPath: "visual-request.ts",
              filePath: "visual-request.ts",
              newLine: 1,
            });
            if (hasSuggestion) {
              if (note.id !== "gid://gitlab/Note/10")
                throw new Error("Owned suggestion source refused.");
              api(
                "timeline",
                path + "/notes/10",
                {
                  suggestions: [
                    {
                      id: 77,
                      appliable: false,
                      applied: false,
                      from_line: 1,
                      to_line: 1,
                      from_content: "export const approved = true;",
                      to_content: pullRequestsFixtureValues.suggestion,
                    },
                  ],
                },
                42,
              );
            }
          }
      for (const [name, output] of [
        [
          "DETAIL_METADATA_QUERY",
          {
            data: {
              project: {
                mergeRequest: {
                  commitCount: 1,
                  resolvableDiscussionsCount: 1,
                  diffStatsSummary: { additions: 1, deletions: 1, fileCount: 1 },
                  sourceProject: { fullPath: repo },
                  userPermissions: { createNote: true, pushToSourceBranch: true },
                },
              },
            },
          },
        ],
        ["TIMELINE_QUERY", timeline],
      ] as const) {
        const query = docs[name];
        if (!query) throw new Error("Owned query is unavailable.");
        add(
          name === "TIMELINE_QUERY" ? "timeline" : "metadata",
          [
            "api",
            "--method",
            "POST",
            "graphql",
            "-H",
            "Content-Type: application/json",
            "--input",
            "<OWNED_BODY_FILE>",
            ...suffix,
          ],
          output,
          42,
          {
            format: "json",
            value: JSON.stringify({
              query,
              variables: {
                projectPath: repo,
                iid: "42",
                ...(name === "TIMELINE_QUERY" ? { cursor: null } : {}),
              },
            }),
          },
        );
      }
      add(
        "list",
        [
          "mr",
          "list",
          "-F",
          "json",
          "--per-page",
          "30",
          "--page",
          "1",
          "--order",
          "created_at",
          "--sort",
          "desc",
          ...repoSuffix,
        ],
        [detail],
      );
      for (const state of ["opened", "closed", "merged"])
        add(
          "totals",
          [
            "api",
            "-i",
            "projects/owned%2Frequests/merge_requests?state=" + state + "&per_page=1",
            ...suffix,
          ],
          "HTTP/2 200 OK\r\nX-Total: " + (state === "opened" ? "1" : "0") + "\r\n\r\n[]",
        );
      add(
        "create",
        [
          "api",
          "--method",
          "POST",
          "projects/:fullpath/merge_requests",
          "--raw-field",
          "source_branch=visual-create",
          "--raw-field",
          "target_branch=main",
          "--raw-field",
          "title=" + pullRequestsFixtureValues.createTitle,
          "--raw-field",
          "description=" + pullRequestsFixtureValues.createBody,
        ],
        "",
        null,
        null,
        1,
      );
      for (const branch of ["main", "visual-request", "visual-create"])
        add(
          "current-request",
          ["mr", "list", "--source-branch", branch, "--state", "opened", "--output", "json"],
          [],
        );
    }
    return entries;
  } catch {
    return null;
  }
}
