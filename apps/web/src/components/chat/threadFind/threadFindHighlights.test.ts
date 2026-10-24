// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  claimFindHighlights,
  collectRowRanges,
  collectScopeSegments,
  FIND_ACTIVE_HIGHLIGHT_NAME,
  FIND_HIGHLIGHT_NAME,
  locateTargetRange,
  paintFindHighlights,
  releaseFindHighlights,
  setFindHighlightSupportForTests,
} from "./threadFindHighlights";
import { prepareFindQuery } from "./threadFindText";

function element(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

afterEach(() => {
  document.body.replaceChildren();
  setFindHighlightSupportForTests(undefined);
});

describe("collectScopeSegments", () => {
  it("reads displayed text only, split at blocks", () => {
    const scope = element(
      [
        '<p>Visible <span data-find-ignore="">chrome</span>text<svg><text>icon</text></svg></p>',
        '<p hidden="">hidden text</p>',
        '<p style="display: none">suspended copy</p>',
        "<ul><li>one</li><li>two</li></ul>",
      ].join(""),
    );
    expect(collectScopeSegments(scope).map((segment) => segment.folded)).toEqual([
      "visible text",
      "one",
      "two",
    ]);
  });

  it("reads a raw line break as whitespace and a Markdown one once", () => {
    const scope = element("<p>one<br>two</p><p>three<br>\nfour</p>");
    expect(collectScopeSegments(scope).map((segment) => segment.folded)).toEqual([
      "one two",
      "three four",
    ]);
  });

  it("records the details blocks around each segment", () => {
    const scope = element(
      [
        "<p>outside</p>",
        '<div data-markdown-details-content="0"><p>first</p>',
        '<div data-markdown-details-content="1"><p>nested</p></div></div>',
      ].join(""),
    );
    expect(collectScopeSegments(scope).map((segment) => segment.details)).toEqual([
      [],
      [0],
      [0, 1],
    ]);
  });
});

describe("ranges", () => {
  it("builds a range across inline elements and finds a target by its details path", () => {
    const row = element(
      [
        '<div data-find-scope="md:0">',
        "<p>al<em>pha</em> beta</p>",
        '<div data-markdown-details-content="2"><p>alpha again</p></div>',
        "</div>",
      ].join(""),
    );
    const query = prepareFindQuery("alpha")!;
    expect(collectRowRanges(row, query).map((range) => range.toString())).toEqual([
      "alpha",
      "alpha",
    ]);
    const inBlock = locateTargetRange(row, { scope: "md:0", details: [2], index: 0 }, query);
    expect(inBlock?.startContainer.textContent).toBe("alpha again");
    expect(locateTargetRange(row, { scope: "md:1", details: [], index: 0 }, query)).toBeNull();
  });
});

describe("highlight ownership", () => {
  function fakeSupport() {
    const registry = new Map<string, unknown>();
    setFindHighlightSupportForTests({
      registry: {
        set: (name, highlight) => registry.set(name, highlight),
        delete: (name) => registry.delete(name),
      },
      createHighlight: (ranges) => ranges,
    });
    return registry;
  }

  it("lets one owner paint, and revokes it when another claims the registry", () => {
    const registry = fakeSupport();
    const first = Symbol("first");
    const second = Symbol("second");
    const revokeFirst = vi.fn();
    claimFindHighlights(first, revokeFirst);
    const range = document.createRange();
    expect(paintFindHighlights(first, [range], range)).toBe(true);
    expect([...registry.keys()].toSorted()).toEqual(
      [FIND_ACTIVE_HIGHLIGHT_NAME, FIND_HIGHLIGHT_NAME].toSorted(),
    );

    claimFindHighlights(second, vi.fn());
    expect(revokeFirst).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    expect(paintFindHighlights(first, [range], null)).toBe(false);

    // A surface that no longer owns the registry cannot clear it.
    paintFindHighlights(second, [range], null);
    releaseFindHighlights(first);
    expect(registry.has(FIND_HIGHLIGHT_NAME)).toBe(true);
    releaseFindHighlights(second);
    expect(registry.size).toBe(0);
  });

  it("reports that it cannot paint without the Custom Highlight API", () => {
    setFindHighlightSupportForTests(null);
    const token = Symbol("owner");
    claimFindHighlights(token, vi.fn());
    expect(paintFindHighlights(token, [], null)).toBe(false);
    releaseFindHighlights(token);
  });
});
