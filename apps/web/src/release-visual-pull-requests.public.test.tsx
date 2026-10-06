// @effect-diagnostics nodeBuiltinImport:off - Compiled public QA reads its actual source callback without crossing TypeScript project ownership.
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
// @vitest-environment happy-dom
import {
  PullRequestsOperationError,
  type ScopedProjectRef,
  type PullRequestsDetail,
  PullRequestsTimelineItem,
  PullRequestsDetail as PullRequestsDetailSchema,
  PullRequestsTimeline,
} from "@bibcode/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  detail,
  context,
  gitlabContext,
  thread,
  review,
  event,
} from "./components/pullRequests/detail/testFixtures";
const h = vi.hoisted(() => ({
  command: vi.fn(),
  query: {
    data: {
      kind: "labels",
      entries: [
        {
          id: "owned-label",
          label: "owned-label",
          description: "Owned fixture label",
          color: "0052cc",
        },
      ],
      truncated: false,
    },
    isPending: false,
    error: null,
    refresh: () => {},
    revalidate: () => {},
  },
}));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => h.command }));
vi.mock("./components/pullRequests/shared/usePullRequestsQuery", () => ({
  usePullRequestsQuery: () => h.query,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => null,
  useNavigate: () => () => {},
  Link: ({ children }: { children: React.ReactNode }) =>
    createElement("a", { href: "#owned-public-route" }, children),
}));
vi.mock("./state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { worktrees: [] },
    isPending: false,
    error: null,
    refresh: () => {},
    revalidate: () => {},
  }),
}));
vi.mock("./hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: readonly unknown[];
    renderItem: (input: { item: unknown }) => React.ReactNode;
    keyExtractor: (item: unknown) => string;
    ListHeaderComponent: React.ReactNode;
    ListFooterComponent: React.ReactNode;
    role: string;
    "aria-label": string;
  }) =>
    createElement(
      "div",
      { role: props.role, "aria-label": props["aria-label"] },
      props.ListHeaderComponent,
      ...props.data.map((item) =>
        createElement("div", { key: props.keyExtractor(item) }, props.renderItem({ item })),
      ),
      props.ListFooterComponent,
    ),
}));
import { PullRequestsActionProvider } from "./components/pullRequests/usePullRequestsAction";
import { PullRequestsTitleEditor } from "./components/pullRequests/edit/PullRequestsTitleEditor";
import { PullRequestsBodyEditor } from "./components/pullRequests/edit/PullRequestsBodyEditor";
import { PullRequestsConversationComment } from "./components/pullRequests/review/PullRequestsCommentBox";
import { PullRequestsPendingReviewBar } from "./components/pullRequests/review/PullRequestsPendingReviewBar";
import { PullRequestsSideColumn } from "./components/pullRequests/detail/PullRequestsSideColumn";
import { PullRequestsCommentActions } from "./components/pullRequests/review/PullRequestsCommentActions";
import { PullRequestsHeader } from "./components/pullRequests/detail/PullRequestsHeader";
import { PullRequestsConversation } from "./components/pullRequests/detail/PullRequestsConversation";
import { PullRequestsReviewFile } from "./components/pullRequests/review/PullRequestsReviewFile";
import { PullRequestsBaseBranchPicker } from "./components/pullRequests/edit/PullRequestsBaseBranchPicker";
import { PullRequestsDismissReview } from "./components/pullRequests/review/PullRequestsDismissReview";
import { PullRequestsMergeBox } from "./components/pullRequests/detail/PullRequestsMergeBox";
import { PullRequestsSecondaryActions } from "./components/pullRequests/edit/PullRequestsSecondaryActions";
import { ToastProvider, toastManager } from "./components/ui/toast";
const fixturePolicy = NodeFS.readFileSync(
    new NodeURL.URL(
      "../../desktop/e2e/support/release-visual-pull-requests-fixture.ts",
      import.meta.url,
    ),
    "utf8",
  ),
  observationPolicy = NodeFS.readFileSync(
    new NodeURL.URL("../../desktop/e2e/support/release-visual-pull-requests.ts", import.meta.url),
    "utf8",
  );
const valuesBegin = fixturePolicy.indexOf("export const pullRequestsFixtureValues ="),
  valuesEnd = fixturePolicy.indexOf("\n} as const;", valuesBegin),
  observeBegin = observationPolicy.indexOf("export function pullRequestsObservationFor("),
  observeEnd = observationPolicy.indexOf(
    "export interface PullRequestsOwnedCaptureInput",
    observeBegin,
  );
