// @effect-diagnostics nodeBuiltinImport:off - Closed public context/capture facts only.
import * as NodeUtil from "node:util";
import { captureOwnedVisualScene } from "./owned-visual-capture.ts";
import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
import { pullRequestsFixtureValues } from "./release-visual-pull-requests-fixture.ts";
import type { GitProjectVisualSelection } from "./release-visual-git-project.ts";
export const pullRequestsVisualRows = [
  "request-github-detail",
  "request-gitlab-detail",
  "request-create-github",
  "request-create-gitlab",
  "request-review-edit-error",
] as const;
export type PullRequestsVisualRow = (typeof pullRequestsVisualRows)[number];
export type PullRequestsVisualSubstate =
  | "base"
  | "checks"
  | "files"
  | "conversation"
  | "conversation-activity"
  | "editors"
  | "comment"
  | "confirmation-undo"
  | "inline-draft"
  | "pending-inline"
  | "base-chooser"
  | "base-confirmation"
  | "dismiss-review"
  | "merge-config"
  | "merge-confirmation"
  | "secondary-confirmation";
export interface PullRequestsCaptureBinding {
  row: PullRequestsVisualRow;
  substate: PullRequestsVisualSubstate;
  theme: "light" | "dark";
  file: string;
}
export const pullRequestsCaptureBindings: readonly PullRequestsCaptureBinding[] =
  pullRequestsVisualRows.flatMap((row) => {
    const substates: PullRequestsVisualSubstate[] =
      row === "request-github-detail" || row === "request-gitlab-detail"
        ? [
            "base",
            "checks",
            "files",
            "conversation",
            "conversation-activity",
            ...(row === "request-gitlab-detail" ? ["secondary-confirmation" as const] : []),
          ]
        : row === "request-review-edit-error"
          ? [
              "base",
              "editors",
              "comment",
              "confirmation-undo",
              "inline-draft",
              "pending-inline",
              "base-chooser",
              "base-confirmation",
              "dismiss-review",
              "merge-config",
              "merge-confirmation",
            ]
          : ["base"];
    return substates.flatMap((substate) =>
      (["light", "dark"] as const).map((theme) => ({
        row,
        substate,
        theme,
        file: row + (substate === "base" ? "" : "-" + substate) + "-" + theme + ".png",
      })),
    );
  });
