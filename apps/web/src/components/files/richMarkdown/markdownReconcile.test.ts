import { describe, expect, it, vi } from "vite-plus/test";

import * as corpus from "./fixtures/corpus";
import { canReconcile, reconcileMarkdown } from "./markdownReconcile";

const allFixtures = Object.values(corpus).filter(
  (value): value is Extract<(typeof corpus)[keyof typeof corpus], string> =>
    typeof value === "string",
);

describe("reconcileMarkdown", () => {
  it("returns the original unchanged when nothing was edited, for every corpus fixture", () => {
    for (const original of allFixtures) {
      const canonical = `${original.trim()} canonical`;
      expect(reconcileMarkdown({ original, before: canonical, after: canonical })).toBe(original);
    }
  });

  it("keeps every byte before an edited last paragraph, including a four-backtick fence", () => {
    const original = corpus.fourBacktickFence;
    const before =
      "Before the fence.\n\n````js\nconst value = 1;   \n```\nnot a close\n````\n\nThe last paragraph.";
    const after = before.replace("The last paragraph.", "The last paragraph, edited.");

    expect(reconcileMarkdown({ original, before, after })).toBe(
      original.replace("The last paragraph.", "The last paragraph, edited."),
    );
  });

  it("leaves the blocks before and after an inserted block byte-identical", () => {
    const original = corpus.setextHeadings;
    const before = "# Main title\n\n## Section\n\nBody text.";
    const after = "# Main title\n\nInserted.\n\n## Section\n\nBody text.";

    expect(reconcileMarkdown({ original, before, after })).toBe(
      "Main title\n==========\n\nInserted.\n\nSection\n-------\n\nBody text.\n",
    );
  });

  it("a block inserted between blocks the original wrote with no blank line keeps the rest's bytes", () => {
    const original = "# Title\nPara\n\n*   a\n*   b\n";
    const before = "# Title\n\nPara\n\n* a\n* b";
    const after = "# Title\n\nnew\n\nPara\n\n* a\n* b";

    expect(reconcileMarkdown({ original, before, after })).toBe(
      "# Title\n\nnew\n\nPara\n\n*   a\n*   b\n",
    );
  });

  it("writes a changed block with the original's CRLF line endings", () => {
    const original = corpus.crlfLineEndings;
    const before = "# Title\n\nFirst paragraph.\n\nSecond paragraph.";
    const after = "# Title\n\nFirst paragraph changed.\nNext line.\n\nSecond paragraph.";

    expect(reconcileMarkdown({ original, before, after })).toBe(
      "# Title\r\n\r\nFirst paragraph changed.\r\nNext line.\r\n\r\nSecond paragraph.\r\n",
    );
  });

  it("keeps a sibling list item's marker and nested fence when the first item is edited", () => {
    const original = corpus.listWithNestedFence;
    const before = "* first item\n* second item\n  ```text\n  nested code\n  ```\n* third item";
    const after = before.replace("first item", "first item edited");

    expect(reconcileMarkdown({ original, before, after })).toBe(
      original.replace("first item", "first item edited"),
    );
  });

  it("keeps sibling bytes when an item inside a block quote is edited", () => {
    const original = corpus.blockquoteWithList;
    const before = "> Quoted intro.\n>\n> - quoted one\n> - quoted *two*\n\nOutside.";
    const after = before.replace("quoted one", "quoted uno");

    expect(reconcileMarkdown({ original, before, after })).toBe(
      original.replace("quoted one", "quoted uno"),
    );
  });

  it("keeps sibling bytes when a paragraph inside a details body is edited", () => {
    const original = corpus.handWrittenDetails;
    const before =
      "Intro.\n\n<details>\n<summary>More</summary>\n\nHidden text.\n\nSecond hidden paragraph with *underscores*.\n\n</details>\n\nOutro.";
    const after = before.replace("Hidden text.", "Hidden text, edited.");

    expect(reconcileMarkdown({ original, before, after })).toBe(
      original.replace("Hidden text.", "Hidden text, edited."),
    );
  });

  it("takes an ambiguous region from the edit and keeps fenced code contents", () => {
    const original = "Title\n=====\n\n# Title\n\n````\ncode\n````\n";
    const before = "# Title\n\n# Title\n\n```\ncode\n```";
    // The first heading was deleted; both serialize the same, so neither original is chosen.
    const after = "# Title\n\n```\ncode\n```";

    expect(reconcileMarkdown({ original, before, after })).toBe("# Title\n\n````\ncode\n````\n");
  });

  it("does not copy a deleted block back through the separator", () => {
    const original = "Alpha\n\nDelete me\n\n````\nkeep\n````\n\nOmega\n";
    const before = "Alpha\n\nDelete me\n\n```\nkeep\n```\n\nOmega";
    const after = "Alpha\n\n```\nkeep\n```\n\nOmega";

    expect(reconcileMarkdown({ original, before, after })).toBe(
      "Alpha\n\n````\nkeep\n````\n\nOmega\n",
    );
  });

  it("keeps mixed line endings inside an untouched fence when a block is deleted", () => {
    const original = "````text\none\r\ntwo\r\n````\n\nAlpha\n\nDelete me\n\nOmega";
    const before = "```text\none\r\ntwo\r\n```\n\nAlpha\n\nDelete me\n\nOmega";
    const after = "```text\none\r\ntwo\r\n```\n\nAlpha\n\nOmega";

    expect(reconcileMarkdown({ original, before, after })).toBe(
      "````text\none\r\ntwo\r\n````\n\nAlpha\n\nOmega",
    );
  });

  it("takes a table from the edit when its rebuilt rows no longer read as the edit", () => {
    const original = "Intro\n=====\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const before = "# Intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
    const after = "# Intro\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |";

    expect(reconcileMarkdown({ original, before, after })).toBe(
      "Intro\n=====\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n",
    );
  });

  it("changes only the checkbox character when a task is ticked", () => {
    const original = "-   [ ] Keep\n- [ ] Other\n";
    const before = "- [ ] Keep\n- [ ] Other";
    const after = "- [x] Keep\n- [ ] Other";

    expect(reconcileMarkdown({ original, before, after })).toBe("-   [x] Keep\n- [ ] Other\n");
  });

  it("gives an inserted ordered item the list's delimiter and keeps the renumbered item", () => {
    const original = "1) one\n2) two\n";
    const before = "1. one\n2. two";
    const after = "1. one\n2. new\n3. two";

    expect(reconcileMarkdown({ original, before, after })).toBe("1) one\n2) new\n2) two\n");
  });

  it("never changes the original's final-newline state", () => {
    const edit = (original: string) =>
      reconcileMarkdown({ original, before: "A\n\nB", after: "A\n\nB2" });

    expect(edit("A\n\nB")).toBe("A\n\nB2");
    expect(edit("A\n\nB\n")).toBe("A\n\nB2\n");
    expect(edit("A\n\nB\n\n\n")).toBe("A\n\nB2\n\n\n");
  });
});

