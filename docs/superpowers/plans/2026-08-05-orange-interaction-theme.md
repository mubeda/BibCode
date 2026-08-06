# Orange Interaction Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace BiBCode's blue interaction/selection accent with the marketing site's exact vintage orange (`#d8610e`) in both themes while keeping informational, link, provider, syntax, diff, terminal, success, warning, and error colors semantically distinct.

**Architecture:** Keep the change token-driven: define the shared primary/ring/foreground values once in `index.css`, add an explicit blue link token, and migrate only the small number of interactive selections or links that bypass the semantic tokens. Guard the boundary with source-level token tests and representative component tests instead of performing a blanket blue replacement.

**Tech Stack:** CSS custom properties, Tailwind CSS v4 theme mappings, React 19, TypeScript, Vite+ tests.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-05-orange-interaction-theme-and-terminal-drawer-retirement-design.md`.
- Use exact `#d8610e` for `--primary` and `--ring` in both light and dark themes.
- Use white for `--primary-foreground` in both themes, including solid selected controls.
- Keep `--info`, links, provider accents, file colors, syntax, diffs, terminal ANSI colors, success, warning, and destructive colors out of the primary token.
- Change hard-coded blue only when it represents interaction, selection, or focus.
- Preserve accessible names, `aria-selected`/`data-state` attributes, checks, borders, and focus rings so selected state is not conveyed by color alone.
- Do not edit `.repos/` or add dependencies.
- Use test-driven development for each behavior change.
- `vp check` and `vp run typecheck` must pass before completion.

---

## File Responsibility Map

- `apps/web/src/index.css` — canonical light/dark primary, ring, link, and information token definitions plus link consumers.
- Create `apps/web/src/themeTokens.test.ts` — exact theme-token regression and semantic-blue boundary test.
- `apps/web/src/browser/annotationTheme.ts` — desktop preview annotation fallback primary/ring values when computed CSS is unavailable.
- Create `apps/web/src/browser/annotationTheme.test.ts` — preview fallback and live-token propagation regression.
- `apps/web/src/components/ui/empty.tsx` — empty-state anchor styling must use the link semantic rather than primary.
- Create `apps/web/src/components/ui/empty.test.tsx` — representative link semantic regression.
- `apps/web/src/components/chat/ModelListRow.tsx` — selected model check is an interaction state and must use primary.
- `apps/web/src/components/chat/ModelListRow.test.tsx` — selected/unselected visual-state and accessibility assertions.
- `apps/web/src/components/chat/McpStatusPopover.tsx`, `apps/web/src/components/chat/ComposerPreviewAnnotationCards.tsx`, `apps/web/src/components/settings/ResourceDiagnosticsSections.tsx` — audit-only semantic-blue sentinels; do not recolor them.

---

### Task 1: Lock the Shared Orange and Blue Semantic Tokens

**Files:**

- Create: `apps/web/src/themeTokens.test.ts`
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/src/browser/annotationTheme.ts`
- Create: `apps/web/src/browser/annotationTheme.test.ts`

**Interfaces:**

- Produces: `--primary: #d8610e` in `:root` and `.dark`.
- Produces: `--ring: #d8610e` in `:root` and `.dark`.
- Produces: `--primary-foreground: var(--color-white)` in `:root` and `.dark`.
- Produces: `--link` plus Tailwind mapping `--color-link: var(--link)`.
- Preserves: existing blue `--info` and `--info-foreground` definitions.
- Produces: preview annotation fallbacks `primary: #d8610e` and `ring: #d8610e`.

- [ ] **Step 1: Write the failing exact-token regression**

