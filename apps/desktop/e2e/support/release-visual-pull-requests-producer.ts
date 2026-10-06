import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
import type { GitProjectVisualSelection } from "./release-visual-git-project.ts";
import type { PullRequestsHostingFixture } from "./release-visual-pull-requests-installer.ts";
import { pullRequestsFixtureValues } from "./release-visual-pull-requests-fixture.ts";
import {
  pullRequestsCaptureBindings,
  projectPullRequestsHostContext,
  type PullRequestsCaptureBinding,
  type PullRequestsVisualRow,
  type PullRequestsVisualSubstate,
} from "./release-visual-pull-requests.ts";
export interface PullRequestsVisualInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until" | "cleanup">;
  theme: "light" | "dark";
  origin: string;
  fixture: Pick<PullRequestsHostingFixture, "projects">;
  step: (phase: string) => void;
  /** Root implements ordinary import/select/sidebar navigation, with decoded descriptor/project identity. */
  openRequests: (provider: "github" | "gitlab") => Promise<GitProjectVisualSelection>;
  verifyOwnedIdentity: (selection: GitProjectVisualSelection) => Promise<void>;
  readContext: (selection: GitProjectVisualSelection) => Promise<unknown>;
  /** Root binds the strict capturePullRequestsOwnedScene owner, never an injected renderer. */
  capture: (
    binding: PullRequestsCaptureBinding,
    selection: GitProjectVisualSelection,
  ) => Promise<unknown>;
  verifyHostingBaselineRestored: () => Promise<void>;
  restoreOriginal: () => Promise<void>;
  verifyRestoredIdentity: () => Promise<void>;
  observeFailure?: (error: unknown, phase: string) => void;
}
const refused = () => new Error("Owned request producer refused.");
/** One finite group; public actions, failed owned hosting mutations and ordinary Undo only. */
export async function runPullRequestsVisual(input: PullRequestsVisualInput) {
  if (input.origin !== "http://127.0.0.1:4885" || !["light", "dark"].includes(input.theme))
    throw refused();
  const { browser } = input;
  let phase = "visual-pull-requests-entry",
    failed = false,
    original: unknown,
    restored = false;
  const files: string[] = [];
  const step = (next: string) => {
    phase = next;
    input.step(next);
  };
  const click = async (selector: string) => {
    const control = browser.$(selector);
    await control.waitForDisplayed();
    if ((await browser.$$(selector).length) !== 1) throw refused();
    await control.waitForEnabled();
    await control.click();
  };
  const fill = async (selector: string, value: string) => {
    const control = browser.$(selector);
    await control.waitForDisplayed();
    if ((await browser.$$(selector).length) !== 1) throw refused();
    await control.waitForEnabled();
    await control.setValue(value);
    if ((await control.getValue()) !== value) throw refused();
  };
  const verify = async (provider: "github" | "gitlab", selection: GitProjectVisualSelection) => {
    if (
      selection.environmentId !== "local" ||
      selection.cwd !== input.fixture.projects[provider].cwd
    )
      throw refused();
    await input.verifyOwnedIdentity(selection);
    if (
      !projectPullRequestsHostContext(await input.readContext(selection), {
        provider,
        host: provider + ".visual.invalid",
        repository: "owned/requests",
        account: "viewer",
      })
    )
      throw refused();
  };
  const capture = async (
    row: PullRequestsVisualRow,
    substate: PullRequestsVisualSubstate,
    selection: GitProjectVisualSelection,
  ) => {
    const binding = pullRequestsCaptureBindings.find(
      (value) => value.row === row && value.substate === substate && value.theme === input.theme,
    );
    if (!binding || files.includes(binding.file)) throw refused();
    await input.verifyOwnedIdentity(selection);
    await browser.performActions([
      {
        type: "pointer",
        id: "qualification-pointer",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", duration: 0, x: 1, y: 1, origin: "viewport" }],
      },
    ]);
    await input.capture(binding, selection);
    await input.verifyOwnedIdentity(selection);
    files.push(binding.file);
  };
  const tab = async (label: string) =>
    click(
      '//section[@aria-label="Pull Requests"]//button[@role="tab" and starts-with(normalize-space(),"' +
        label +
        '")]',
    );
  const openNumber = async (number: number, selection: GitProjectVisualSelection) =>
    click('a[href^="/project/local/' + selection.projectId + "/pull-requests/" + number + '?"]');
  const panel = 'section[aria-label="Pull Requests"]';
  try {
    for (const provider of ["github", "gitlab"] as const) {
      step("visual-pull-requests-" + provider + "-open");
      const selection = await input.openRequests(provider);
      await verify(provider, selection);
      const row: PullRequestsVisualRow =
          provider === "github" ? "request-github-detail" : "request-gitlab-detail",
        number = provider === "github" ? 41 : 42;
      step("visual-pull-requests-" + provider + "-list-capture");
      await capture(row, "base", selection);
      await openNumber(number, selection);
      await verify(provider, selection);
      step("visual-pull-requests-" + provider + "-conversation");
      await tab("Conversation");
      await capture(row, "conversation", selection);
      step("visual-pull-requests-" + provider + "-conversation-activity");
      await browser
        .$(panel + ' section[aria-label="Comment"] textarea')
        .scrollIntoView({ block: "end", inline: "nearest" });
      await capture(row, "conversation-activity", selection);
      step("visual-pull-requests-" + provider + "-checks");
      await tab(provider === "github" ? "Checks" : "Pipelines");
      await capture(row, "checks", selection);
      step("visual-pull-requests-" + provider + "-files");
      await tab(provider === "github" ? "Files changed" : "Changes");
      await capture(row, "files", selection);
      if (provider === "gitlab") {
        step("visual-pull-requests-secondary-confirmation");
        await click('//button[normalize-space()="More actions"]');
        await click('//*[@role="menuitem" and normalize-space()="Delete"]');
        await capture(row, "secondary-confirmation", selection);
        await click('//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Cancel"]');
        await browser.$('[data-slot="alert-dialog-popup"]').waitForDisplayed({ reverse: true });
      }
      await click(
        '//button[normalize-space()="Back to ' +
          (provider === "github" ? "pull requests" : "merge requests") +
          '"]',
      );
      step("visual-pull-requests-" + provider + "-create-open");
      await click(
        '//button[normalize-space()="New ' +
          (provider === "github" ? "pull request" : "merge request") +
          '"]',
      );
      await fill("#git-manager-create-pr-head", "visual-create");
      await click('//*[@role="option" and .//div[normalize-space()="visual-create"]]');
      await fill("#git-manager-create-pr-base", "main");
      await click('//*[@role="option" and .//div[normalize-space()="main"]]');
      await fill("#git-manager-create-pr-title", pullRequestsFixtureValues.createTitle);
      await fill("#git-manager-create-pr-body", pullRequestsFixtureValues.createBody);
      step("visual-pull-requests-" + provider + "-create-submit");
      await click(
        '//*[@data-testid="git-manager-create-pr-dialog"]//button[normalize-space()="Publish and create ' +
          (provider === "github" ? "pull request" : "merge request") +
          '"]',
      );
      await input.owner.until(async () =>
        (
          (await browser.$('[data-testid="create-pr-status"]').getAttribute("class")) ?? ""
        ).includes("text-destructive"),
      );
      await capture(
        provider === "github" ? "request-create-github" : "request-create-gitlab",
        "base",
        selection,
      );
      await click(
        '//*[@data-testid="git-manager-create-pr-dialog"]//button[normalize-space()="Cancel"]',
      );
    }
    step("visual-pull-requests-review-open");
    const selection = await input.openRequests("github");
    await verify("github", selection);
    await openNumber(43, selection);
    step("visual-pull-requests-inline-draft");
    await tab("Files changed");
    await click(
      ">>> " +
        panel +
        ' diffs-container [data-column-number="1"][data-line-type="change-addition"]',
    );
    await fill(
      panel + ' section[aria-label="Inline review comment"] textarea',
      pullRequestsFixtureValues.inline,
    );
    await capture("request-review-edit-error", "inline-draft", selection);
    await click(
      '//section[@aria-label="Inline review comment"]//button[normalize-space()="Add review comment"]',
    );
    await capture("request-review-edit-error", "pending-inline", selection);
    step("visual-pull-requests-base-chooser");
    await click('[aria-label="Change base branch"]');
    await capture("request-review-edit-error", "base-chooser", selection);
    await click('//*[@role="option" and .//div[normalize-space()="visual-create"]]');
    await capture("request-review-edit-error", "base-confirmation", selection);
    await click('//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Cancel"]');
    await browser.$('[data-slot="alert-dialog-popup"]').waitForDisplayed({ reverse: true });
    await click(
      '//article[.//p[normalize-space()="Pending review comment"]]//button[normalize-space()="Remove"]',
    );
    step("visual-pull-requests-dismiss-review");
    await tab("Conversation");
    await browser
      .$(panel + ' article[role="listitem"]:not(:has(> header))')
      .scrollIntoView({ block: "center", inline: "nearest" });
    await click('//article[@role="listitem"]//button[normalize-space()="Dismiss review"]');
    await fill('[data-slot="alert-dialog-popup"] textarea', pullRequestsFixtureValues.dismiss);
    await capture("request-review-edit-error", "dismiss-review", selection);
    await click('//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Cancel"]');
    await browser.$('[data-slot="alert-dialog-popup"]').waitForDisplayed({ reverse: true });
    step("visual-pull-requests-merge-config");
    const merge = panel + ' section[aria-label="Merge status"]';
    await browser.$(merge).scrollIntoView({ block: "center", inline: "nearest" });
    await click(merge + ' [aria-label="Merge method"]');
    await click('//*[@role="option" and normalize-space()="Merge commit"]');
    await fill(
      merge + ' input[aria-label="Merge subject"]',
      pullRequestsFixtureValues.mergeSubject,
    );
    await fill(merge + ' textarea[aria-label="Merge body"]', pullRequestsFixtureValues.mergeBody);
    await capture("request-review-edit-error", "merge-config", selection);
    await click('//section[@aria-label="Merge status"]//button[normalize-space()="Merge"]');
    await capture("request-review-edit-error", "merge-confirmation", selection);
    await click('//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Cancel"]');
    await browser.$('[data-slot="alert-dialog-popup"]').waitForDisplayed({ reverse: true });
    step("visual-pull-requests-title-error");
    await click('[aria-label="Edit title"]');
    await fill('input[aria-label="Title"]', pullRequestsFixtureValues.title);
    await click('//section[@aria-label="Edit title"]//button[normalize-space()="Save"]');
    await input.owner.until(async () =>
      (await browser.$('section[aria-label="Edit title"] [role="alert"]').getText()).includes(
        "The host rejected this operation.",
      ),
    );
    step("visual-pull-requests-body-error");
    await click('[aria-label="Edit description"]');
    await fill('textarea[aria-label="Description"]', pullRequestsFixtureValues.body);
    await click('//section[@aria-label="Edit description"]//button[normalize-space()="Save"]');
    await input.owner.until(async () =>
      (await browser.$('section[aria-label="Edit description"] [role="alert"]').getText()).includes(
        "The host rejected this operation.",
      ),
    );
    await capture("request-review-edit-error", "editors", selection);
    step("visual-pull-requests-comment-error");
    await fill(
      panel + ' section[aria-label="Comment"] textarea',
      pullRequestsFixtureValues.comment,
    );
    await click('//section[@aria-label="Comment"]//button[normalize-space()="Comment"]');
    await input.owner.until(async () =>
      (await browser.$('section[aria-label="Comment"] [role="alert"]').getText()).includes(
        "The host rejected this operation.",
      ),
    );
    await capture("request-review-edit-error", "comment", selection);
    step("visual-pull-requests-review-error");
    await tab("Files changed");
    await click('//button[normalize-space()="Review · 0 pending comments"]');
    await fill('textarea[aria-label="Review summary"]', pullRequestsFixtureValues.review);
    await click('//*[@data-slot="popover-popup"]//button[normalize-space()="Submit review"]');
    await input.owner.until(async () =>
      (await browser.$('[data-slot="popover-popup"] [role="alert"]').getText()).includes(
        "The host rejected this operation.",
      ),
    );
    await capture("request-review-edit-error", "base", selection);
    await browser.keys("Escape");
    step("visual-pull-requests-undo-confirmation");
    await tab("Conversation");
    await click('[aria-label="Edit Labels"]');
    await click('input[aria-label="owned-label"]');
    await click('//*[@data-slot="dialog-popup"]//button[normalize-space()="Done"]');
    await click(
      '//article[.//*[normalize-space()="Owned existing comment"]]//button[@aria-label="Comment actions"]',
    );
    await click('//*[@role="menuitem" and normalize-space()="Delete"]');
    await capture("request-review-edit-error", "confirmation-undo", selection);
    await click('//*[@data-slot="alert-dialog-popup"]//button[normalize-space()="Cancel"]');
    await click('//*[@data-slot="toast-viewport"]//button[normalize-space()="Undo"]');
    await verify("github", selection);
    await input.verifyHostingBaselineRestored();
    if (files.length !== 24) throw refused();
    return {
      theme: input.theme,
      baseRows: 5,
      supplementalOriginals: 19,
      files,
      originalContextRestored: true as const,
      hostingBaselineRestored: true as const,
    };
  } catch (error) {
    failed = true;
    original = error;
    try {
      input.observeFailure?.(error, phase);
    } catch {
      /* Attribution cannot replace the original action. */
    }
    throw error;
  } finally {
    try {
      await input.owner.cleanup("visual-owned-pull-requests-context", async () => {
        await input.restoreOriginal();
        await input.verifyRestoredIdentity();
        restored = true;
      });
    } catch {
      if (failed) throw original;
      throw refused();
    }
    if (!restored && !failed) throw refused();
  }
}
