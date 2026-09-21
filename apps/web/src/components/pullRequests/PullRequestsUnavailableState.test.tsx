// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
let container: HTMLDivElement;
let root: Root;
const copy = vi.fn(async () => undefined);
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: copy }, configurable: true });
  copy.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
describe("PullRequestsUnavailableState", () => {
  it.each([
    "no_remote",
    "unsupported_provider",
    "unknown_host",
    "cli_missing",
    "not_authenticated",
    "repository_unreachable",
    "cli_too_old",
  ])("renders %s recovery verbatim and rescans", async (code) => {
    const rescan = vi.fn();
    await act(async () =>
      root.render(
        <PullRequestsUnavailableState
          reason={`Server advice for ${code}`}
          authCommand="glab auth login --hostname company.test"
          installHint="Install glab on this server."
          onRescan={rescan}
        />,
      ),
    );
    expect(container.textContent).toContain(`Server advice for ${code}`);
    expect(container.textContent).toContain("Install glab on this server.");
    expect(container.querySelector("code")?.textContent).toBe(
      "glab auth login --hostname company.test",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Copy authentication command"]')!
        .click(),
    );
    expect(copy).toHaveBeenCalledWith("glab auth login --hostname company.test");
    expect(container.textContent).toContain("Copied");
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Rescan")!.click(),
    );
    expect(rescan).toHaveBeenCalledOnce();
  });
  it("links the settings-off state to Source Control", async () => {
    await act(async () =>
      root.render(<PullRequestsUnavailableState reason="Off" disabledInSettings />),
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/settings/source-control");
  });
  it("keeps the command selectable when clipboard copying fails", async () => {
    copy.mockRejectedValueOnce(new Error("denied"));
    await act(async () =>
      root.render(<PullRequestsUnavailableState reason="Sign in" authCommand="gh auth login" />),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Copy authentication command"]')!
        .click(),
    );
    expect(container.textContent).toContain("Copy failed. Select and copy the command above.");
    expect(container.querySelector("code")?.textContent).toBe("gh auth login");
  });
});
