// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PullRequestsPermissionButton } from "./PullRequestsPermissionButton";
describe("PullRequestsPermissionButton", () => {
  it("exposes the server reason on a disabled button and to assistive technology", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <PullRequestsPermissionButton
        permission={{ allowed: false, reason: "Write access required" }}
        onClick={() => {}}
      >
        Edit
      </PullRequestsPermissionButton>,
    );
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Write access required");
    expect(button.parentElement?.title).toBe("Write access required");
    const reason = container.querySelector(`[id="${button.getAttribute("aria-describedby")}"]`);
    expect(reason?.textContent).toBe("Write access required");
    expect(reason?.classList.contains("sr-only")).toBe(true);
  });
  it("allows a permitted action without a disabled description", () => {
    const html = renderToStaticMarkup(
      <PullRequestsPermissionButton
        permission={{ allowed: true, reason: null }}
        onClick={() => {}}
        variant="outline"
        size="sm"
      >
        Refresh
      </PullRequestsPermissionButton>,
    );
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("aria-describedby");
  });
});