Create `apps/web/src/themeTokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const css = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");
const button = readFileSync(
  fileURLToPath(new URL("./components/ui/button.tsx", import.meta.url)),
  "utf8",
);
const switchControl = readFileSync(
  fileURLToPath(new URL("./components/ui/switch.tsx", import.meta.url)),
  "utf8",
);
const checkbox = readFileSync(
  fileURLToPath(new URL("./components/ui/checkbox.tsx", import.meta.url)),
  "utf8",
);
const splitWorkspace = readFileSync(
  fileURLToPath(new URL("./components/CenterPanelWorkspace.tsx", import.meta.url)),
  "utf8",
);

function occurrences(value: string): number {
  return css.split(value).length - 1;
}

describe("application theme tokens", () => {
  it("uses the approved orange and white foreground in both themes", () => {
    expect(occurrences("--primary: #d8610e;")).toBe(2);
    expect(occurrences("--ring: #d8610e;")).toBe(2);
    expect(occurrences("--primary-foreground: var(--color-white);")).toBe(2);
  });

  it("keeps links and information on explicit blue semantics", () => {
    expect(css).toContain("--color-link: var(--link);");
    expect(css).toContain("--link: var(--color-blue-700);");
    expect(css).toContain("--link: var(--color-blue-400);");
    expect(css).toContain("--info: var(--color-blue-500);");
    expect(css).toContain("--info-foreground: var(--color-blue-700);");
    expect(css).toContain("--info-foreground: var(--color-blue-400);");
  });

  it("routes representative controls and drag targets through interaction tokens", () => {
    expect(button).toContain("bg-primary text-primary-foreground");
    expect(button).toContain("focus-visible:ring-ring");
    expect(switchControl).toContain("data-checked:bg-primary");
    expect(switchControl).toContain("focus-visible:ring-ring");
    expect(checkbox).toContain("text-primary-foreground");
    expect(checkbox).toContain("data-checked:bg-primary");
    expect(splitWorkspace).toContain("border-primary/60 bg-primary/15 text-primary");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run:

```bash
vp test apps/web/src/themeTokens.test.ts
```

Expected: FAIL because primary/ring are still blue and no explicit link mapping exists.

- [ ] **Step 3: Define the shared tokens once per theme**

In the `@theme inline` block of `apps/web/src/index.css`, add:

```css
--color-link: var(--link);
```

In `:root`, set:

```css
--primary: #d8610e;
--primary-foreground: var(--color-white);
--ring: #d8610e;
--link: var(--color-blue-700);
```

In `.dark`, set:

```css
--primary: #d8610e;
--primary-foreground: var(--color-white);
--ring: #d8610e;
--link: var(--color-blue-400);
```

Leave the existing `--info` and `--info-foreground` declarations unchanged.

- [ ] **Step 4: Move markdown anchors to the explicit link token**

Change the chat/markdown anchor rule in `apps/web/src/index.css` from its current information/primary alias to:

```css
color: var(--link);
```

Keep hover decoration and visited behavior unchanged.

- [ ] **Step 5: Run the token test and verify green**

Add `apps/web/src/browser/annotationTheme.test.ts` with an empty-computed-style case and an explicit-token case:

```ts
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readPreviewAnnotationTheme } from "./annotationTheme";

const originalDocument = globalThis.document;
const originalGetComputedStyle = globalThis.getComputedStyle;

function installComputedStyle(values: ReadonlyMap<string, string>): void {
  globalThis.document = {
    documentElement: { classList: { contains: () => false } },
  } as unknown as Document;
  globalThis.getComputedStyle = (() => ({
    fontFamily: "system-ui",
    getPropertyValue: (name: string) => values.get(name) ?? "",
  })) as unknown as typeof getComputedStyle;
}

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }
  if (originalGetComputedStyle === undefined) {
    delete (globalThis as { getComputedStyle?: typeof getComputedStyle }).getComputedStyle;
  } else {
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});

describe("readPreviewAnnotationTheme", () => {
it("falls back to the approved interaction colors", () => {
  installComputedStyle(new Map());
  expect(readPreviewAnnotationTheme()).toMatchObject({
    primary: "#d8610e",
    primaryForeground: "white",
    ring: "#d8610e",
  });
});

it("prefers live semantic tokens over fallbacks", () => {
  installComputedStyle(new Map([
    ["--primary", "rgb(1 2 3)"],
    ["--ring", "rgb(4 5 6)"],
  ]));
  expect(readPreviewAnnotationTheme()).toMatchObject({
    primary: "rgb(1 2 3)",
    ring: "rgb(4 5 6)",
  });
});
});
```

Update the two blue fallback literals in `annotationTheme.ts` to `#d8610e`; do not change any supplied computed token.

Run:

```bash
vp test apps/web/src/themeTokens.test.ts apps/web/src/browser/annotationTheme.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the token boundary**

```bash
git add apps/web/src/index.css apps/web/src/themeTokens.test.ts apps/web/src/browser/annotationTheme.ts apps/web/src/browser/annotationTheme.test.ts
git commit -m "feat(web): adopt orange interaction tokens"
```

---

### Task 2: Keep General Links Blue Outside Markdown

**Files:**

- Modify: `apps/web/src/components/ui/empty.tsx`
- Create: `apps/web/src/components/ui/empty.test.tsx`

**Interfaces:**

- Consumes: Tailwind `text-link` backed by the explicit `--link` token.
- Preserves: the empty-state component API and anchor behavior.

- [ ] **Step 1: Add a failing empty-state link test**

Create `apps/web/src/components/ui/empty.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EmptyDescription } from "./empty";

