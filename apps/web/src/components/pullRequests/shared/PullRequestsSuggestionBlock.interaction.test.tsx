// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PullRequestsSuggestionBlock,
  PullRequestsApplySuggestionsButton,
  PullRequestsSuggestionSelectionContext,
} from "./PullRequestsSuggestionBlock";
import { thread } from "../detail/testFixtures";
import { allowed, button, click, input, mount, mockRun } from "../review/testHelpers";
let view: Awaited<ReturnType<typeof mount>>;
const suggestion = { ...thread.comments[0]!.suggestion!, id: "101" };
afterEach(async () => {
  await view?.unmount();
  vi.restoreAllMocks();
});
describe("suggestion actions", () => {
  it("applies one GitLab suggestion with an optional commit message", async () => {
    view = await mount(
      <PullRequestsSuggestionBlock suggestion={suggestion} permission={allowed} />,
    );
    await click("Apply");
    await input(
      document.querySelector('input[aria-label="Commit message (optional)"]')!,
      "Improve wording",
    );
    await click("Apply suggestion");
    expect(view.run).toHaveBeenCalledWith({
      action: "applySuggestions",
      suggestionIds: ["101"],
      commitMessage: "Improve wording",
    });
  });
  it("keeps Apply disabled and displays the host reason plus Copy when unsupported", async () => {
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    view = await mount(
      <PullRequestsSuggestionBlock
        suggestion={{ ...suggestion, id: null }}
        permission={{ allowed: false, reason: "GitHub has no public API to apply suggestions" }}
      />,
    );
    expect(button("Apply").disabled).toBe(true);
    expect(view.container.textContent).toContain("GitHub has no public API to apply suggestions");
    await click("Copy");
    expect(copy).toHaveBeenCalledWith(suggestion.toContent);
    expect(view.run).not.toHaveBeenCalled();
  });
  it("does not apply an outdated suggestion and keeps input/selection on failure", async () => {
    view = await mount(
      <PullRequestsSuggestionBlock
        suggestion={{ ...suggestion, applicable: false }}
        permission={allowed}
      />,
    );
    expect(button("Apply").disabled).toBe(true);
    const run = mockRun().mockRejectedValue(
      new Error("The suggestion changed. Refresh and try again."),
    );
    await view.unmount();
    view = await mount(
      <PullRequestsSuggestionBlock suggestion={suggestion} permission={allowed} />,
      run,
    );
    await click("Apply");
    await input(
      document.querySelector('input[aria-label="Commit message (optional)"]')!,
      "Keep message",
    );
    await click("Apply suggestion");
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Commit message (optional)"]')
        ?.value,
    ).toBe("Keep message");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Refresh");
  });
  it("selects suggestions and applies a batch with null message", async () => {
    const toggle = vi.fn();
    const success = vi.fn();
    view = await mount(
      <PullRequestsSuggestionSelectionContext value={{ selected: new Set(), toggle }}>
        <PullRequestsSuggestionBlock suggestion={suggestion} permission={allowed} />
        <PullRequestsApplySuggestionsButton
          suggestionIds={["101", "102"]}
          permission={allowed}
          label="Apply 2 selected"
          onApplied={success}
        />
      </PullRequestsSuggestionSelectionContext>,
    );
    await act(async () =>
      view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    expect(toggle).toHaveBeenCalledWith("101", true);
    await click("Apply 2 selected");
    await click("Apply 2 suggestions");
    expect(view.run).toHaveBeenCalledWith({
      action: "applySuggestions",
      suggestionIds: ["101", "102"],
      commitMessage: null,
    });
    expect(success).toHaveBeenCalledWith(["101", "102"]);
  });
});