describe("an empty details block", () => {
  // TipTap 3.31.4 writes `<details><summary>More</summary></details>` as the blank-line form.
  const original = "<details><summary>More</summary></details>\n\nHello\n";
  const before = "<details>\n<summary>More</summary>\n\n\n\n</details>\n\nHello";

  it("opens editable and keeps its bytes when the paragraph after it is edited", () => {
    expect(canReconcile({ original, before })).toBe(true);
    expect(reconcileMarkdown({ original, before, after: `${before} world` })).toBe(
      "<details><summary>More</summary></details>\n\nHello world\n",
    );
  });
});

describe("a reconcile whose blocks do not line up", () => {
  it("saves the edit from the serialization instead of throwing", () => {
    const failures = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(reconcileMarkdown({ original: "A\n", before: "A\n\nB", after: "A\n\nB x" })).toBe(
      "A\n\nB x\n",
    );
    expect(failures).toHaveBeenCalledOnce();
    failures.mockRestore();
  });
});

describe("canReconcile", () => {
  it("is true for every supported fixture with a faithful serialization", () => {
    for (const original of Object.values(corpus.supportedFixtures)) {
      expect(canReconcile({ original, before: original })).toBe(true);
    }
    expect(
      canReconcile({
        original: corpus.setextHeadings,
        before: "# Main title\n\n## Section\n\nBody text.",
      }),
    ).toBe(true);
    expect(
      canReconcile({
        original: corpus.alignedTable,
        before:
          "\n| Name | Count | Note |\n| :--- | ---: | :---: |\n| one | 1 | a |\n| two | 22 | b |\n\nAfter the table.",
      }),
    ).toBe(true);
    expect(
      canReconcile({
        original: corpus.handWrittenDetails,
        before:
          "Intro.\n\n<details>\n<summary>More</summary>\n\nHidden text.\n\nSecond hidden paragraph with *underscores*.\n\n</details>\n\nOutro.",
      }),
    ).toBe(true);
  });

  it("treats a wrapped CRLF paragraph as the same text as its LF serialization", () => {
    expect(canReconcile({ original: "first\r\nsecond\r\n", before: "first\nsecond" })).toBe(true);
  });

  it("is false when the serialization has one block fewer", () => {
    expect(canReconcile({ original: "A\n\nB\n\nC\n", before: "A\n\nB" })).toBe(false);
  });

  it("is false when a nested list has a different number of items", () => {
    expect(
      canReconcile({
        original: "- one\n  - a\n  - b\n- two\n",
        before: "- one\n  - a\n- two",
      }),
    ).toBe(false);
  });

  it("is false when the serialization loses inline content", () => {
    expect(
      canReconcile({
        original: "[![a](b.png)](https://example.test)\n",
        before: "![a](b.png)",
      }),
    ).toBe(false);
  });
});
