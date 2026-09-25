// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import { detail, denied } from "../detail/testFixtures";
import { allowed, button, click, input, mount, projectRef } from "../review/testHelpers";
import { PullRequestsTitleEditor } from "./PullRequestsTitleEditor";
import { PullRequestsBodyEditor } from "./PullRequestsBodyEditor";

let mounted: Awaited<ReturnType<typeof mount>>;
beforeEach(() => usePullRequestsStore.setState({ byProjectKey: {} }));
afterEach(async () => {
  await mounted?.unmount();
});
const editable = { ...detail, permissions: { ...detail.permissions, editPullRequest: allowed } };
describe("request editors", () => {
  it.each(["title", "body"] as const)(
    "saves %s through the write path and clears only that successful draft",
    async (field) => {
      mounted = await mount(
        field === "title" ? (
          <PullRequestsTitleEditor provider="github" detail={editable} projectRef={projectRef} />
        ) : (
          <PullRequestsBodyEditor
            detail={editable}
            projectRef={projectRef}
            baseUrl="https://github.com/team/repo/"
          />
        ),
      );
      await click(field === "title" ? "Edit title" : "Edit description");
      const control = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        field === "title" ? 'input[aria-label="Title"]' : 'textarea[aria-label="Description"]',
      )!;
      expect(control.value).toBe(detail[field]);
      await input(control, field === "title" ? "Changed title" : "**Changed** description");
      if (field === "body") {
        await click("Preview");
        expect(document.querySelector("strong")?.textContent).toBe("Changed");
      }
      await click("Save");
      expect(mounted.run).toHaveBeenCalledExactlyOnceWith({
        action: "editPullRequest",
        title: null,
        body: null,
        baseBranch: null,
        [field]: field === "title" ? "Changed title" : "**Changed** description",
      });
      expect(
        usePullRequestsStore.getState().selectDraft(projectRef, 14)[
          field === "title" ? "titleEdit" : "bodyEdit"
        ],
      ).toBeNull();
    },
  );
  it.each(["title", "body"] as const)(
    "keeps %s after Escape, remount and a structured failure",
    async (field) => {
      const ui =
        field === "title" ? (
          <PullRequestsTitleEditor provider="github" detail={editable} projectRef={projectRef} />
        ) : (
          <PullRequestsBodyEditor detail={editable} projectRef={projectRef} />
        );
      mounted = await mount(ui);
      const editLabel = field === "title" ? "Edit title" : "Edit description";
      await click(editLabel);
      const control = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        field === "title" ? "input" : "textarea",
      )!;
      await input(control, "Keep this draft");
      await act(async () =>
        control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(document.querySelector(field === "title" ? "input" : "textarea")).toBeNull();
      await mounted.unmount();
      mounted = await mount(ui);
      await click(editLabel);
      expect(
        document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          field === "title" ? "input" : "textarea",
        )?.value,
      ).toBe("Keep this draft");
      mounted.run.mockRejectedValue({ code: "forbidden", message: "Write access changed" });
      await click("Save");
      expect(document.querySelector('[role="alert"]')?.textContent).toBe("Write access changed");
      expect(
        usePullRequestsStore.getState().selectDraft(projectRef, 14)[
          field === "title" ? "titleEdit" : "bodyEdit"
        ],
      ).toBe("Keep this draft");
    },
  );
  it("rejects blank titles and allows clearing the description", async () => {
    mounted = await mount(
      <PullRequestsTitleEditor provider="github" detail={editable} projectRef={projectRef} />,
    );
    await click("Edit title");
    await input(document.querySelector("input")!, "  ");
    expect(button("Save").disabled).toBe(true);
    await mounted.render(<PullRequestsBodyEditor detail={editable} projectRef={projectRef} />);
    await click("Edit description");
    await input(document.querySelector("textarea")!, "");
    await click("Save");
    expect(mounted.run).toHaveBeenCalledWith({
      action: "editPullRequest",
      title: null,
      body: "",
      baseBranch: null,
    });
  });
  it("shows server permission reasons and never opens a denied editor", async () => {
    mounted = await mount(
      <>
        <PullRequestsTitleEditor provider="github" detail={detail} projectRef={projectRef} />
        <PullRequestsBodyEditor detail={detail} projectRef={projectRef} />
      </>,
    );
    for (const name of ["Edit title", "Edit description"]) {
      expect(button(name).disabled).toBe(true);
      expect(button(name).title).toBe(denied.reason);
    }
  });
});
