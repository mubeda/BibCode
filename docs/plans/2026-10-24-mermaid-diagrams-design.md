# Mermaid Diagrams in Chat Markdown

Status: Approved 2026-10-24 with every recommended answer. Issue #171. Pele `render()` on
the main thread through the #103 queue, a dedicated allowlist DOMPurify instance
as the SVG trust boundary, and no change to contracts, the server or
persistence. Revised after review (see Review).

## Problem

Chat markdown shows a closed ` ```mermaid ` fence only as Shiki-highlighted
source. BiBCode's own docs, plans and agent replies use Mermaid heavily (for
example `docs/architecture/overview.md:9`), so users read graph syntax where
they expect a diagram. The upstream project now draws these fences with the
`pele` package (upstream PR 21472). Drawing SVG from untrusted text adds a
trust boundary that `rehype-sanitize` does not cover, because an SVG inserted
into the DOM bypasses the markdown HAST.

## Current behavior (verified at 4e023ac5ff)

- Every ChatMarkdown fence goes through the `pre` override
  (`apps/web/src/components/ChatMarkdown.tsx:1630-1658`): `extractFenceLanguage`
  (`:177`) reads `language-mermaid`, and the block renders as a Shiki code block
  inside `MarkdownCodeBlock` (`:529`) with an error boundary (`:89`) whose
  fallback is the plain `<pre>`. Shiki's Mermaid grammar ships in
  `@shikijs/langs` 4.5.0, so that fallback costs nothing new.
- One override covers assistant and user messages
  (`apps/web/src/components/chat/MessagesTimeline.tsx:1213`, `:1744`, `:1766`,
  `:1853`, `:1879`, `:1914`), the Plan sidebar
  (`apps/web/src/components/PlanSidebar.tsx:257`), Proposed Plan cards
  (`apps/web/src/components/chat/ProposedPlanCard.tsx:175`, `:182`) and the
  rendered Markdown file view
  (`apps/web/src/components/files/FilePreviewPanel.tsx:617`), where the text
  comes from workspace files that anyone may have written. `PullRequestsMarkdown`
  imports only the sanitize schema and keeps its own renderer.
- Positions reach the override. The pipeline is remark-parse 11.0.0
  (micromark 4.0.3), remark-gfm, mdast-util-to-hast 13.2.1, rehype-raw 7.0.0
  and rehype-sanitize 6.0.0 (`ChatMarkdown.tsx:1686-1691`). A probe of that
  pipeline shows that `pre` positions survive rehype-raw and sanitize. A
  closed fence ends at its closing run, including any trailing spaces but
  excluding the line ending. An unclosed fence at the end of the text
  includes its trailing line endings; one ended by its container stops at its
  last content line. The code element's text is the body plus one appended
  `\n`.
- Finished blocks are highlighted by the #103 queue (`ChatMarkdown.tsx:722-766`):
  one job per `setTimeout(0)` macrotask, most recently mounted first, with a
  cancel for jobs that have not run. Jobs return a string; a throwing job is
  dropped and the plain block stays (`:757`). Results go to a 500-entry, 50 MB
  LRU keyed by `fnv1a32(code)`, the length, the language and the theme (`:148`,
  `:277`), with no source comparison. FNV-1a collides on Mermaid-shaped input:
  `flowchart TD\n A["76ab3ce7"]\n` and `flowchart TD\n A["2bb1fad8"]\n` both
  have length 28 and hash 2311057632 (`apps/web/src/lib/diffRendering.ts:19`).
- `isStreaming` is per message, not per fence. While a message streams, its code
  blocks highlight synchronously through `use()` with no cache (`:820-846`).
- `markdownComponents` is a `useMemo` (`:1436-1675`) whose dependencies are
  `diffThemeName`, `environmentId`, `fileLinkParentSuffixByPath`,
  `isStreaming`, `markdownFileLinkMetaByHref`, `onTaskListChange`,
  `openInPreferredEditor`, `openPreview`, `openMarkdownFileInPreview`,
  `resolvedTheme`, `skills`, `text` and `threadRef` (`:1660-1674`). Both link
  maps are rebuilt from `text` (`:1380-1398`). react-markdown uses each override
  as the element type (`hast-util-to-jsx-runtime` 2.3.6, `lib/index.js:711`), so
  every streaming delta and every theme switch gives every override a new type
  and React remounts it. Code blocks, tables and details lose their local state
  each time.
- Message text is replaced as well as appended. A non-streaming
  `thread.message-sent` replaces the accumulated text with the final text
  (`packages/client-runtime/src/state/threadReducer.ts:271-275`), and a snapshot
  replaces the whole thread (`packages/client-runtime/src/state/threads.ts:166-168`).
  A mounted fence's source can therefore change in place.
- The Proposed Plan preview truncates the plan to 10 visible lines and appends
  `...` (`apps/web/src/proposedPlan.ts:22-61`) inside a clipped
  `max-h-104 overflow-hidden` box (`ProposedPlanCard.tsx:173`), so it can cut
  a fence open. A finished but truncated text can therefore hold an unclosed
  fence.
- The timeline is a LegendList 3.3.10 whose `maintainVisibleContentPosition` is
  `{ data: true, size: false }` (`MessagesTimeline.tsx:538-541`; the library
  default for `size` is `true`). Its rows are absolutely positioned. With
  `size: true`, a size change keeps the first visible row's top in place
  (`prepareMVCP` anchors the first id in view), so content inside that row,
  below a growing block, still moves. The timeline already compensates
  locally for one case: `onToggleWorkGroup` measures an anchor element, commits
  with `flushSync`, and scrolls by the delta with `scrollToOffset`
  (`MessagesTimeline.tsx:280-311`). `timelineScrollAnchoring.ts` holds the
  pure helpers for this kind of anchoring.
- Browser scroll anchoring (`overflow-anchor`) ships in Chromium and WebView2,
  and in WebKit only from Safari 27 (caniuse `css-overflow-anchor`).
- Copy from rendered markdown (`ChatMarkdown.tsx:1404`) serializes the cloned
  selection (`apps/web/src/markdown-clipboard.ts:294`). An element with
  `data-markdown-copy` serializes as that value (`:186`), `svg` elements are
  skipped (`:27`), and a selection lying wholly inside one element clones only
  its text, so it never sees that element's attribute.
- Production CSPs: Tauri `script-src 'self'`, `img-src` with `data:` and
  `blob:`, `style-src 'self' 'unsafe-inline'`, no `frame-src`
  (`apps/desktop/src-tauri/tauri.conf.json:27`); the dev policy adds
  `'unsafe-eval'` (`:28`). Browser mode serves `script-src 'self'` and
  `img-src 'self' data: blob:` (`apps/server/src/http.rs:60`) plus `frame-src`
  (`:908-922`). Same-origin image loads are allowed in both, so the CSP
  does not stop a stray CSS image from issuing a GET to the app's own origin.
  `scripts/tauri-hardening.test.ts` pins the desktop policy. Workers already
  run under both (`DiffWorkerPoolProvider.tsx:2`, `deviceVideo.worker.ts`).
- Neither `pele` nor `dompurify` is in `pnpm-lock.yaml`.
  `scripts/toolchain-contract.test.ts:61-62` requires `pnpm-workspace.yaml` to
  have no `minimumReleaseAgeExclude`, and the dependency ledger applies a 14-day
  age rule to newly chosen declared targets
  (`docs/dependency-upgrades/2026-07-17-ledger.json:568`).

## Pele, verified from published source

- `pele` (MIT, no runtime dependencies) reimplements Mermaid 12.1.0 syntax with
  its own parser and layout. Sixteen releases shipped from 1.0.1 on
  2026-10-06 to 1.9.0 on 2026-10-22; 1.5.0 and 1.6.0 broke `mount()` in minor
  releases
  ([registry](https://registry.npmjs.org/pele),
  [releases](https://github.com/obsidianmd/pele/releases)). Version 1.0.0 (2020)
  is an unrelated older package.
- **No `eval` or `new Function`.** A scan of all 289 files under `src/` at tag
  1.9.0 finds neither; GitHub code search finds `new Function` only under
  `tests/support/`. The published `dist/pele.js`, `dist/esm/lazy.js` and
  `dist/esm/core.js` on jsDelivr contain no `eval(`, `new Function(` or
  `Function(` call. The build is esbuild
  (`scripts/build.mjs`). The pinned version is re-scanned by a guard test (Test
  plan, item 6).
- **Bundle split.** `pele/lazy` (`dist/esm/lazy.js`, 3,011 bytes) statically
  imports four shared chunks (about 32.7 KB minified in total) and holds a map
  of diagram type to `import("./chunks/<hash>.js")`, one per type; its `load(type)`
  dedupes and clears a failed import so it can be retried (`src/lazy.ts`). The
  full `pele` entry is 701,816 bytes and must not be imported. The upstream
  author measured 60 KB gzip for the first flowchart against 201 KB for
  mermaid.js, as reported in #171.
- **DOM use.** `render()` returns a string. It measures text with
  `OffscreenCanvas`, else a canvas, else a built-in width table
  (`src/text/measurer.ts:77-83`), so it also runs in a worker. `mount()` adds a
  ResizeObserver, font tracking, extra probe renders at `maxWidth: 1` and the
  container's width (`src/mount.ts:150-170`), and inserts with `innerHTML`
  unless given `sanitize` (`:173-176`).
- **Theming.** The root `<svg>` carries an inline `style` that aliases the
  public tokens (`--_fg:var(--pele-fg,#1f1f1f)` and so on, `src/svg/theme.ts`),
  and shapes use `fill="var(--_fg)"`. Stripping `style` attributes would break
  theming. Pele has no Mermaid theme support: no `themeVariables`, and `theme`
  is never read.
- **What Pele writes into `style`** (the published 1.3.0 and 1.9.0 bundles).
  The root style holds `max-width` and `height` (with `responsive`), the
  `--_bg`, `--_fg`, `--_m`, `--_l`, `--_s`, `--_a`, `--_b`, `--_c`, `--_fm`,
  `--_r`, `--_w`, `--_hw` and `--_tw` aliases, `color`, `font`,
  `letter-spacing`, `word-spacing`, `text-transform`, `direction` and
  `font-family`. The `font-family` value can hold quoted names, from a pattern
  that admits no `"'\;:@(){}<>` inside the quotes. Shapes add `rx`, `stroke`
  and `text-decoration`.
  User `style`, `classDef` and `linkStyle` declarations are limited to the
  shape properties `fill`, `fill-opacity`, `stroke`, `stroke-width`,
  `stroke-dasharray`, `stroke-dashoffset`, `stroke-linecap`, `stroke-linejoin`,
  `stroke-opacity`, `opacity`, `rx` and `ry`, and to the text properties
  `color` (written as `fill`), `font-size`, `font-family`, `font-weight`,
  `font-style`, `text-decoration`, `letter-spacing` and `word-spacing`. Values
  matching `RE_UNSAFE` are dropped: `url(`, `expression(`, `javascript:`,
  `@import`, `image-set`, `/*`, and any of `<>{};\`. This is Pele's own first
  layer. BiBCode's sanitizer does not rely on it.
- **Elements and attributes.** Apart from link, image and math output, the
  bundles emit only `svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `polygon`,
  `text`, `tspan`, `title` and `desc`. Sankey adds `defs`, `linearGradient` and
  `stop` in 1.9.0. There are no markers: arrowheads are paths.
- **Output.** Text is escaped; `click` callbacks are ignored; links and images
  are omitted with `links: false` and `images: false` (since 1.3.0). The only
  `<foreignObject>` is for host-supplied `math`, and the only id reference is a
  sankey gradient (`url(#…)`). The `icons` and `math` hooks insert markup
  unfiltered ([security](https://pele.run/security)). Host limits: `limit`
  50,000 characters, `outputLimit` 4,000,000, `maxEdges` 5,000, and a diagram's
  own config cannot change them (`src/types.ts:68`). There is no time limit;
  the security page suggests a worker the app can terminate. API:
  [pele.run/api](https://pele.run/api).
  Rendering takes 0.05-0.3 ms for typical diagrams against 6-82 ms for
  mermaid.js, by the project's own comparison ([pele.run](https://pele.run/)).

## Goals

- A closed `mermaid` fence draws as a diagram in every ChatMarkdown surface,
  the moment its own closing fence arrives, and never from partial source.
- Diagram SVG crosses one documented, tested sanitizer before it reaches the
  DOM. Without relying on Pele, it cannot run script, navigate, load a
  resource, style the app or be styled by app classes.
- No main-bundle growth; no new main-thread work for messages without diagrams;
  a cached diagram appears in the same commit as its remount.
- A diagram drawing or redrawing never moves the line the user is reading in
  the timeline (issue acceptance criterion 6). This is a merge gate.
- Theme switches recolor diagrams with no re-render.
- An invalid diagram shows its source and says what is wrong; a failed chunk
  load offers Retry. Copying a selection inside a diagram copies its source.

## Non-goals

KaTeX or other math in labels, icon packs, clickable diagram links, zoom and
pan, an Expand dialog, retrying every failed block from one Retry,
`PullRequestsMarkdown`, server-side rendering (there is no production Node
runtime, and a Rust renderer would need the client's fonts), editing diagrams,
and a setting to turn diagrams off. Expand and the retry fan-out are not in the
issue's acceptance criteria. Each is a follow-up once the first slice proves
out.

## Alternatives

**A. mermaid.js, lazily loaded.** Full Mermaid fidelity and its own
`securityLevel: 'strict'` sanitization. Rejected: about 3.4 times the first
diagram's JavaScript (201 KB against 60 KB gzip), 6-82 ms per render on the main
thread with a live DOM for measurement, so a scroll through old turns stalls the
way #103 did; colors are baked into the SVG, so every theme switch re-renders
and the cache must key on theme. It was not checked under the production CSP.

**B. Pele on the main thread through the #103 queue.** Synchronous, small,
theme by CSS variables, one diagram per macrotask beside Shiki jobs. Cost: a
pathological diagram holds the main thread for its whole render, bounded only by
the limits below.

**C. Pele in a terminable worker.** `render()` works there
(`OffscreenCanvas`), the CSP allows workers, and a timeout can kill a runaway
render. Costs: the worker must load the app's web font into its own
`FontFaceSet` or its measurements disagree with the page; worker start and
chunk load add tens of milliseconds to the first diagram; DOMPurify needs a DOM,
so sanitizing stays on the main thread anyway; and the pool, timeout, respawn
and message protocol are new lifecycle code. It protects only against inputs
the limits already bound.

**D. A sandboxed iframe per diagram.** Strongest script isolation. Rejected:
one document and JavaScript realm per diagram, height known only by
`postMessage` (a guaranteed jump), theme by messages, selection and copy and
find-in-thread (#175) cannot cross the frame, it runs on the same thread in
WebKit, and Tauri's policy has no `frame-src`, so `default-src 'self'` governs
it and would need review.

**B': `mount()` instead of `render()`.** Upstream uses `mount()` with a
`sanitize` hook. Rejected for BiBCode: up to three renders on first draw,
re-renders from a ResizeObserver outside the queue, output not cacheable across
the timeline's frequent remounts, and two breaking `mount()` changes in its
first sixteen releases.

## Decision

**B with `render()`, keeping C's seam.** All Pele and DOMPurify use sits behind
one lazily imported module, `renderMermaidDiagram(source, fonts)`, which returns
`{ svg, width, height }` or throws. A worker can replace its body later without
touching the UI. C is the follow-up if the 500-edge fixture, which `limit`
does not bound, takes over 50 ms, or if profiler stalls are traced to
diagrams.

What this trades away: one diagram's render cannot be interrupted, so the limits
are the guard; diagrams keep their authored direction and scale down in narrow
panes instead of re-laying out; Mermaid themes are ignored.

## Answers to the issue's questions

- **Size limits.** `limit: 50_000` characters and `maxEdges: 500`, which match
  mermaid.js's own `maxTextSize` and `maxEdges` defaults
  ([config](https://mermaid.js.org/config/schema-docs/config.html)), so a
  diagram mermaid.js would refuse is refused here too. `outputLimit: 1_000_000`
  characters, a quarter of Pele's default, caps the DOM a single block can add.
  The source length is checked before any chunk loads. Gate: worst-case
  fixtures at these limits (a 500-edge flowchart, a 50,000-character sequence
  diagram, deep subgraph nesting) must render and sanitize in 50 ms or less on
  the reference machine, recorded in the PR; if not, lower `limit` (not
  `maxEdges`) until they do.
- **Theme directives.** Not honored. BiBCode passes no `config`, and Pele cannot
  apply `theme` or `themeVariables`; the app's light and dark tokens always win,
  so a diagram never clashes with the surface. Other `%%{init}%%` keys that Pele
  supports (for example `flowchart.curve`) still apply. `style` and `classDef`
  colors are honored, as on GitHub, and do not follow the theme.
- **`autoDirection`.** `false`, with no `maxWidth`. The diagram keeps the
  direction its author wrote, its output does not depend on the container, it
  is computed once per source and font, and resizing a panel never re-renders
  or changes heights in the virtualized timeline. Narrow panes scale the SVG to
  fit. Revisit with Expand or two width buckets if narrow-pane readability
  becomes a complaint.
- **`eval` / `new Function`.** Not used (above). No CSP change.
- **Sanitizer.** A dedicated allowlist DOMPurify instance, below. Pele itself
  also runs with `links: false` and `images: false`, and with no `icons` or
  `math`.

## Rendering path

1. **Gate.** In the `pre` override, a block whose language is exactly `mermaid`
   goes to `MarkdownMermaidBlock` only if
   `isClosedMermaidFence(text, node.position, body, isStreaming)` holds;
   otherwise it stays on today's code-block path, streaming included. The gate
   does not reimplement CommonMark. It reads what the parser has already
   decided. Let `slice` be `text.slice(start.offset, end.offset)` and `body`
   the code element's text without the one `\n` that mdast-util-to-hast
   appends. Line endings are `\r\n`, `\r` or `\n`. The fence is closed when all
   of these hold:
   - `slice` starts with a run of three or more backticks or tildes. A
     raw-HTML `<pre><code class="language-mermaid">` does not, so it stays
     source.
   - `body` is not blank.
   - `slice` does not end with a line ending. An unclosed fence at the end of
     the text includes its trailing line endings, and a closed one ends at its
     closing run. A fence ended by its container fails the next rule instead.
   - `slice` holds exactly one more line ending than `body` holds lines: one
     for the opening line and one for each content line. The closing line is
     the extra line the parser kept out of `body`. When the parser treats an
     apparent closer as content, that line is in `body` and the counts differ.
     Examples are a run indented four spaces, `> ```` inside a top-level
     fence, a run followed by an info string, and a run shorter than the
     opener.
   - While streaming, `text.slice(end.offset)` starts with a line ending. A
     closing run at the very end of the text could still grow into content
     (` ```x `), so it does not render yet.

   A missing position counts as not closed. A fence ended by its container
   instead of a closing run stays source, for example a blockquote or list
   item that ends first. So does a fence that a preview cut open.

2. **Source.** `body` with line endings normalized to `\n`. Over 50,000
   characters, the block shows the error without loading anything.
3. **Cache.** A module-level LRU (100 entries, 16 MB), keyed by the font key
   and the full source (`fontKey + "\0" + source`). Each entry is sized as
   `(key.length + svg.length) * 2`. No hash is involved, so two sources never
   share an entry. An entry holds `{ svg, width, height, idPrefix }` or a
   diagram error. The block reads the cache during render, so a cached
   remount, a theme switch or a second surface showing the same diagram draws
   in the same commit. Diagram errors are cached too, so an invalid diagram is
   parsed once. An evicted diagram is drawn again like a cold one, under the
   same no-jump handling (UI behavior).
4. **Load.** On a miss, the block's effect runs one attempt for its key. The
   effect depends on the key, so a source or font change, or an unmount, runs
   the cleanup, which cancels the attempt. The attempt awaits, in order:
   - one shared promise for the renderer module (`import("./mermaidRenderer")`);
   - Pele's `load(detectType(source))` for the diagram type's chunk;
   - `document.fonts.ready`, while fonts are loading.

   After every await, the attempt stops if it was cancelled. It joins or
   schedules a job only after the last await. A rejected module or chunk
   promise is cleared so Retry can try again.

5. **Fonts.** `fontFamily` and `fontSize` come from the computed style of the
   ChatMarkdown root and `fontFamilyMono` from the fallback `<pre>`, read once in
   the first miss's effect and reused; they form the font key. No `--pele-font`
   is set in CSS, so Pele draws in the family it measured.
6. **Job.** One queue job runs `render(source, options)` and sanitizes its
   `svg`, in the same macrotask. Options: `limit`, `maxEdges`, `outputLimit` as
   above, `autoDirection: false`, `links: false`, `images: false`,
   `responsive: true` and `idPrefix: "bibcode-mmd-<n>"`. Here `n` is a
   module-level counter assigned when the job is created. Distinct sources
   never share ids, and every block showing one cached entry shares that
   entry's identical definitions.
7. **Publish.** The job's `done` callback writes the cache, then notifies the
   job's current subscribers. Each subscriber stores `{ key, result }` in
   state. Render uses the result only when `key` equals the block's current
   key, the pattern at `ChatMarkdown.tsx:814`, so a late result for source A
   never shows in a block that now holds source B.
8. **Insert.** The sanitized string goes in through `dangerouslySetInnerHTML`
   inside `.chat-markdown-mermaid`, the same HTML-body context DOMPurify parsed
   it in, so no context change re-parses it differently.

The queue moves to `apps/web/src/components/markdown/renderQueue.ts` and gains
a type parameter and a failure callback (`schedule<T>(run, done, fail)`), so
Shiki keeps its behavior and diagrams receive their errors. Pending diagram
jobs live in a map keyed by the same full key as the cache. A block can
therefore join only a job for its exact source and fonts. Each job keeps a
subscriber count, and a job that has not run is cancelled only when its last
subscriber leaves. A job that has already run is not cancelled: it writes the
cache, because its result is valid for its own source.

## Trust boundary: diagram SVG

Inputs are untrusted: agent output, pasted user text, plan text and workspace
Markdown files. The sanitized SVG is the only Pele output that reaches the DOM,
and Pele error text is shown only as React text. DOMPurify does not parse CSS,
so the boundary is an allowlist at three levels: elements, attributes, and CSS
declarations and value forms. A blocklist of dangerous spellings would not
hold. `image-set("/x" 1x)` loads a URL without the text `url(`, and
`u\72l(/x)` is `url(` after CSS unescaping.

```ts
const TAGS = [
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "defs",
  "lineargradient",
  "stop",
];
const ATTRS = [
  /* geometry, presentation and ARIA attributes Pele emits, e.g.
  viewbox, width, height, x, y, cx, cy, r, rx, ry, d, points, transform, fill,
  stroke, stroke-*, opacity, font-*, text-anchor, text-decoration, role,
  aria-*, id, class, style, offset, stop-color, gradientunits, xml:space */
];

const purifier = DOMPurify(window);
purifier.addHook("uponSanitizeAttribute", (_node, data) => {
  const v = cleanAttribute(data.attrName, data.attrValue); // below
  if (v === null) data.keepAttr = false;
  else data.attrValue = v;
});

export function sanitizeDiagramSvg(svg: string): string {
  return purifier.sanitize(svg, {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRS,
    ALLOW_DATA_ATTR: false,
  });
}
```

`cleanAttribute` applies these rules:

- **Safe CSS value.** A value is safe when it contains no `\`, `/*`, `@`, `<`,
  `>`, `{`, `}` or `;`. Every quoted string in it must match `"[^"';:]*"` or
  `'[^"';:]*'`. Every `(` must directly follow one of the function names
  `var`, `rgb`, `rgba`, `hsl` or `hsla`, and a `var(` must start with a `--`
  custom property name. Backslashes are never allowed, so escapes cannot
  rename a function. Allowlisted functions cannot carry a URL.
- **`style`.** The value is split on `;`. This is safe because quoted strings
  cannot contain `;`. A declaration is kept only when its property is in the
  allowlist and its value is safe. The allowlist is the root-style and
  shape-style properties listed under Pele above, plus custom properties
  matching `--_[a-z]{1,2}`. A kept `fill` or `stroke` may instead be exactly
  `url(#<id>)`, a same-document reference. The attribute is rebuilt from the
  kept declarations and dropped if none remain.
- **CSS-valued presentation attributes** (`fill`, `stroke`, `stroke-*`,
  `opacity`, `color`, `stop-color`, `font-*`, `text-decoration`,
  `baseline-shift`) must hold a safe value. `fill` and `stroke` may instead
  be exactly `url(#<id>)`.
- **`class`** keeps only `pele` and `pele-*` tokens. Pele applies `classDef`
  colors inline, so a user's class names only let app CSS (Tailwind
  utilities) reach diagram nodes, and dropping them changes nothing visible.

Why this holds:

- A dedicated instance keeps the hook from affecting any other DOMPurify user.
- The tag allowlist leaves out `a`, `image`, `style`, `foreignObject`, `use`
  and every animation element by construction, and the attribute allowlist
  leaves out `href`, `xlink:href`, `src`, `srcset`, `on*`, `clip-path`, `mask`,
  `filter`, `marker-*` and `cursor`. A `<style>` element in inline SVG would
  restyle the whole app, which is why element styles go and checked attribute
  styles stay.
- The starting lists are what Pele 1.3.0 and 1.9.0 emit. The corpus test (Test
  plan, item 3) fixes them for the pinned version. An upgrade that emits
  anything new fails the test instead of silently losing output or widening
  the boundary.
- DOMPurify's DOM-clobbering check still removes ids that shadow document
  properties.
- The host element sets `contain: content` and `overflow: hidden`, so nothing
  inside paints over app UI.
- The CSP is the last layer for script (`script-src 'self'`). It does not stop
  same-origin image GETs, which is why the value rules above carry the
  resource boundary.
- Diagram source and Pele messages are never logged; a renderer failure logs
  only `{ operation: "render-diagram", code }` through
  `reportMarkdownActionFailure`.

## Failure, cancellation and concurrency

- **Parse, semantic, unsupported and limit errors** are cached per source and
  shown in the block (UI below). Any other throw from Pele or DOMPurify is shown
  as "Couldn't draw this diagram." and logged without source.
- **Chunk-load failure** shows Retry, which re-runs this block's attempt. The
  module and chunk promises are shared and cleared on failure, so a success
  also serves every later attempt. Other blocks that already show Retry keep
  it until they are clicked or remounted. In browser mode after a server
  upgrade, old chunk names can 404 until the page reloads, and Retry then
  fails again with the same message.
- **Source replacement.** Final text and snapshots can replace a fence's
  source A with B while A is still loading (Current behavior). The effect
  cleanup cancels A's attempt, which stops at its next await, and removes
  A's subscription. A's job is cancelled if nobody else waits on it. B starts
  its own attempt. A result for A that arrives later fails the key check at
  publication. Duplicate delivery of the same text changes no key and does
  nothing.
- **Unmount** cancels the attempt at whatever await it has reached. Before the
  job runs, it also unsubscribes, which cancels the job when no other block
  waits on it. A remount in the same commit resubscribes first.
- **No shared mutable state** beyond the cache, the job map, the module promise
  and the id counter, all on the main thread.

## Performance

- Non-Mermaid fences pay one string comparison. The gate's slice and line
  counts and the cache key are linear in the fence's own length, per render.
- Pele and DOMPurify load on the first closed Mermaid fence only. Budget: the
  JavaScript fetched for the first flowchart (renderer module, Pele core, its
  chunk and DOMPurify) at most 80 KB gzip, measured from the build output; the
  main entry's size is unchanged.
- One render plus sanitize per distinct source per session while it stays
  cached, inside the #103 queue; remounts, theme switches and second surfaces
  hit the cache.
- Stable overrides (Composition with #172) replace a remount of every override
  on each delta with a re-render of the context consumers.

## UI behavior (UI.md)

- **Same chrome.** The diagram sits in the existing code-block card: the header
  keeps the language title, Copy (the source) and gains **Show source** /
  **Show diagram** (a pressed toggle; Wrap appears only with the source). The
  diagram is centered at its natural size, scaled down to the column width,
  never up. Clicking it does nothing. Text inside it stays selectable.
- **Pending.** The highlighted source shows until the diagram is ready, usually
  within a frame; no spinner, since the source is already the content.
- **Errors**, one `text-xs` line in `text-destructive-foreground` above the
  source, which stays visible: "Can't draw this diagram: line 3, Expected ']'."
  (from `PeleError` line and message); "Diagram type not supported."; "Too large
  to draw: over 500 edges." or "over 50,000 characters."; "Couldn't load the
  diagram renderer." with a **Retry** button. Show diagram is absent when there
  is no diagram.
- **Copy.** The diagram wrapper carries `data-markdown-copy` (the fenced
  source, fence length from `codeFenceFor`) and `data-markdown-atomic`.
  `chatMarkdownClipboardPayload` maps a range that lies inside an atomic element
  to that element's copy text, and its HTML flavor to an escaped
  `<pre><code class="language-mermaid">`. File chips, which have no atomic
  marker, keep today's behavior.
- **Theme.** `.chat-markdown-mermaid` maps `--pele-bg` to `--background`,
  `--pele-fg` to `--foreground`, `--pele-muted` to `--muted-foreground`,
  `--pele-surface`, `--pele-surface-alt`, `--pele-border` and `--pele-line` to
  opaque `color-mix` steps of `--foreground` into `--background` (translucent
  tokens would stack where shapes overlap), `--pele-accent` to `--info`,
  `--pele-critical` and `--pele-error` to `--destructive`, and `--pele-radius`
  to the card radius. Series colors keep Pele's palette.
- **No jump in the timeline.** A swap between source and diagram moves the
  height of everything below it. That covers first draws, redraws after cache
  eviction, Show source and Show diagram. Two cases are above the line the
  user reads, and each has its own mechanism:
  - _The diagram's row is wholly above the first visible row._ LegendList
    re-measures and repositions the absolutely positioned rows, so only the
    list can correct the scroll in the same update. The timeline sets
    `maintainVisibleContentPosition.size: true`, the library default.
  - _The diagram is inside the first visible row, above the viewport's top
    edge_ (a long reply scrolled past its diagram). LegendList keeps that
    row's top in place, so content below the diagram in the same row would
    still move. MessagesTimeline provides a reading-anchor context with
    `preserveReadingPosition(element, commit)`. It records the element's
    bottom edge, commits the swap with `flushSync`, measures again, and
    scrolls by the delta with `scrollToOffset({ animated: false })`. This is
    the existing `onToggleWorkGroup` pattern. It acts only when the pure
    helper `isAboveReadingLine` in `timelineScrollAnchoring.ts` reports that
    the element starts above the visible top inside the first visible row. It
    does nothing while the list follows the end, where `maintainScrollAtEnd`
    already holds the newest line.

  Outside the timeline, the context is absent and the block commits normally.
  A swap below the reading line moves only content below it, like any content
  that grows in view.

- **Other surfaces.** The file view and the Plan sidebar are ordinary scroll
  containers and rely on browser scroll anchoring. It is present in Chromium,
  WebView2, and WebKit from Safari 27. Older WebKit, which may include the
  Linux build's WebKitGTK, shifts once when a diagram above the reading
  position draws. Criterion 6 names the timeline, so this is recorded as a
  known limitation.
- **Proposed Plan preview.** A closed diagram draws inside the clipped
  `max-h-104` preview under the existing fade; a fence the preview cut open
  stays source.
- **Not added:** Expand, a setting to turn diagrams off (Show source covers
  it), zoom gestures that would capture wheel scrolling in the timeline, and
  clickable diagram links.

## Composition with #172

- Both changes need every ChatMarkdown override to keep one identity for the
  life of the page. Today every delta and theme switch remounts every override
  (Current behavior), which would reset Show source mid-stream. Moving only
  `text`, `isStreaming` and the theme out of the `useMemo` would not be enough,
  because both link maps change with `text`. The fix defines the overrides at
  module scope, and `components` becomes a module constant. Each override
  reads, through one `ChatMarkdownRenderContext`, every value the `useMemo`
  depends on today: text, streaming flag, both themes, both link maps,
  environment, thread, skills and the handlers. A context change re-renders
  consumers without remounting them. Whichever PR lands first does it; this
  one depends on it.
- The gate needs `node.position` offsets into the full message text. #172's
  prefix reuse must keep reused and re-parsed node positions absolute; a shared
  test asserts the gate gives the same answer under full and incremental parses.
- An unclosed Mermaid fence is an ordinary streaming code block, so #172's
  incremental highlighting applies to it unchanged. The Mermaid branch is the
  first check in the `pre` override and touches nothing else there.
- Both PRs touch the queue: this one extracts it to `renderQueue.ts` unchanged
  in behavior; the other rebases onto the extracted module.

## Protocol, schema and persistence

None. No contract, RPC, server, setting or stored state changes; the cache is
in memory and per page.

## Profiler coverage

None applies (client-only). No child process, RPC method, worktree removal,
binary mode, service or profiler event is added. The client collector records
only stall and interaction durations (`apps/web/src/profiler/clientCollector.ts:265-280`),
so a slow diagram shows as a `client.interaction` or stall number, and diagram
source never reaches a profiler record or log.

## Files to change

- `apps/web/package.json`, `pnpm-lock.yaml`: exact pins of `pele` and
  `dompurify` (versions below).
- New in `apps/web/src/components/markdown/`: `renderQueue.ts` (moved from
  `ChatMarkdown.tsx:722-766`), `mermaidFence.ts` (the gate), `mermaidRenderer.ts`
  (lazy: Pele and the sanitizer), `MarkdownMermaidBlock.tsx` (cache, attempts,
  jobs, UI).
- `apps/web/src/components/ChatMarkdown.tsx`: the `pre` branch, the queue
  import, and the module-scope overrides with their context unless #172 has
  landed them.
- `apps/web/src/markdown-clipboard.ts`: atomic copy for ranges inside a diagram.
- `apps/web/src/index.css`: `.chat-markdown-mermaid` tokens, containment and SVG
  sizing.
- `apps/web/src/components/chat/MessagesTimeline.tsx`: `size: true` at
  `:538-541` and the reading-anchor context provider.
  `apps/web/src/components/chat/timelineScrollAnchoring.ts`:
  `isAboveReadingLine`.
- Tests listed below; `apps/web/visual/typography/` fixtures and
  `required-coverage.json` entries; `apps/desktop/e2e/specs/mermaid-diagrams.e2e.ts`.
- Living docs: a "Chat markdown rendering" section in
  `docs/architecture/overview.md`, shared with #172, with the render policy and
  this SVG trust boundary; a paragraph under Center Panel in
  `docs/user/workspace-ui.md`; a diagram check in Packaged visual validation in
  `docs/testing/cross-platform-validation.md`.

## Test plan

Items 1-4, 8 and 9 fail on 4e023ac5ff first; 5 lands with whichever of this and
#172 merges second; 6 is a regression guard and 7 a capture.

1. `mermaidFence.test.ts`, on the real parser pipeline so the gate and the
   parser cannot drift. Closed: backtick and tilde fences, a longer closing
   run, a closer with trailing spaces, three-space indentation, a blockquote, a
   list item, a tab-indented list item, a blockquote inside a list, CRLF, lone
   CR, and blank first and last body lines. Source:
   - a closer indented four spaces;
   - `> ```` as content of a top-level fence;
   - a closer followed by an info string;
   - a run shorter than the opener;
   - an unclosed fence at the end of text, with and without a trailing
     newline and with a trailing blank line;
   - fences ended by their container (a blockquote, and a list item with an
     unindented closer);
   - raw-HTML `language-mermaid`;
   - an empty body and a blank body;
   - a missing position.

   Streaming: a closer at the very end of the text is open, a closer with
   trailing spaces at the end is open, and a closer followed by `\r` or `\n`
   is closed.

2. `ChatMarkdown.mermaid.test.tsx` (happy-dom, real Pele, which falls back to
   its width table). Drawing:
   - nothing renders, and the renderer is not imported, before the fence
     closes;
   - appending the closing fence and a newline draws an `svg` after the
     queue runs;
   - tilde, list, blockquote and CRLF fences draw;
   - raw-HTML `language-mermaid` stays source;
   - an invalid diagram shows source and the line-numbered error;
   - a 50,001-character source shows "Too large" without importing the
     renderer;
   - a rejected renderer import shows Retry, and Retry draws;
   - a cached remount draws in the same render with no timer flush.

   Stability:
   - a theme switch calls `render` zero times and the diagram stays in the
     DOM;
   - Show source stays pressed across text appended after the fence and a
     theme switch;
   - two blocks with one source render once;
   - a Proposed Plan preview cut inside a fence stays source.

   Lifecycle:
   - replacing source A with B during the module load renders A zero times
     and shows only B;
   - unmounting during the module load or the font wait schedules no job and
     sets no state;
   - unmounting one of two blocks that share a pending job still draws the
     other;
   - the collision pair above, in two blocks, renders twice and each block
     shows its own diagram, both while pending and from the cache;
   - after 100 other entries evict a diagram, its remount draws again
     through the queue.

3. `mermaidSanitizer.test.ts`, on hand-written SVG so the boundary holds without
   Pele. Removed:
   - `<a href="javascript:…">`, keeping its text;
   - `onclick`, `<script>`, `<foreignObject><div>`, `<style>`, `<image href>`,
     `<use href>`, `<animate>` and `<set>`;
   - `xlink:href`, `src`, `srcset`, `filter`, `mask` and `clip-path`.

   Dropped CSS:
   - `style="fill:url(https://x)"`;
   - `style="background-image:image-set(&quot;/mermaid-probe/a&quot; 1x)"`;
   - `style="fill:u\72l(/mermaid-probe/b)"` and `fill="u\72l(/mermaid-probe/c)"`;
   - `style="--_fg:url(/mermaid-probe/d)"`;
   - `style="fill:var(--x,url(/mermaid-probe/e))"`;
   - `style="font-family:&quot;a;b&quot;"`;
   - a `background-image` declaration with a safe value.

   `class="pele-node hidden"` becomes `pele-node`. Kept: Pele's root style
   unchanged, `fill="url(#g)"`, `fill:rgb(1,2,3)`,
   `style="--_fg:var(--pele-fg)"`, `role`, `<title>`, and `aria-*`.

   Through Pele:
   - `click A "javascript:alert(1)"`, `click A call fn()`, `click A href
     "https://x"`, an image node and a `classDef` with `url(` yield no `a`,
     `image` or `url(` with a scheme;
   - corpus: rendering every gallery and test fixture with the pinned Pele,
     DOMPurify's `removed` list is empty.

4. `markdown-clipboard.test.ts`: a selection inside a diagram copies the fenced
   source; one spanning a paragraph and a diagram copies both; the HTML flavor
   is an escaped code block; a selection inside a file chip is unchanged.
5. #172 composition: the gate's result for every fence is the same under the
   full and incremental parsers (added by whichever PR lands second).
6. Guard `pele-no-eval.test.ts`: the installed `pele/dist/**/*.js` and
   DOMPurify's ES build contain no `eval(` or `new Function`.
7. Typography gallery fixtures, captured light and dark in Chromium and Linux
   WebKit. `chat-markdown-mermaid` holds a flowchart, a sequence diagram, an
   invalid diagram and the Retry state. `mermaid-sanitizer-probe` inserts the
   hostile SVG strings of item 3 through `sanitizeDiagramSvg`. The capture
   fails if the gallery server receives any request under `/mermaid-probe/`.
8. `mermaid-diagrams.e2e.ts` in the packaged desktop app (production CSP).
   A fixture Markdown file in the Files rendered view:
   - draws a valid diagram;
   - shows an invalid one's error;
   - renders a hostile one with no `a`, `image`, `foreignObject` or `style`
     under `.chat-markdown-mermaid`;
   - leaves `performance.getEntriesByType("resource")` with no
     `/mermaid-probe/` entry (same-origin images raise no CSP event);
   - fires no `securitypolicyviolation` event;
   - changes a node's computed fill on a theme toggle with no fallback frame.

   A fixture-provider reply with diagrams checks the timeline. A reading
   anchor line stays within 1 px when a diagram first draws:
   - in a row wholly above the viewport;
   - inside the first visible row above the top edge;
   - after a reply with 101 small diagrams has evicted the first one, which
     is then remounted.

   Streaming at the end still follows, the sent-row anchor (`anchoredEndSpace`)
   still positions, and minimap navigation still lands.

9. `timelineScrollAnchoring.test.ts`: `isAboveReadingLine` is true only for an
   element that starts above the visible top inside the first visible row. It
   is false for a row wholly above the viewport (left to `size: true`), for an
   element in view, and while the list follows the end.

## Verification

- `vp check`, `vp run typecheck`, the focused web tests above, and
  `vp run test` for `apps/web` and `scripts` (the identity, toolchain and
  hardening tests must pass unchanged).
- Production CSP in Tauri: item 8 on macOS, Windows and Linux. Browser mode: the
  same fixture served by a release `bibcode` server in Chromium and Safari, with
  the console free of CSP violations and no `/mermaid-probe/` request in the
  server log.
- No jump is a merge gate, not a known limitation. The timeline scenarios in
  item 8 must pass on all three platforms. If `size: true` regresses streaming
  follow, the sent-row anchor or minimap navigation, the PR fixes that in
  MessagesTimeline before it merges. One option is to keep `size: false` and
  compensate rows above the first visible row from LegendList's
  `onItemSizeChanged`, in the same update that repositions them.
- Measurements, in the PR and not in living docs: first-diagram gzip bytes,
  worst-case render and sanitize times at the limits, and a 14-diagram reply's
  time to last diagram.
- The bundled DOMPurify keeps its `@license` banner.
- Reviews: UI.md and `vercel-react-best-practices` for the block, the stable
  overrides, the reading-anchor context and the copy path; testing runbooks
  reviewed (Packaged visual validation changes).

## Rollout

- Pins: the newest `pele` release at least 14 days old when the PR merges
  (1.3.0 today; 1.8.0 from 2026-11-03 and 1.9.0 from 2026-11-05), and
  `dompurify` 3.4.17 from 2026-10-26 (3.4.16 today). Every API used here
  (`render`, `detectType`, `load`, `PeleError` codes, `links`, `images`,
  `autoDirection`, the limits) exists since 1.3.0. No `minimumReleaseAgeExclude`
  is needed or allowed.
- Upgrades re-run items 2, 3 (including the corpus test), 6 and 8. Pele's minor
  releases have broken APIs.
- No flag: the change is client-only, and an old client keeps showing source.

## Risks

- Pele is under three weeks old and changes every few days; a later release
  could change output that the sanitizer must accept, such as moving theming
  out of the root `style`. The exact pin, the corpus test and item 8 catch it.
- One render cannot be interrupted; the limits and the 50 ms gate bound it, and
  C is the fallback.
- `size: true` changes timeline-wide anchoring, which BiBCode has kept off
  since the migration without a recorded reason. It also touches the file #176
  edits. The item 8 scenarios gate it, and the Verification fallback avoids
  it.
- The first-visible-row compensation measures with `flushSync` from a queue
  callback. It shares the `onToggleWorkGroup` pattern, and a regression shows
  up as a one-row shift in item 8.
- Two copies of the same sankey diagram share one cache entry's gradient ids;
  if the first is inside a hidden subtree, the second may lose its gradient.
- `classDef` colors chosen for a light background can read poorly in dark
  mode, as on GitHub.
- Wide diagrams scaled into a narrow pane can be hard to read until Expand
  ships.
- happy-dom may not match browsers in DOMPurify parsing; items 7 and 8 run the
  sanitizer in real engines.
- Canvas text measurement differs slightly between WebKitGTK, WebKit and
  WebView2, so labels can sit tighter on one engine; the Linux WebKit capture in
  item 7 shows it.

## Review

Codex critique, 2026-10-24. Each finding was checked against the code before
it was accepted.

1. **The fence gate disagrees with the parser. Accepted.** A probe of the
   installed pipeline confirmed that a closed fence's `end.offset` excludes
   the line ending, so the old streaming check could never pass. It also
   showed that stripping indentation and `>` treats code lines as closers
   (four-space and `> ```` cases). The gate now reads the parser's decision
   instead of reimplementing CommonMark: line counts of the slice against the
   body, plus a line ending after `end.offset` while streaming. Test item 1
   lists the closures and the apparent closures.
2. **Overrides still remount on text change. Accepted.** Both link maps are
   rebuilt from `text` (`ChatMarkdown.tsx:1380-1398`) and remain
   dependencies (`:1663`, `:1665`). Overrides now live at module scope and
   read every changing value through one context. Item 2 tests Show source
   across appended text and a theme switch. Expand left this slice (point 7),
   so its test is not needed.
3. **The sanitizer is a blocklist with gaps. Accepted.** The `url(` regex
   matches neither `image-set("/x" 1x)` nor `u\72l(`. Both are CSS URL forms,
   and same-origin images pass the CSP. The boundary is now an allowlist of
   elements, attributes, style properties, CSS function names and value
   characters, derived from Pele's bundles and fixed by a corpus test. Items
   3, 7 and 8 assert the bypasses and the absence of probe requests in real
   engines.
4. **Source replacement and async cancellation are underspecified.
   Accepted.** The reducer replaces streamed text with final text
   (`threadReducer.ts:271-275`), and snapshots replace the thread
   (`threads.ts:166-168`). The "same text" premise is gone. Each load is a
   cancellable attempt checked after every await and before it schedules a
   job, and results are published only when their key matches. Item 2 covers
   A-to-B replacement, unmount mid-load and a shared job with a remaining
   subscriber.
5. **Pending-job dedupe loses collision protection. Accepted.** The pair
   reproduces with the repo's `fnv1a32` (both length 28, hash 2311057632).
   The cache and the job map are now keyed by the full source and font key,
   so no hash is used. Ids use a counter, and the pair is a regression test.
   The existing Shiki cache keys the same way. That is outside this change and
   noted under Current behavior.
6. **No-jump can fail criterion 6. Accepted, and extended.** The
   documented-shift fallback is removed, and no-jump is a merge gate.
   LegendList keeps the first visible row's top in place, so `size: true`
   alone cannot hold content below a diagram inside that row. That row gets
   local compensation through the existing `onToggleWorkGroup` pattern, and
   rows wholly above keep the library's anchoring. Cold draws and redraws
   after eviction take the same path, and items 8 and 9 test both. The file
   view and Plan sidebar claim was corrected: WebKit before Safari 27 has no
   scroll anchoring.
7. **Simpler alternative. Adopted.** Expand and the retry fan-out are
   deferred, since neither is in the acceptance criteria. Retry is local to
   the block, but the shared promises mean one success serves later attempts.
   The sanitizer allowlist and the no-jump gate stay hard requirements, as the
   critique asked.
