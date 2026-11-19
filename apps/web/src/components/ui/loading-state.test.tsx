// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mount } from "../pullRequests/review/testHelpers";
import { LoadingState, RefreshIndicator, RefreshRegion } from "./loading-state";
import { expectLoadingModel } from "./loading-state.testing";

let view: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await view?.unmount();
});

describe("LoadingState", () => {
  it("announces one named status beside an exposed busy region, with a motion-safe spinner", async () => {
    view = await mount(
      <LoadingState label="Loading things…">
        <div data-slot="skeleton" />
      </LoadingState>,
    );
    expectLoadingModel(document, ["Loading things…"]);
    const status = document.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Loading things…");
    const spinner = status?.querySelector("svg");
    expect(spinner?.getAttribute("aria-hidden")).toBe("true");
    expect(spinner?.getAttribute("class")).toContain("animate-spin");
    expect(spinner?.getAttribute("class")).toContain("motion-reduce:animate-none");
    // The skeletons are the content being loaded.
    expect(document.querySelector('[aria-busy="true"] [data-slot="skeleton"]')).not.toBeNull();
  });

  it("marks its region busy when there is no skeleton to show", async () => {
    view = await mount(<LoadingState label="Loading tags…" />);
    expectLoadingModel(document, ["Loading tags…"]);
  });
});

describe("RefreshRegion", () => {
  it("names the reread beside the busy content while refreshing", async () => {
    view = await mount(
      <RefreshRegion refreshing status="Refreshing things…">
        <p>Content</p>
      </RefreshRegion>,
    );
    expectLoadingModel(document, ["Refreshing things…"]);
    expect(document.querySelector('[aria-busy="true"]')?.textContent).toBe("Content");
  });

  it("shows no status and no busy mark once the read settles", async () => {
    view = await mount(
      <RefreshRegion refreshing={false} status="Refreshing things…">
        <p>Content</p>
      </RefreshRegion>,
    );
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector("[aria-busy]")).toBeNull();
  });
});

describe("RefreshIndicator", () => {
  it("shows a compact visible label", async () => {
    view = await mount(<RefreshIndicator label="Refreshing things…" />);
    const status = document.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-label")).toBe("Refreshing things…");
    expect(status?.textContent).toContain("Refreshing things…");
  });
});
