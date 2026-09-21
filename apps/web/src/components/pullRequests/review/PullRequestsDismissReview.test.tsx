// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vite-plus/test";
import { review } from "../detail/testFixtures";
import { PullRequestsDismissReview } from "./PullRequestsDismissReview";
import { allowed, button, click, input, mount, mockRun } from "./testHelpers";
let view: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await view?.unmount();
});
describe("PullRequestsDismissReview", () => {
  it("requires a message and confirmation, passes the opaque review id, and preserves a failed message", async () => {
    const run = mockRun().mockRejectedValueOnce(new Error("Dismissal refused"));
    view = await mount(
      <PullRequestsDismissReview
        review={{ ...review, id: "rv:17:opaque", canDismiss: true }}
        permission={allowed}
        host="github.example"
      />,
      run,
    );
    await click("Dismiss review");
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("github.example");
    expect(button("Dismiss review", dialog).disabled).toBe(true);
    expect(run).not.toHaveBeenCalled();
    await input(dialog.querySelector("textarea")!, "Superseded by a new review");
    await click("Dismiss review", dialog);
    expect(run).toHaveBeenCalledWith({
      action: "dismissReview",
      reviewId: "rv:17:opaque",
      message: "Superseded by a new review",
    });
    expect(dialog.querySelector("textarea")?.value).toBe("Superseded by a new review");
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Dismissal refused");
    await click("Dismiss review", dialog);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
  it("keeps unsupported GitLab dismissal visible even when canDismiss is false", async () => {
    view = await mount(
      <PullRequestsDismissReview
        review={{ ...review, canDismiss: false }}
        permission={{ allowed: false, reason: "GitLab does not support dismissing reviews" }}
        host="gitlab.example"
      />,
    );
    expect(button("Dismiss review").disabled).toBe(true);
    expect(button("Dismiss review").title).toBe("GitLab does not support dismissing reviews");
  });
});