describe("EmptyDescription", () => {
  it("uses the semantic link color instead of the interaction accent", () => {
    const markup = renderToStaticMarkup(
      <EmptyDescription>
        <a href="https://example.com/docs">Read the docs</a>
      </EmptyDescription>,
    );

    expect(markup).toContain("[&amp;&gt;a:hover]:text-link");
    expect(markup).not.toContain("[&amp;&gt;a:hover]:text-primary");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
vp test apps/web/src/components/ui/empty.test.tsx
```

Expected: FAIL because `EmptyDescription` still uses `text-primary` for anchor hover.

- [ ] **Step 3: Switch the empty-state anchor to the link semantic**

In `apps/web/src/components/ui/empty.tsx`, replace only the anchor hover utility:

```tsx
"[&>a:hover]:text-link"
```

Do not change empty-state action buttons that intentionally use `primary`.

- [ ] **Step 4: Run the focused test and commit**

```bash
vp test apps/web/src/components/ui/empty.test.tsx
git add apps/web/src/components/ui/empty.tsx apps/web/src/components/ui/empty.test.tsx
git commit -m "fix(web): keep empty state links semantic blue"
```

---

### Task 3: Move the Model Selection Check onto the Interaction Token

**Files:**

- Modify: `apps/web/src/components/chat/ModelListRow.tsx`
- Modify: `apps/web/src/components/chat/ModelListRow.test.tsx`

**Interfaces:**

- Selected model check: `text-primary`.
- Unselected row: no primary check.
- Preserves: current selection marker, accessible row state, provider branding, and disabled behavior.

- [ ] **Step 1: Add a failing selected-check assertion**

Extend the selected-row test in `ModelListRow.test.tsx` with:

```tsx
expect(markup).toContain("text-primary");
expect(markup).not.toContain("text-blue-400");
```

Also retain or add an unselected-case assertion that the check icon is absent, so the state is not color-only.

- [ ] **Step 2: Run the focused test and confirm it fails**

```bash
vp test apps/web/src/components/chat/ModelListRow.test.tsx
```

Expected: FAIL because the selected check uses `text-blue-400`.

- [ ] **Step 3: Replace only the interactive hard-coded blue**

In `ModelListRow.tsx`, change the selected check's class from `text-blue-400` to `text-primary`. Do not alter provider accent colors or model metadata colors.

- [ ] **Step 4: Run the focused test and commit**

```bash
vp test apps/web/src/components/chat/ModelListRow.test.tsx
git add apps/web/src/components/chat/ModelListRow.tsx apps/web/src/components/chat/ModelListRow.test.tsx
git commit -m "fix(web): theme selected model check with primary"
```

---

### Task 4: Audit the Semantic-Blue Boundary and Run Theme Verification

**Files:**

- Audit: `apps/web/src/**/*.tsx`
- Audit: `apps/web/src/index.css`

- [ ] **Step 1: Inventory remaining blue literals**

Run:

```bash
rg -n "blue-|#[0-9a-fA-F]{6}|oklch\(" apps/web/src --glob '*.tsx' --glob '*.ts' --glob '*.css'
```

Classify each hit. Keep known semantic uses in `McpStatusPopover.tsx`, `ComposerPreviewAnnotationCards.tsx`, `ResourceDiagnosticsSections.tsx`, provider palettes, file icons, syntax/diffs, and terminal colors. Convert only newly discovered interaction/selection hits to `primary` and add a focused test beside each converted component.

- [ ] **Step 2: Run all theme-focused tests**

```bash
vp test apps/web/src/themeTokens.test.ts apps/web/src/browser/annotationTheme.test.ts apps/web/src/components/ui/empty.test.tsx apps/web/src/components/chat/ModelListRow.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run repository validation**

```bash
vp test
vp check
vp run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 4: Record visual checks for the combined execution**

When all three coordinated plans are implemented, use Codex `computer-use:computer-use` in the built desktop app to verify light and dark buttons, toggles, selected tabs/rows, and focus rings are orange with white solid-selection text, while links and informational states remain blue. Save screenshots under ignored `.artifacts/visual-qa/orange-theme/` and inspect them at full resolution.

- [ ] **Step 5: Commit any audited interaction corrections**

```bash
git add apps/web/src
git commit -m "test(web): protect orange interaction semantics"
```
