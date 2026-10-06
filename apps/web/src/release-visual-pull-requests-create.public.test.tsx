// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Read only the actual QA selector; all public app ports remain inert.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { EnvironmentId, VcsStatusResult, type GitManagerCommitEntry } from "@bibcode/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
const h = vi.hoisted(() => ({ provider: "github", status: null as unknown, run: vi.fn() }));
vi.mock("./state/vcs", () => ({
  vcsEnvironment: {
    status: () => ({ kind: "status" }),
    listRefs: () => ({ kind: "refs" }),
    refreshStatus: {},
  },
}));
vi.mock("./state/gitManager", () => ({
  gitManagerEnvironment: {
    getRefs: () => ({ kind: "snapshot" }),
    getCommits: () => ({ kind: "commits" }),
  },
}));
vi.mock("./state/entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        "local",
        {
          environment: { capabilities: { gitPullRequestBranchSelection: true } },
        },
      ],
    ]),
}));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("./state/sourceControlActions", () => ({
  useGitStackedAction: () => ({ run: h.run, isPending: false, error: null }),
}));
vi.mock("./state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => ({
    data:
      atom?.kind === "status"
        ? h.status
        : atom?.kind === "snapshot"
          ? {
              localBranches: [
                { name: "visual-request", tipSha: "b".repeat(40) },
                { name: "visual-create", tipSha: "b".repeat(40) },
              ],
              remoteBranches: ["main", "visual-request", "visual-create"].map((name) => ({
                name: "origin/" + name,
                tipSha: "b".repeat(40),
              })),
            }
          : atom?.kind === "refs"
            ? {
                refs: ["main", "visual-request", "visual-create"].map((name) => ({
                  name: "origin/" + name,
                  isRemote: true,
                  remoteName: "origin",
                })),
                nextCursor: null,
              }
            : atom?.kind === "commits"
              ? { commits: [commit] }
              : null,
    emission: { _tag: "Initial", waiting: false },
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));
import { GitManagerCreatePullRequestDialog } from "./components/gitManager/provider/GitManagerCreatePullRequestDialog";
const commit: GitManagerCommitEntry = {
  sha: "b".repeat(40),
  shortSha: "bbbbbbb",
  parents: [],
  decorations: [],
  subject: "Owned branch",
  body: "Owned body",
  authorName: "Owned",
  authorEmail: "owned@visual.invalid",
  authoredAtMs: 1,
  committerName: "Owned",
  committerEmail: "owned@visual.invalid",
  committedAtMs: 1,
  changedFiles: [],
};
const producerSource = NodeFS.readFileSync(
  new NodeURL.URL(
    "../../desktop/e2e/support/release-visual-pull-requests-producer.ts",
    import.meta.url,
  ),
  "utf8",
);
const captureSource = NodeFS.readFileSync(
  new NodeURL.URL("../../desktop/e2e/support/release-visual-pull-requests.ts", import.meta.url),
  "utf8",
);
const fixtureSource = NodeFS.readFileSync(
  new NodeURL.URL(
    "../../desktop/e2e/support/release-visual-pull-requests-fixture.ts",
    import.meta.url,
  ),
  "utf8",
);
const observationBegin = captureSource.indexOf("export function pullRequestsObservationFor("),
  observationEnd = captureSource.indexOf(
    "export interface PullRequestsOwnedCaptureInput",
    observationBegin,
  ),
  valuesBegin = fixtureSource.indexOf("export const pullRequestsFixtureValues ="),
  valuesEnd = fixtureSource.indexOf("\n} as const;", valuesBegin);
if (
  observationBegin < 0 ||
  observationEnd <= observationBegin ||
  valuesBegin < 0 ||
  valuesEnd <= valuesBegin
)
  throw new Error("Actual request capture source boundary refused.");
