/** Markdown inputs for the rich-editing round-trip tests. Each one is a shape a real file has. */

export const yamlFrontmatter = "---\ntitle: Guide\ntags: [a, b]\n---\n\n# Guide\n\nIntro text.\n";

export const tomlFrontmatterNoFinalNewline = '+++\ntitle = "Guide"\n+++';

export const alignedTable =
  "| Name | Count | Note |\n|:-----|------:|:----:|\n| one  |     1 | a    |\n| two  |    22 | b    |\n\nAfter the table.\n";

export const fourBacktickFence =
  "Before the fence.\n\n````js   \nconst value = 1;   \n```\nnot a close\n````\n\nThe last paragraph.\n";

export const mixedListMarkers = "* star one\n* star two\n\n- dash three\n- dash four\n";

export const listWithNestedFence =
  "* first item\n* second item\n\n  ````text\n  nested code\n  ````\n\n* third item\n";

export const blockquoteWithList =
  "> Quoted intro.\n>\n> - quoted one\n> - quoted _two_\n\nOutside.\n";

export const setextHeadings = "Main title\n==========\n\nSection\n-------\n\nBody text.\n";

export const handWrittenDetails =
  "Intro.\n\n<details>\n<summary>More</summary>\n\nHidden text.\n\nSecond hidden paragraph with _underscores_.\n\n</details>\n\nOutro.\n";

export const crlfLineEndings = "# Title\r\n\r\nFirst paragraph.\r\n\r\nSecond paragraph.\r\n";

export const taskList = "- [ ] open task\n- [x] done task\n\nAfter tasks.\n";

export const referenceLinks =
  "See [the docs][docs] for more.\n\n[docs]: https://example.test/docs\n";

export const footnote = "A claim.[^1]\n\n[^1]: The source.\n";

export const htmlComment = "Text.\n\n<!-- hidden note -->\n\nMore text.\n";

export const rawDiv = "Text.\n\n<div>raw block</div>\n\nMore text.\n";

export const inlineMath = "The area is $a^2$ here.\n";

export const blockMath = "Before.\n\n$$\nE = mc^2\n$$\n\nAfter.\n";

/** Every fixture the editor must keep editable (none of the read-only constructs). */
/** One HTML block with no body: TipTap writes it back in the blank-line form. */
export const emptyDetails = "<details><summary>More</summary></details>\n\nHello\n";

export const supportedFixtures = {
  alignedTable,
  fourBacktickFence,
  mixedListMarkers,
  listWithNestedFence,
  blockquoteWithList,
  setextHeadings,
  handWrittenDetails,
  emptyDetails,
  crlfLineEndings,
  taskList,
} as const;
