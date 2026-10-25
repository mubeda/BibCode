// @vitest-environment jsdom
// A real DOM: these cases depend on how a Range inside one element clones (#171).
import { afterEach, describe, expect, it } from "vite-plus/test";

import { chatMarkdownClipboardPayload } from "./markdown-clipboard";

const SOURCE = 'graph TD\n  A["a < b & c"] --> B';
const FENCED = `\`\`\`mermaid\n${SOURCE}\n\`\`\``;

function renderedMarkdown(): HTMLElement {
  const root = document.createElement("div");
  root.className = "chat-markdown";
  root.innerHTML = [
    "<p>Before the diagram.</p>",
    '<div class="chat-markdown-codeblock" data-language="mermaid">',
    '<div class="chat-markdown-codeblock-header select-none"><span>mermaid</span></div>',
    '<div class="chat-markdown-mermaid-body"><div class="chat-markdown-mermaid" data-markdown-atomic="">',
    '<svg xmlns="http://www.w3.org/2000/svg"><g><text>a &lt; b &amp; c</text></g><g><text>B</text></g></svg>',
    "</div></div></div>",
    '<p>See <a class="chat-markdown-file-link" data-markdown-copy="[main.ts](src/main.ts)" href="src/main.ts"><span>main.ts</span></a> next.</p>',
  ].join("");
  root.querySelector(".chat-markdown-mermaid")!.setAttribute("data-markdown-copy", FENCED);
  document.body.append(root);
  return root;
}

function select(range: Range): Selection {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("copying a drawn diagram", () => {
  it("copies the fenced source for a selection inside the diagram", () => {
    const root = renderedMarkdown();
    const label = root.querySelector(".chat-markdown-mermaid text")!.firstChild!;
    const range = document.createRange();
    range.setStart(label, 2);
    range.setEnd(label, 5);

    const payload = chatMarkdownClipboardPayload(select(range));

    expect(payload?.text).toBe(FENCED);
    expect(payload?.html).toBe(
      '<meta charset="utf-8"><pre><code class="language-mermaid">graph TD\n  A["a &lt; b &amp; c"] --&gt; B</code></pre>',
    );
  });

  it("copies a paragraph and a diagram a selection spans", () => {
    const root = renderedMarkdown();
    const range = document.createRange();
    range.setStart(root.querySelector("p")!.firstChild!, 0);
    range.setEnd(root.querySelectorAll(".chat-markdown-mermaid text")[1]!.firstChild!, 1);

    const payload = chatMarkdownClipboardPayload(select(range));

    expect(payload?.text).toBe(`Before the diagram.\n\n${FENCED}`);
    expect(payload?.html).toContain('<pre><code class="language-mermaid">graph TD');
    expect(payload?.html).not.toContain("<svg");
  });

  it("leaves a selection inside a file chip as its text", () => {
    const root = renderedMarkdown();
    const chipText = root.querySelector(".chat-markdown-file-link span")!.firstChild!;
    const range = document.createRange();
    range.setStart(chipText, 0);
    range.setEnd(chipText, 4);

    expect(chatMarkdownClipboardPayload(select(range))?.text).toBe("main");
  });
});