if (valuesBegin < 0 || valuesEnd <= valuesBegin || observeBegin < 0 || observeEnd <= observeBegin)
  throw new Error("Actual request public policy boundary refused.");
const actualPolicy = NodeVM.runInNewContext(
  NodeModule.stripTypeScriptTypes(
    fixturePolicy.slice(valuesBegin, valuesEnd + "\n} as const;".length).replace("export ", "") +
      "\n" +
      observationPolicy.slice(observeBegin, observeEnd).replace("export ", "") +
      "\n({ values: pullRequestsFixtureValues, observe: pullRequestsObservationFor })",
  ),
);
const allowed = { allowed: true, reason: null };
function assertActualConditional(substate: string, provider = "github") {
  const observation = actualPolicy.observe(
    {
      row: provider === "github" ? "request-review-edit-error" : "request-gitlab-detail",
      substate,
      theme: "light",
    },
    {
      environmentId: "local",
      projectId: "owned",
      threadId: "owned-thread",
      title: provider,
      branch: "visual-request",
      cwd: "/owned/light/requests/" + provider,
    },
    "http://127.0.0.1:4885",
  );
  const target = observation.target.startsWith("//")
    ? Array.from(document.querySelectorAll("article")).find((node) =>
        Array.from(node.querySelectorAll("p")).some(
          (p) => p.textContent?.trim() === "Pending review comment",
        ),
      )
    : document.querySelector(observation.target);
  expect(target).toBeDefined();
  expect(target).not.toBeNull();
  const text = target!.textContent?.replace(/\s+/g, " ") ?? "";
  for (const required of observation.requiredText) expect(text).toContain(required);
  for (const required of observation.requiredValues) {
    const node = document.querySelector(required.selector);
    expect(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement).toBe(true);
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
      expect(node.value).toBe(required.value);
  }
}
const editable: PullRequestsDetail = {
  ...detail,
  permissions: {
    ...detail.permissions,
    editPullRequest: allowed,
    comment: allowed,
    review: allowed,
    editLabels: allowed,
    deleteOwnComment: allowed,
  },
};
let serial = 0;
const refresh = {
  get: () => {},
  timeline: () => {},
  files: () => {},
  commits: () => {},
  checks: () => {},
  navigate: () => {},
};
function button(label: string, scope: ParentNode = document) {
  const values = [...scope.querySelectorAll<HTMLButtonElement>("button")].filter(
    (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
  );
  expect(values).toHaveLength(1);
  return values[0]!;
}
async function click(label: string, scope: ParentNode = document) {
  await act(async () => button(label, scope).click());
}
async function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount(
  make: (ref: ScopedProjectRef) => React.ReactNode,
  options: { number?: number; requestKind?: string } = {},
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const ref = {
    environmentId: "local",
    projectId: "owned-public-request-" + ++serial,
  } as ScopedProjectRef;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  h.command.mockReset();
  h.command.mockRejectedValue(
    new PullRequestsOperationError({
      operation: "pullRequests.runAction",
      code: "host_rejected",
      message: "The host rejected this operation.",
      hostDetail: "HTTP 422: Owned fixture action was refused.",
      retryable: false,
    }),
  );
  await act(async () =>
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(PullRequestsActionProvider, {
          scope: { environmentId: ref.environmentId, cwd: "/owned/requests" },
          number: options.number ?? detail.number,
          requestKind: options.requestKind ?? "pull request",
          refresh,
          children: make(ref),
        }),
      ),
    ),
  );
  return {
    container,
    ref,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
      toastManager.close();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    },
  };
}
it.each(["title", "body"] as const)(
  "retains the actual editor draft and structured failure through public controls: %s",
  async (field) => {
    const view = await mount((ref) =>
      field === "title"
        ? createElement(PullRequestsTitleEditor, {
            provider: "github",
            detail: editable,
            projectRef: ref,
          })
        : createElement(PullRequestsBodyEditor, { detail: editable, projectRef: ref }),
    );
    try {
      await click(field === "title" ? "Edit title" : "Edit description");
      const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        field === "title" ? 'input[aria-label="Title"]' : 'textarea[aria-label="Description"]',
      )!;
      await type(node, "Owned retained " + field);
      await click("Save");
      expect(node.value).toBe("Owned retained " + field);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
        "The host rejected this operation.",
      );
      expect(
        document.querySelector(
          field === "title"
            ? 'section[aria-label="Edit title"]'
            : 'section[aria-label="Edit description"]',
        ),
      ).not.toBeNull();
    } finally {
      await view.close();
    }
  },
);
it("retains the conversation comment after an actual public submit failure", async () => {
  const view = await mount((ref) =>
    createElement(PullRequestsConversationComment, {
      permission: allowed,
      projectRef: ref,
      number: detail.number,
    }),
  );
  try {
    const node = document.querySelector<HTMLTextAreaElement>(
      'section[aria-label="Comment"] textarea',
    )!;
    await type(node, "Owned retained request comment");
    await click("Comment");
    expect(node.value).toBe("Owned retained request comment");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "The host rejected this operation.",
    );
  } finally {
    await view.close();
  }
});
it.each(["github", "gitlab"] as const)(
  "renders the genuine header, metadata, suggestion and separate Conversation surfaces from typed public props: %s",
  async (provider) => {
    const number = provider === "github" ? 41 : 42,
      values = actualPolicy.values;
    const scopedContext = {
      ...(provider === "github" ? context : gitlabContext),
      host: provider + ".visual.invalid",
      repository: "owned/requests",
      webUrl: "https://" + provider + ".visual.invalid/owned/requests",
      account: { login: "viewer", name: null, isBot: false },
    };
    const owned = Schema.decodeUnknownSync(PullRequestsDetailSchema)({
      ...editable,
      number,
      title: provider === "github" ? "Owned GitHub request" : "Owned GitLab request",
      author: { login: values.author, name: "Owned author", isBot: false },
      body: "Owned request description",
      state: "open",
      isDraft: false,
      headBranch: "visual-request",
      baseBranch: "main",
      headSha: "b".repeat(40),
      baseSha: "a".repeat(40),
      commitCount: 1,
      labels: [
        { name: provider === "github" ? "rust" : "bug", color: "123456", description: null },
      ],
      milestone: { id: "1", title: "Next", dueOn: null },
      reactions: [{ content: "+1", count: provider === "github" ? 2 : 1, viewerReacted: false }],
      permissions: {
        ...editable.permissions,
        react: allowed,
        applySuggestion:
          provider === "github"
            ? { allowed: false, reason: values.githubSuggestionReason }
            : allowed,
      },
    });
    const timeline = Schema.decodeUnknownSync(PullRequestsTimeline)({
      items: [
        {
          ...thread,
          path: "visual-request.ts",
          line: 1,
          startLine: null,
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              ...thread.comments[0],
              author: { login: "reviewer", name: null, isBot: false },
              body: "Owned inline feedback",
              reactions: [
                { content: "+1", count: provider === "github" ? 2 : 1, viewerReacted: false },
              ],
              suggestion: {
                id: provider === "github" ? null : "77",
                applicable: false,
                fromLine: 1,
                toLine: 1,
                fromContent: "export const approved = true;",
                toContent: values.suggestion,
              },
            },
          ],
        },
        { ...review, author: { login: "reviewer", name: null, isBot: false }, body: "Approved" },
        {
          ...event,
          actor: { login: provider === "github" ? "reviewer" : "viewer", name: null, isBot: false },
          event: provider === "github" ? "labeled" : "commits_added",
          detail: provider === "github" ? "rust" : "added 2 commits\nextra detail",
        },
      ],
      truncated: false,
    });
    const view = await mount(
      (ref) =>
        createElement(
          "section",
          { "aria-label": "Pull Requests" },
          createElement(PullRequestsHeader, {
            scope: { environmentId: ref.environmentId, cwd: "/owned/light/requests/" + provider },
            projectRef: ref,
            detail: owned,
            context: scopedContext,
            onRefresh: () => {},
            refreshing: false,
          }),
          createElement(
            "div",
            { className: "hidden lg:block" },
            createElement(PullRequestsSideColumn, {
              scope: { environmentId: ref.environmentId, cwd: "/owned/light/requests/" + provider },
              projectRef: ref,
              detail: owned,
              context: scopedContext,
            }),
          ),
          createElement(PullRequestsConversation, {
            scope: { environmentId: ref.environmentId, cwd: "/owned/light/requests/" + provider },
            projectRef: ref,
            detail: owned,
            context: scopedContext,
            timeline,
          }),
        ),
      { number, requestKind: provider === "github" ? "pull request" : "merge request" },
    );
    try {
      for (const substate of [
        "checks",
        "files",
        "conversation",
        "conversation-activity",
      ] as const) {
        const observed = actualPolicy.observe(
          { row: "request-" + provider + "-detail", substate, theme: "light" },
          {
            environmentId: "local",
            projectId: "owned",
            threadId: "owned-thread",
            title: provider,
            branch: "visual-request",
            cwd: "/owned/light/requests/" + provider,
          },
          "http://127.0.0.1:4885",
        );
        for (const scope of observed.requiredTextScopes) {
          const nodes = document.querySelectorAll(scope.selector);
          expect(
            nodes.length,
            "closed-scope-" +
              (scope.selector.includes("aside")
                ? "metadata"
                : scope.selector.includes("article:has")
                  ? "description"
                  : scope.selector.includes("article")
                    ? "review"
                    : scope.selector.includes("Reactions")
                      ? "reactions"
                      : "header") +
              "-roles-" +
              Array.from(nodes)
                .map((node) => node.getAttribute("role") ?? "none")
                .join(","),
          ).toBe(1);
          for (const required of scope.text) expect(nodes[0]!.textContent).toContain(required);
        }
      }
      const suggestion = document.querySelector('section[aria-label="Suggested change"]')!;
      expect(button("Apply", suggestion).disabled).toBe(true);
      expect(button("Copy", suggestion).disabled).toBe(false);
      expect(h.command).not.toHaveBeenCalled();
    } finally {
      await view.close();
    }
  },
);
it("opens the actual review error surface with retained summary and explained unavailable permissions", async () => {
  const view = await mount((ref) =>
    createElement(PullRequestsPendingReviewBar, { detail: editable, context, projectRef: ref }),
  );
  try {
    await click("Review · 0 pending comments");
    const node = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Review summary"]',
    )!;
    await type(node, "Owned retained review summary");
    await click("Submit review");
    expect(node.value).toBe("Owned retained review summary");
    expect(
      document.querySelector('[data-slot="popover-popup"] [role="alert"]')?.textContent,
    ).toContain("The host rejected this operation.");
    expect(button("Revoke approval").disabled).toBe(true);
    expect(button("Revoke approval").title).not.toBe("");
  } finally {
    await view.close();
  }
});
it("lets the genuine metadata Undo coexist with a public owned-comment confirmation without changing timers", async () => {
  const decoded = Schema.decodeUnknownSync(PullRequestsTimelineItem)({
    kind: "thread",
    id: "gh:th:1:TH_1",
    path: "visual-request.ts",
    line: 1,
    startLine: null,
    side: "right",
    isResolved: false,
    isOutdated: false,
    canResolve: true,
    diffHunk: null,
    comments: [
      {
        id: "gh:ic:1:IC_1",
        author: { login: "viewer", name: null, isBot: false },
        body: "Owned existing comment",
        createdAt: "2026-09-20T00:00:00Z",
        updatedAt: "2026-09-20T00:00:00Z",
        viewerIsAuthor: true,
        minimized: false,
        reactions: [],
        suggestion: null,
      },
    ],
  });
  if (decoded.kind !== "thread") throw new Error("Owned thread fixture refused.");
  const [comment] = decoded.comments;
  if (!comment) throw new Error("Owned comment fixture refused.");
  const view = await mount((ref) =>
    createElement(
      "div",
      null,
      createElement(PullRequestsSideColumn, {
        scope: { environmentId: ref.environmentId, cwd: "/owned/requests" },
        projectRef: ref,
        detail: editable,
        context,
      }),
      createElement(PullRequestsCommentActions, {
        comment,
        permissions: editable.permissions,
        projectRef: ref,
        number: detail.number,
        host: "github.visual.invalid",
        url: "https://github.visual.invalid/owned/requests/pull/43",
      }),
    ),
  );
  h.command.mockResolvedValue({ _tag: "Success", value: { kind: "done" } });
  try {
    await click("Edit Labels");
    const option = document.querySelector<HTMLInputElement>('input[aria-label="owned-label"]')!;
    await act(async () => option.click());
    await click("Done");
    expect(button("Undo")).not.toBeNull();
    await click("Comment actions");
    await click("Delete");
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Delete this comment?",
    );
    expect(button("Undo")).not.toBeNull();
    expect(button("Delete comment")).not.toBeNull();
    expect(button("Undo").disabled).toBe(false);
    expect(button("Undo").closest("[hidden],[inert]")).toBeNull();
    await click("Cancel");
  } finally {
    await view.close();
  }
});
it("creates an inline draft and pending comment through the installed real diff gutter without state injection", async () => {
  class OwnedIntersection implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "600px";
    readonly scrollMargin = "0px";
    readonly thresholds = [0];
    constructor(readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      const box = target.getBoundingClientRect();
      this.callback(
        [
          {
            time: 0,
            target,
            rootBounds: null,
            boundingClientRect: box,
            intersectionRect: box,
            isIntersecting: true,
            intersectionRatio: 1,
          },
        ],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", OwnedIntersection);
  const owned = Schema.decodeUnknownSync(PullRequestsDetailSchema)({
    ...editable,
    number: 43,
    headSha: "b".repeat(40),
    permissions: { ...editable.permissions, review: allowed },
  });
  h.query.data.kind = "branches";
  h.query.data.entries = ["main", "visual-create"].map((label) => ({
    id: label,
    label,
    description: "Owned branch",
    color: "0052cc",
  }));
  const view = await mount(
    (ref) =>
      createElement(
        "section",
        { "aria-label": "Pull Requests" },
        createElement(PullRequestsBaseBranchPicker, {
          detail: owned,
          scope: { environmentId: ref.environmentId, cwd: "/owned/light/requests/github" },
          projectRef: ref,
        }),
        createElement(PullRequestsReviewFile, {
          detail: owned,
          context,
          projectRef: ref,
          file: {
            path: "visual-request.ts",
            previousPath: null,
            changeType: "modified",
            additions: 1,
            deletions: 1,
            patch:
              "--- a/visual-request.ts\n+++ b/visual-request.ts\n@@ -1 +1 @@\n-export const approved = false;\n+export const approved = true;\n",
            tooLarge: false,
          },
          hostUrl: owned.url,
          viewed: false,
          onToggleViewed: () => {},
          ignoreWhitespace: false,
        }),
      ),
    { number: 43 },
  );
  try {
    await vi.waitFor(() =>
      expect(
        document
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector('[data-column-number="1"][data-line-type="change-addition"]'),
      ).not.toBeNull(),
    );
    const gutter = document
      .querySelector("diffs-container")!
      .shadowRoot!.querySelector<HTMLElement>(
        '[data-column-number="1"][data-line-type="change-addition"]',
      )!;
    await act(async () => gutter.click());
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'section[aria-label="Inline review comment"] textarea',
    );
    expect(textarea).not.toBeNull();
    await type(textarea!, actualPolicy.values.inline);
    expect(textarea!.value).toBe(actualPolicy.values.inline);
    assertActualConditional("inline-draft");
    await click("Add review comment");
    expect(document.querySelector('section[aria-label="Inline review comment"]')).toBeNull();
    expect(view.container.textContent).toContain("Pending review comment");
    expect(view.container.textContent).toContain(actualPolicy.values.inline);
    assertActualConditional("pending-inline");
    expect(h.command).not.toHaveBeenCalled();
    await click("Change base branch");
    assertActualConditional("base-chooser");
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (node) => node.textContent?.trim() === "visual-create",
    );
    expect(option).toBeDefined();
    await act(async () => option!.click());
    const confirmation = document.querySelector('[data-slot="alert-dialog-popup"]')!;
    expect(confirmation.textContent).toContain("Change the base from");
    expect(confirmation.textContent).toContain("visual-create");
    expect(confirmation.textContent).toContain("1 pending review comment");
    assertActualConditional("base-confirmation");
    await click("Cancel", confirmation);
    expect(view.container.textContent).toContain("Pending review comment");
    await click("Remove");
    expect(view.container.textContent).not.toContain("Pending review comment");
  } finally {
    await view.close();
    vi.unstubAllGlobals();
    h.query.data.kind = "labels";
    h.query.data.entries = [
      {
        id: "owned-label",
        label: "owned-label",
        description: "Owned fixture label",
        color: "0052cc",
      },
    ];
  }
});
it("opens and cancels the real pending-base, dismissal and merge conditional dialogs without host commands", async () => {
  const owned = Schema.decodeUnknownSync(PullRequestsDetailSchema)({
    ...editable,
    number: 43,
    headBranch: "visual-request",
    baseBranch: "main",
    headSha: "b".repeat(40),
    permissions: {
      ...editable.permissions,
      dismissReview: allowed,
      merge: {
        ...editable.permissions.merge,
        ...allowed,
        methods: ["merge", "squash", "rebase"],
        defaultMethod: "merge",
        deleteBranchDefault: false,
      },
    },
  });
  h.query.data.kind = "branches";
  h.query.data.entries = ["main", "visual-create"].map((label) => ({
    id: label,
    label,
    description: "Owned branch",
    color: "0052cc",
  }));
  const view = await mount(
    (ref) =>
      createElement(
        "div",
        null,
        createElement(PullRequestsBaseBranchPicker, {
          detail: owned,
          scope: { environmentId: ref.environmentId, cwd: "/owned/light/requests/github" },
          projectRef: ref,
        }),
        createElement(PullRequestsDismissReview, {
          review: { ...review, canDismiss: true },
          permission: allowed,
          host: "github.visual.invalid",
        }),
        createElement(
          "section",
          { "aria-label": "Pull Requests" },
          createElement(PullRequestsMergeBox, { detail: owned, context, projectRef: ref }),
        ),
      ),
    { number: 43 },
  );
  try {
    await click("Change base branch");
    expect(document.querySelector('input[aria-label="Base branch"]')).not.toBeNull();
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (node) => node.textContent?.trim() === "visual-create",
    );
    expect(option).toBeDefined();
    // Choosing an existing source without a draft is a real host action, so
    // this first chooser is canceled. The pending-draft branch is tested below.
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('input[aria-label="Base branch"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await click("Dismiss review");
    const dismissal = document.querySelector('[data-slot="alert-dialog-popup"]')!;
    const message = dismissal.querySelector<HTMLTextAreaElement>("textarea")!;
    await type(message, actualPolicy.values.dismiss);
    expect(message.value).toBe(actualPolicy.values.dismiss);
    expect(button("Dismiss review", dismissal).disabled).toBe(false);
    assertActualConditional("dismiss-review");
    await click("Cancel", dismissal);
    const subject = document.querySelector<HTMLInputElement>('input[aria-label="Merge subject"]')!,
      body = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Merge body"]')!;
    await type(subject, actualPolicy.values.mergeSubject);
    await type(body, actualPolicy.values.mergeBody);
    assertActualConditional("merge-config");
    await click("Merge");
    const merge = document.querySelector('[data-slot="alert-dialog-popup"]')!;
    expect(merge.textContent).toContain("Merge now");
    expect(merge.textContent).toContain("main");
    expect(merge.textContent).toContain("Method: Merge commit");
    assertActualConditional("merge-confirmation");
    await click("Cancel", merge);
    expect(subject.value).toBe(actualPolicy.values.mergeSubject);
    expect(body.value).toBe(actualPolicy.values.mergeBody);
    expect(h.command).not.toHaveBeenCalled();
  } finally {
    await view.close();
    h.query.data.kind = "labels";
    h.query.data.entries = [
      {
        id: "owned-label",
        label: "owned-label",
        description: "Owned fixture label",
        color: "0052cc",
      },
    ];
  }
});
it("opens and cancels the current GitLab secondary Delete confirmation through the real menu", async () => {
  const owned = Schema.decodeUnknownSync(PullRequestsDetailSchema)({
    ...editable,
    number: 42,
    permissions: { ...editable.permissions, delete: allowed },
  });
  const view = await mount(
    () =>
      createElement(PullRequestsSecondaryActions, {
        detail: owned,
        context: { ...gitlabContext, host: "gitlab.visual.invalid" },
      }),
    { number: 42, requestKind: "merge request" },
  );
  try {
    await click("More actions");
    const entry = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (node) => node.textContent?.trim() === "Delete",
    );
    expect(entry).toBeDefined();
    await act(async () => entry!.click());
    const popup = document.querySelector('[data-slot="alert-dialog-popup"]')!;
    expect(popup.textContent).toContain("Delete merge request !42");
    expect(popup.textContent).toContain("This cannot be undone on gitlab.visual.invalid.");
    assertActualConditional("secondary-confirmation", "gitlab");
    await click("Cancel", popup);
    expect(h.command).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});