const actual = NodeVM.runInNewContext(
  NodeModule.stripTypeScriptTypes(
    fixtureSource.slice(valuesBegin, valuesEnd + "\n} as const;".length).replace("export ", "") +
      "\n" +
      captureSource.slice(observationBegin, observationEnd).replace("export ", "") +
      "\n({ observationFor: pullRequestsObservationFor, values: pullRequestsFixtureValues })",
  ),
);
function button(label: string) {
  const all = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(
    (node) => node.textContent?.trim() === label,
  );
  expect(all).toHaveLength(1);
  return all[0]!;
}
function field(id: string) {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement))
    throw new Error("Missing owned public field.");
  return node;
}
async function fill(id: string, value: string) {
  const node = field(id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )?.set?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it.each(["github", "gitlab"] as const)(
  "uses the actual QA branch selector and explicit public failed create with retained draft: %s",
  async (provider) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    h.provider = provider;
    h.status = Schema.decodeUnknownSync(VcsStatusResult)({
      isRepo: true,
      sourceControlProvider: {
        kind: provider,
        name: provider === "github" ? "GitHub" : "GitLab",
        baseUrl: "https://" + provider + ".visual.invalid",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "visual-request",
      defaultRefName: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    });
    h.run.mockReset();
    h.run.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("HTTP 422: Owned fixture action was refused."))),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSettled = vi.fn(),
      onOpenChange = vi.fn();
    try {
      await act(async () =>
        root.render(
          createElement(GitManagerCreatePullRequestDialog, {
            open: true,
            scope: {
              environmentId: Schema.decodeUnknownSync(EnvironmentId)("local"),
              cwd: "/owned/light/requests/" + provider,
            },
            onSettled,
            onOpenChange,
            providerHint: { kind: provider, baseUrl: "https://" + provider + ".visual.invalid" },
          }),
        ),
      );
      for (const [id, branch] of [
        ["git-manager-create-pr-head", "visual-create"],
        ["git-manager-create-pr-base", "main"],
      ] as const) {
        await act(async () => {
          field(id).focus();
          field(id)
            .closest('[data-slot="input-control"]')
            ?.parentElement?.querySelector<HTMLButtonElement>('[data-slot="combobox-trigger"]')
            ?.click();
        });
        await fill(id, branch);
        const match = producerSource
          .match(/await click\('([^']*role="option"[^']*)'\);/g)
          ?.find((value) => value.includes('="' + branch + '"'));
        expect(match).toBeDefined();
        const xpath = match!.slice("await click('".length, -"');".length);
        // HappyDOM does not evaluate XPath. Match the actual producer's constrained
        // tag/text predicate against the real mounted BaseUI option structure.
        const label = xpath.match(/\.\/\/([a-z]+)\[normalize-space\(\)="([a-z-]+)"\]/);
        expect(label).not.toBeNull();
        const options = Array.from(
          document.querySelectorAll<HTMLElement>('[role="option"]'),
        ).filter((option) =>
          Array.from(option.querySelectorAll(label![1]!)).some(
            (node) => node.textContent?.trim() === label![2],
          ),
        );
        expect(options).toHaveLength(1);
        await act(async () => options[0]!.click());
        expect(field(id).value).toBe(branch);
      }
      await fill("git-manager-create-pr-title", actual.values.createTitle);
      await fill("git-manager-create-pr-body", actual.values.createBody);
      const noun = provider === "github" ? "pull request" : "merge request";
      expect(h.run).not.toHaveBeenCalled();
      expect(producerSource).toContain('normalize-space()="Publish and create ');
      await act(async () => button("Publish and create " + noun).click());
      expect(h.run).toHaveBeenCalledOnce();
      expect(h.run.mock.calls[0]?.[0]).toMatchObject({
        action: "create_pr",
        pullRequestHeadBranch: "visual-create",
        pullRequestBaseBranch: "main",
        pullRequestTitle: actual.values.createTitle,
        pullRequestBody: actual.values.createBody,
      });
      expect(document.querySelector('[data-testid="create-pr-status"]')?.textContent).toContain(
        "Owned fixture action was refused.",
      );
      expect(field("git-manager-create-pr-title").value).toBe(actual.values.createTitle);
      expect(field("git-manager-create-pr-body").value).toBe(actual.values.createBody);
      expect(button("Retry").disabled).toBe(false);
      expect(button("Cancel").disabled).toBe(false);
      expect(onSettled).not.toHaveBeenCalled();
      const observation = actual.observationFor(
        { row: "request-create-" + provider, substate: "base", theme: "light" },
        {
          environmentId: "local",
          projectId: "owned",
          threadId: "owned-thread",
          cwd: "/owned/light/requests/" + provider,
        },
        "http://127.0.0.1:4885",
      );
      const target = document.querySelector(observation.target);
      expect(target).not.toBeNull();
      for (const required of observation.requiredText)
        expect(target!.textContent).toContain(required);
      for (const required of observation.requiredValues) {
        const node = document.querySelector(required.selector);
        expect(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement).toBe(true);
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
          expect(node.value).toBe(required.value);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  },
);
