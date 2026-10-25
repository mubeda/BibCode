// @vitest-environment happy-dom
/**
 * Parity between Find in thread's projection and what `ChatMarkdown` renders: for a corpus that
 * covers every custom component, the DOM occurrence count inside the find scope, without the
 * ignored chrome, equals the projection's count for every query.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import ChatMarkdown from "../../ChatMarkdown";
import { findScopeOccurrences } from "./threadFindHighlights";
import { locateFindOccurrences, prepareFindQuery, projectFindSource } from "./threadFindText";

vi.mock("../../ui/menu", () => ({
  Menu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => (
    <>{render ?? children}</>
  ),
  MenuPopup: () => null,
  MenuItem: () => null,
}));

const SKILLS = [
  { name: "review", displayName: "Code Review" },
  { name: "deploy", displayName: "" },
];
const CWD = "/repo";
const ALL_DETAILS_OPEN = new Map(Array.from({ length: 16 }, (_, index) => [index, true] as const));

const CORPUS: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
  {
    name: "lists and emphasis",
    text: [
      "# Heading with **bold** and $review",
      "",
      "Intro paragraph with *emphasis*, ~~strike~~ and `inline code` plus $review.",
      "",
      "- first item $review",
      "- second item with [a link](https://example.com/path) inside",
      "  - nested item <kbd>Ctrl</kbd>+<kbd>F</kbd>",
      "- [ ] open task",
      "- [x] done task",
      "",
      "1. ordered one",
      "2. ordered two",
      "",
      "> quoted text with $deploy",
      "> second line",
    ].join("\n"),
  },
  {
    name: "tables and code",
    text: [
      "| Name | Value $review |",
      "| ---- | ----- |",
      "| alpha | `beta` |",
      "| gamma [file](/repo/src/table.ts) | delta |",
      "",
      '```ts title="src/index.ts"',
      "const answer = 42;",
      "export { answer };",
      "```",
      "",
      "```someunknownlanguage",
      "raw fallback content",
      "```",
      "",
      "    indented code block",
      "",
      "<pre>plain preformatted</pre>",
    ].join("\n"),
  },
  {
    name: "links and file chips",
    text: [
      "Open [one](/repo/src/a/file.ts) and [two](/repo/src/b/file.ts#L12C3).",
      "Then [three](./notes/readme.md:4) or [ext](https://docs.example.com/guide).",
      "Fragment [jump](#heading) and mail [me](mailto:me@example.com).",
      "Autolink https://autolink.example.com/x and www.example.org.",
      "Link with markup [**bold** $review text](https://bold.example.com).",
      "Plain link with skill [$review now](#frag).",
      "External link with skill [$review later](https://skill.example.com).",
      "Unsafe [click](javascript:alert(1)).",
      "Image ![alt text](https://example.com/a.png) after.",
    ].join("\n"),
  },
  {
    name: "details",
    text: [
      "<details>",
      "<summary>Summary with **bold**</summary>",
      "",
      "Hidden body text",
      "",
      "<details open>",
      "<summary>Inner summary</summary>",
      "",
      "Inner hidden text",
      "",
      "</details>",
      "",
      "</details>",
      "",
      "<details>",
      "",
      "Body without summary",
      "",
      "</details>",
      "",
      "<details open>raw<br>break inside</details>",
      "",
      "After details.",
    ].join("\n"),
  },
  {
    name: "raw html and breaks",
    text: [
      'Safe <span onclick="evil()">span text</span> and <script>alert("x")</script> gone.',
      "<style>.x{color:red}</style>",
      '<iframe src="https://evil.example.com"></iframe>',
      "Line one<br>line two<br/>line three",
      "Hard break  ",
      "next line",
      "Entities &amp; &lt;tag&gt; &copy;",
      "<div>raw div block</div>",
      "",
      "Footnote reference[^1].",
      "",
      "[^1]: The footnote text.",
    ].join("\n"),
  },
  {
    // A drawn diagram and the source it shows until then are not searched; a fence that is not
    // closed renders as plain code and is.
    name: "mermaid diagrams",
    text: [
      "Before the diagram.",
      "",
      "```mermaid",
      "graph TD",
      "  Alpha --> Beta",
      "```",
      "",
      "Between diagrams with Alpha.",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  Gamma->>Alpha: hello",
    ].join("\n"),
  },
  {
    name: "chat-style input",
    text: "first line\nsecond line with $review\n\nnew paragraph $deploy\n  indented",
  },
];

const FIXED_QUERIES = [
  " ",
  "a",
  "e",
  "line",
  "line two",
  "first line second",
  "code review",
  "deploy",
  "$review",
  "file.ts",
  "file.ts · src/b",
  "l12:c3",
  "example.com",
  "https://",
  "answer = 42",
  "42;\nexport",
  "hidden",
  "summary",
  "details",
  "ctrl+f",
  "alpha beta",
  "&",
  "<tag>",
  "©",
  "footnote",
  "1",
  "↩",
];

interface Mounted {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mounted: Mounted[] = [];

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
});

async function mount(text: string, lineBreaks: boolean): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () =>
    root.render(
      <ChatMarkdown
        text={text}
        cwd={CWD}
        skills={SKILLS}
        lineBreaks={lineBreaks}
        detailsOpen={ALL_DETAILS_OPEN}
        onDetailsOpenChange={() => {}}
        findScope="md:0"
      />,
    ),
  );
  return container;
}

function queriesFor(container: HTMLElement): string[] {
  const words = new Set<string>(FIXED_QUERIES);
  const text = container.querySelector("[data-find-scope]")?.textContent ?? "";
  const tokens = text.split(/\s+/).filter((token) => token.length > 1);
  for (const [index, token] of tokens.entries()) {
    words.add(token);
    const next = tokens[index + 1];
    if (next) words.add(`${token} ${next}`);
  }
  return [...words];
}

function parityMismatches(container: HTMLElement, text: string, lineBreaks: boolean): string[] {
  const scope = container.querySelector("[data-find-scope]")!;
  const segments = projectFindSource(
    { kind: "markdown", scope: "md:0", text, lineBreaks, skills: SKILLS },
    { cwd: CWD },
  );
  const mismatches: string[] = [];
  for (const query of queriesFor(container)) {
    const folded = prepareFindQuery(query)!;
    // Each occurrence by the details blocks that hold it: find maps the j-th occurrence in one
    // block to the j-th one the DOM shows there.
    const projected = locateFindOccurrences(segments, folded)
      .map((occurrence) => occurrence.segment.details.join("."))
      .join("|");
    const rendered = findScopeOccurrences(scope, folded)
      .map((occurrence) => occurrence.segment.details.join("."))
      .join("|");
    if (projected !== rendered) {
      mismatches.push(`${JSON.stringify(query)}: projected [${projected}], rendered [${rendered}]`);
    }
  }
  return mismatches;
}

describe("find projection parity with ChatMarkdown", () => {
  for (const lineBreaks of [false, true]) {
    for (const fixture of CORPUS) {
      it(`counts what is rendered: ${fixture.name}${lineBreaks ? " (line breaks)" : ""}`, async () => {
        const container = await mount(fixture.text, lineBreaks);
        expect(parityMismatches(container, fixture.text, lineBreaks)).toEqual([]);
      });
    }
  }

  it("counts highlighted code blocks the same as plain ones", async () => {
    const text = ["```ts", "const answer = 42;", "export { answer };", "```"].join("\n");
    const container = await mount(text, false);
    for (let attempt = 0; !container.querySelector(".chat-markdown-shiki"); attempt += 1) {
      if (attempt > 100) throw new Error("the highlighter never resolved");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    }
    expect(parityMismatches(container, text, false)).toEqual([]);
  });
});