export interface PullRequestsExpectedHostContext {
  provider: "github" | "gitlab";
  host: string;
  repository: string;
  account: string;
}
function ownValue(value: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field?.enumerable && Object.hasOwn(field, "value") ? field.value : undefined;
}
export function projectPullRequestsHostContext(
  value: unknown,
  expected: PullRequestsExpectedHostContext,
): boolean {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      NodeUtil.types.isProxy(value) ||
      Array.isArray(value)
    )
      return false;
    const account = ownValue(value, "account");
    if (
      !account ||
      typeof account !== "object" ||
      NodeUtil.types.isProxy(account) ||
      Array.isArray(account)
    )
      return false;
    return (
      ownValue(value, "status") === "available" &&
      ownValue(value, "provider") === expected.provider &&
      ownValue(value, "host") === expected.host &&
      ownValue(value, "repository") === expected.repository &&
      ownValue(account, "login") === expected.account
    );
  } catch {
    return false;
  }
}
export interface PullRequestsCaptureObservation {
  origin: string;
  theme: "light" | "dark";
  selection: GitProjectVisualSelection;
  path: string;
  target: string;
  requiredText: readonly string[];
  requiredSelectors: readonly string[];
  requiredValues: readonly { selector: string; value: string }[];
  requiredTextScopes: readonly { selector: string; text: readonly string[] }[];
}
/** The import-free read observes current public markup and open shadow roots; it never writes UI state. */
export function readPullRequestsCaptureWitness(input: PullRequestsCaptureObservation) {
  try {
    const parentOf = (element: Element): Element | null => {
      if (element.parentElement) return element.parentElement;
      const root = element.getRootNode();
      return "host" in root && root.host instanceof Element ? root.host : null;
    };
    const shown = (element: Element) => {
      for (let node: Element | null = element; node; node = parentOf(node)) {
        const style = getComputedStyle(node);
        if (
          style.display === "none" ||
          style.visibility !== "visible" ||
          !Number.isFinite(Number.parseFloat(style.opacity)) ||
          Number.parseFloat(style.opacity) <= 0 ||
          node.hasAttribute("hidden") ||
          node.hasAttribute("inert")
        )
          return false;
      }
      return true;
    };
    const painted = (box: DOMRectReadOnly, element: Element, includeSelf: boolean) => {
      if (
        ![box.x, box.y, box.width, box.height, box.right, box.bottom].every(Number.isFinite) ||
        box.width <= 0 ||
        box.height <= 0 ||
        box.x < 0 ||
        box.y < 0 ||
        box.right > innerWidth ||
        box.bottom > innerHeight
      )
        return false;
      for (
        let node: Element | null = includeSelf ? element : parentOf(element);
        node;
        node = parentOf(node)
      ) {
        const style = getComputedStyle(node),
          paintContainment = (style.contain ?? "")
            .split(/\s+/)
            .some((value) => ["paint", "strict", "content"].includes(value)),
          clippedX =
            paintContainment || ["hidden", "clip", "auto", "scroll"].includes(style.overflowX),
          clippedY =
            paintContainment || ["hidden", "clip", "auto", "scroll"].includes(style.overflowY);
        if (!clippedX && !clippedY) continue;
        if (!(node instanceof HTMLElement)) return false;
        const outer = node.getBoundingClientRect();
        if (
          ![
            outer.x,
            outer.y,
            outer.width,
            outer.height,
            node.offsetWidth,
            node.offsetHeight,
            node.clientLeft,
            node.clientTop,
            node.clientWidth,
            node.clientHeight,
          ].every(Number.isFinite) ||
          outer.width <= 0 ||
          outer.height <= 0 ||
          node.offsetWidth <= 0 ||
          node.offsetHeight <= 0 ||
          node.clientWidth <= 0 ||
          node.clientHeight <= 0
        )
          return false;
        const scaleX = outer.width / node.offsetWidth,
          scaleY = outer.height / node.offsetHeight,
          left = outer.x + node.clientLeft * scaleX,
          top = outer.y + node.clientTop * scaleY;
        if (
          (clippedX && (box.x < left || box.right > left + node.clientWidth * scaleX)) ||
          (clippedY && (box.y < top || box.bottom > top + node.clientHeight * scaleY))
        )
          return false;
      }
      return true;
    };
    const visible = (element: Element) =>
      shown(element) && painted(element.getBoundingClientRect(), element, false);
    const one = (selector: string) => {
      const all = selector.startsWith("//")
        ? (() => {
            const result = document.evaluate(
              selector,
              document,
              null,
              XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
              null,
            );
            return Array.from({ length: result.snapshotLength }, (_, index) =>
              result.snapshotItem(index),
            ).filter((node): node is Element => node instanceof Element);
          })()
        : Array.from(document.querySelectorAll(selector));
      return all.length === 1 ? all[0]! : null;
    };
    const deepText = (node: Node): string =>
      node instanceof Element
        ? shown(node)
          ? (node.shadowRoot ? deepText(node.shadowRoot) : "") +
            Array.from(node.childNodes).map(deepText).join("")
          : ""
        : node.nodeType === Node.TEXT_NODE
          ? (() => {
              const text = node.textContent ?? "",
                element = node.parentElement;
              if (!element || !shown(element)) return "";
              if (!text.trim()) return text;
              const range = document.createRange();
              range.selectNodeContents(node);
              const rectangles = Array.from(range.getClientRects());
              return rectangles.length > 0 && rectangles.every((box) => painted(box, element, true))
                ? text
                : "";
            })()
          : Array.from(node.childNodes).map(deepText).join("");
    const target = one(input.target);
    const selected = one('[data-testid="primary-card-button-' + input.selection.projectId + '"]');
    const controls = input.requiredSelectors.map(one),
      values = input.requiredValues.map((item) => ({
        element: one(item.selector),
        value: item.value,
      }));
    const visibleText = (element: Element) => deepText(element).replace(/\s+/g, " ").trim();
    const text = target ? visibleText(target) : "";
    const textScopes = input.requiredTextScopes.map((scope) => ({
      element: one(scope.selector),
      text: scope.text,
    }));
    const toasts = Array.from(
      document.querySelectorAll('[data-slot="toast-viewport"] > [data-position]'),
    )
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(
        ({ element, box }) =>
          shown(element) &&
          [box.x, box.y, box.width, box.height, box.right, box.bottom].every(Number.isFinite) &&
          box.width > 0 &&
          box.height > 0 &&
          box.x < innerWidth &&
          box.right > 0 &&
          box.y < innerHeight &&
          box.bottom > 0,
      );
    const hit = (element: Element) => {
      const box = element.getBoundingClientRect();
      if (
        toasts.some(
          (toast) =>
            !toast.element.contains(element) &&
            box.x < toast.box.right &&
            box.right > toast.box.x &&
            box.y < toast.box.bottom &&
            box.bottom > toast.box.y,
        )
      )
        return false;
      return [box.x + box.width / 4, box.x + box.width / 2, box.right - box.width / 4].every((x) =>
        [box.y + box.height / 4, box.y + box.height / 2, box.bottom - box.height / 4].every((y) => {
          const at = document.elementFromPoint(x, y);
          return (
            at !== null &&
            (at === element || element.contains(at) || element.shadowRoot?.contains(at) === true)
          );
        }),
      );
    };
    return {
      contextMatched:
        input.origin === "http://127.0.0.1:4885" &&
        location.origin === input.origin &&
        location.pathname === input.path &&
        location.hash === "" &&
        ["", "?tab=conversation", "?tab=checks", "?tab=files"].includes(location.search) &&
        input.selection.environmentId === "local" &&
        /^[A-Za-z0-9._:-]{1,128}$/.test(input.selection.projectId) &&
        selected !== null &&
        visible(selected),
      themeMatched:
        document.documentElement.classList.contains("dark") === (input.theme === "dark"),
      targetVisible: target !== null && visible(target),
      controlsVisible: controls.every(
        (element) => element !== null && visible(element) && hit(element),
      ),
      expectedVisible:
        target !== null &&
        input.requiredText.every((value) => text.includes(value)) &&
        textScopes.every(
          (scope) =>
            scope.element !== null &&
            visible(scope.element) &&
            scope.text.every((value) =>
              visibleText(scope.element!).includes(value.replace(/\s+/g, " ").trim()),
            ),
        ) &&
        values.every(
          (item) =>
            (item.element instanceof HTMLInputElement ||
              item.element instanceof HTMLTextAreaElement) &&
            visible(item.element) &&
            hit(item.element) &&
            item.element.value === item.value,
        ),
      credentialsAbsent:
        document.querySelector(
          '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
        ) === null,
      bootAbsent:
        document.getElementById("boot-shell") === null &&
        document.querySelector("vite-error-overlay") === null,
    };
  } catch {
    return null;
  }
}
const witnessKeys = [
  "contextMatched",
  "themeMatched",
  "targetVisible",
  "controlsVisible",
  "expectedVisible",
  "credentialsAbsent",
  "bootAbsent",
] as const;
export function validatePullRequestsCaptureWitness(value: unknown): Record<string, true> {
  if (
    !value ||
    typeof value !== "object" ||
    NodeUtil.types.isProxy(value) ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== witnessKeys.length ||
    !Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && witnessKeys.some((field) => field === key),
    )
  )
    throw new Error("Owned request capture refused.");
  const result: Record<string, true> = {};
  for (const key of witnessKeys) {
    if (ownValue(value, key) !== true) throw new Error("Owned request capture refused.");
    result[key] = true;
  }
  return result;
}
export function pullRequestsObservationFor(
  binding: PullRequestsCaptureBinding,
  selection: GitProjectVisualSelection,
  origin: string,
): PullRequestsCaptureObservation {
  const gitlab = binding.row.includes("gitlab"),
    provider = gitlab ? "gitlab" : "github",
    number = binding.row === "request-review-edit-error" ? 43 : gitlab ? 42 : 41;
  const panel = 'section[aria-label="Pull Requests"]';
  let path = "/project/local/" + selection.projectId + "/pull-requests",
    target = panel;
  const requiredText: string[] = ["owned/requests", provider + ".visual.invalid"],
    requiredSelectors: string[] = [],
    requiredValues: { selector: string; value: string }[] = [],
    requiredTextScopes: { selector: string; text: readonly string[] }[] = [];
  if (binding.row.endsWith("detail")) {
    if (binding.substate === "base") {
      requiredText.push(
        gitlab ? "!42" : "#41",
        gitlab ? "Owned GitLab request" : "Owned GitHub request",
      );
      requiredSelectors.push(
        panel + ' a[title="' + (gitlab ? "Owned GitLab request" : "Owned GitHub request") + '"]',
      );
    } else {
      path += "/" + number;
      if (binding.substate === "secondary-confirmation") {
        target = '[data-slot="alert-dialog-popup"]';
        requiredText.length = 0;
        requiredText.push(
          "Delete merge request !42",
          "This cannot be undone on gitlab.visual.invalid.",
        );
        requiredSelectors.push(
          '//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Cancel"]',
          '//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Delete merge request"]',
        );
      } else {
        requiredSelectors.push(panel + ' button[role="tab"][aria-selected="true"]');
        const header = panel + " header:has(h1)",
          metadata = panel + ' div[class~="lg:block"] > aside[aria-label="Request details"]';
        requiredSelectors.push(header, metadata);
        requiredTextScopes.push(
          {
            selector: header,
            text: [
              gitlab ? "Owned GitLab request" : "Owned GitHub request",
              gitlab ? "!42" : "#41",
              "Open",
              pullRequestsFixtureValues.author,
              "visual-request",
              "main",
            ],
          },
          { selector: header + ' [aria-label="Change base branch"] code', text: ["main"] },
          {
            selector: metadata,
            text: ["Assignees", "Labels", gitlab ? "bug" : "rust", "Milestone", "Next"],
          },
        );
        requiredText.push(
          gitlab ? "!42" : "#41",
          binding.substate === "checks"
            ? gitlab
              ? "Pipelines"
              : "Checks"
            : binding.substate === "files"
              ? gitlab
                ? "Changes"
                : "Files changed"
              : "Conversation",
        );
        if (binding.substate === "checks") requiredText.push("build");
        else if (binding.substate === "files") {
          requiredText.push("visual-request.ts", "approved", "Owned inline feedback");
          const suggestion = panel + ' section[aria-label="Suggested change"]',
            reactions = suggestion + ' + [aria-label="Reactions"]';
          requiredSelectors.push(suggestion, reactions, suggestion + " button:not([disabled])");
          requiredTextScopes.push(
            {
              selector: suggestion,
              text: [
                "Lines 1–1",
                "-export const approved = true;",
                "+" + pullRequestsFixtureValues.suggestion,
                gitlab
                  ? "This suggestion cannot be applied to the current head"
                  : pullRequestsFixtureValues.githubSuggestionReason,
              ],
            },
            { selector: reactions, text: [gitlab ? "👍 1" : "👍 2"] },
          );
        } else {
          const conversation = panel + ' [role="list"][aria-label="Conversation"]';
          requiredSelectors.push(conversation);
          if (binding.substate === "conversation") {
            const description =
              conversation + ' article:has(> header):has(> [aria-label="Reactions"])';
            const reactions = description + ' > [aria-label="Reactions"]';
            requiredSelectors.push(description, reactions);
            requiredTextScopes.push(
              {
                selector: description,
                text: ["Owned request description", pullRequestsFixtureValues.author],
              },
              { selector: reactions, text: [gitlab ? "👍 1" : "👍 2"] },
            );
          } else {
            const review = conversation + ' article[role="listitem"]:not(:has(> header))';
            const activity = conversation + ' div[role="listitem"]:not(:has(article))';
            requiredSelectors.push(review, activity);
            requiredTextScopes.push(
              { selector: review, text: ["reviewer", "approved these changes"] },
              {
                selector: activity,
                text: [gitlab ? "added 2 commits" : "labeled", gitlab ? "viewer" : "rust"],
              },
            );
          }
        }
      }
    }
  } else if (binding.row.startsWith("request-create")) {
    target = '[data-testid="git-manager-create-pr-dialog"]';
    requiredText.length = 0;
    requiredText.push(
      "Repository",
      "https://" + provider + ".visual.invalid",
      gitlab ? "Create merge request" : "Create pull request",
      "Source branch",
      "Target branch",
      "Title",
      "Description",
      "Owned fixture action was refused.",
      "Retry",
      "Cancel",
    );
    requiredSelectors.push(
      target + " #git-manager-create-pr-title",
      target + " #git-manager-create-pr-body",
      target + ' [data-testid="create-pr-status"]',
      '//*[@data-testid="git-manager-create-pr-dialog"]//button[normalize-space()="Retry"]',
      '//*[@data-testid="git-manager-create-pr-dialog"]//button[normalize-space()="Cancel"]',
    );
    requiredValues.push(
      { selector: target + " #git-manager-create-pr-head", value: "visual-create" },
      { selector: target + " #git-manager-create-pr-base", value: "main" },
      {
        selector: target + " #git-manager-create-pr-title",
        value: pullRequestsFixtureValues.createTitle,
      },
      {
        selector: target + " #git-manager-create-pr-body",
        value: pullRequestsFixtureValues.createBody,
      },
    );
  } else {
    path += "/43";
    requiredText.length = 0;
    if (binding.substate === "base") {
      target = '[data-slot="popover-popup"]';
      requiredText.push(
        "Submit review",
        "Review summary",
        "Revoke approval",
        "The host rejected this operation.",
      );
      requiredSelectors.push(
        target + ' textarea[aria-label="Review summary"]',
        target + ' [aria-label="Review type"]',
        target + ' [role="alert"]',
      );
      requiredValues.push({
        selector: target + ' textarea[aria-label="Review summary"]',
        value: pullRequestsFixtureValues.review,
      });
    }
    if (binding.substate === "editors") {
      requiredText.push("The host rejected this operation.");
      requiredSelectors.push(
        panel + ' section[aria-label="Edit title"] [role="alert"]',
        panel + ' section[aria-label="Edit description"] [role="alert"]',
      );
      requiredValues.push(
        { selector: panel + ' input[aria-label="Title"]', value: pullRequestsFixtureValues.title },
        {
          selector: panel + ' textarea[aria-label="Description"]',
          value: pullRequestsFixtureValues.body,
        },
      );
    }
    if (binding.substate === "comment") {
      target = panel + ' section[aria-label="Comment"]';
      requiredText.push("The host rejected this operation.");
      requiredSelectors.push(target + " textarea", target + ' [role="alert"]');
      requiredValues.push({
        selector: target + " textarea",
        value: pullRequestsFixtureValues.comment,
      });
    }
    if (binding.substate === "confirmation-undo") {
      target = '[data-slot="alert-dialog-popup"]';
      requiredText.push("Delete this comment?", "This cannot be undone on github.visual.invalid.");
      requiredSelectors.push(
        '//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Delete comment"]',
        '//*[@data-slot="toast-viewport"]//button[normalize-space()="Undo"]',
      );
    }
    if (binding.substate === "inline-draft") {
      target = panel + ' section[aria-label="Inline review comment"]';
      requiredText.push(
        "Comment on visual-request.ts:1",
        "Insert suggestion",
        "Add review comment",
        "Discard draft",
      );
      requiredSelectors.push(
        target + " textarea",
        '//section[@aria-label="Inline review comment"]//button[normalize-space()="Add review comment"]',
      );
      requiredValues.push({
        selector: target + " textarea",
        value: pullRequestsFixtureValues.inline,
      });
    }
    if (binding.substate === "pending-inline") {
      target = '//article[.//p[normalize-space()="Pending review comment"]]';
      requiredText.push(
        "Pending review comment",
        pullRequestsFixtureValues.inline,
        "Edit",
        "Remove",
      );
      requiredSelectors.push(target + '//button[normalize-space()="Remove"]');
    }
    if (binding.substate === "base-chooser") {
      target = '[data-slot="combobox-popup"]';
      requiredText.push("main", "visual-create");
      requiredSelectors.push(
        'input[aria-label="Base branch"]',
        '//*[@role="option" and .//div[normalize-space()="visual-create"]]',
      );
    }
    if (binding.substate === "base-confirmation") {
      target = '[data-slot="alert-dialog-popup"]';
      requiredText.push(
        "Change base branch",
        "Change the base from",
        "main",
        "visual-create",
        "1 pending review comment",
      );
      requiredSelectors.push(
        '//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Cancel"]',
        '//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Change base"]',
      );
    }
    if (binding.substate === "dismiss-review") {
      target = '[data-slot="alert-dialog-popup"]';
      requiredText.push("Dismiss review", "github.visual.invalid", "Message (required)");
      requiredSelectors.push(
        target + " textarea",
        '//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Cancel"]',
      );
      requiredValues.push({
        selector: target + " textarea",
        value: pullRequestsFixtureValues.dismiss,
      });
    }
    if (binding.substate === "merge-config") {
      target = panel + ' section[aria-label="Merge status"]';
      requiredText.push("Merge subject", "Merge body", "Delete branch after merge", "Merge commit");
      requiredSelectors.push(
        target + ' input[aria-label="Merge subject"]',
        target + ' textarea[aria-label="Merge body"]',
        '//section[@aria-label="Merge status"]//button[normalize-space()="Merge"]',
      );
      requiredValues.push(
        {
          selector: target + ' input[aria-label="Merge subject"]',
          value: pullRequestsFixtureValues.mergeSubject,
        },
        {
          selector: target + ' textarea[aria-label="Merge body"]',
          value: pullRequestsFixtureValues.mergeBody,
        },
      );
    }
    if (binding.substate === "merge-confirmation") {
      target = '[data-slot="alert-dialog-popup"]';
      requiredText.push(
        "Merge pull request",
        "Merge now",
        "main",
        "Method: Merge commit",
        "Delete branch: No",
        "Auto-merge: No",
      );
      requiredSelectors.push(
        '//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Cancel"]',
        '//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Merge"]',
      );
    }
  }
  return {
    origin,
    theme: binding.theme,
    selection,
    path,
    target,
    requiredText,
    requiredSelectors,
    requiredValues,
    requiredTextScopes,
  };
}
export interface PullRequestsOwnedCaptureInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  evidence: string;
  captured: Set<string>;
  binding: PullRequestsCaptureBinding;
  selection: GitProjectVisualSelection;
  origin: string;
  verifyOwnedIdentity: () => Promise<void>;
  readContext: () => Promise<unknown>;
}
/** Original bytes/hash/geometry and before/after source/context joins retain the shared capture owner. */
export async function capturePullRequestsOwnedScene(input: PullRequestsOwnedCaptureInput) {
  if (
    !pullRequestsCaptureBindings.some(
      (binding) =>
        binding.row === input.binding.row &&
        binding.substate === input.binding.substate &&
        binding.theme === input.binding.theme &&
        binding.file === input.binding.file,
    )
  )
    throw new Error("Owned request capture refused.");
  const observation = pullRequestsObservationFor(input.binding, input.selection, input.origin),
    provider = input.binding.row.includes("gitlab") ? "gitlab" : "github";
  const expectedContext: PullRequestsExpectedHostContext = {
    provider,
    host: provider + ".visual.invalid",
    repository: "owned/requests",
    account: "viewer",
  };
  return captureOwnedVisualScene({
    browser: input.browser,
    owner: input.owner,
    evidence: input.evidence,
    captured: input.captured,
    file: input.binding.file,
    observation: () => observation,
    read: (value) => input.browser.execute(readPullRequestsCaptureWitness, value),
    verifyOwnedIdentity: async () => {
      await input.verifyOwnedIdentity();
      if (!projectPullRequestsHostContext(await input.readContext(), expectedContext))
        throw new Error("Owned request capture refused.");
    },
    validate: validatePullRequestsCaptureWitness,
    project: (value) => ({
      row: input.binding.row,
      substate: input.binding.substate,
      theme: input.binding.theme,
      ...value,
    }),
    refused: () => new Error("Owned request capture refused."),
  });
}
