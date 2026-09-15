# Terminal Shift+Enter Soft Newline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shift+Enter inside a BiBCode terminal inserts a line break in AI CLI prompts (Codex, Claude Code) instead of submitting the message.

**Architecture:** xterm.js 6.0.0 encodes Shift+Enter exactly like Enter (`\r`), and no BiBCode code intercepts it. The fix adds one pure keybinding helper that maps Shift+Enter to ESC CR (`\u001b\r`), the sequence xterm already emits for Alt+Enter, Claude Code's `/terminal-setup` binds Shift+Enter to, and Codex maps to `insert_newline` (its default `alt(KeyCode::Enter)` binding). The terminal panel's existing custom key handler sends that sequence through the same input writer the navigation and delete shortcuts use, and prevents the default so xterm's keypress fallback never emits `\r`. Server and PTY pass input bytes through unchanged.

**Tech Stack:** React 19, xterm.js 6.0.0, Vitest via Vite+ (`node scripts/run-local-vp.mjs`).

**Spec:** User request, 2026-09-15, verbatim: "in the terminals the keyboard combination Shift + Enter sends the message directly when the terminal AI is used and it should be a breakline". Diagnosis evidence: `node_modules/@xterm/xterm/src/common/input/Keyboard.ts:100-104` (`result.key = ev.altKey ? C0.ESC + C0.CR : C0.CR`, Shift ignored) and `apps/web/src/components/ThreadTerminalPanel.tsx:1267-1318` (custom handler returns `true` for Enter).

## Global Constraints

- Sequence is `\u001b\r` (ESC CR), hardcoded, no user preference (matches the other hardcoded terminal helpers in `apps/web/src/keybindings.ts`).
- Only plain Shift+Enter is remapped. Enter, Alt+Enter, Ctrl+Enter, Meta+Enter, and Shift with any other modifier stay with xterm.
- Only `keydown` events are handled; `keypress`/`keyup` return `null` like `terminalNavigationShortcutData`.
- No server, contract, or PTY change. Input contract stays `terminal.write` / `terminal.writeInput` with unchanged data.
- `apps/web` change: run the `vercel-react-best-practices` review and the `UI.md` review before completion.
- Do not commit `.codegraph/` data or `node_modules`.

---

### Task 1: Pure helper `terminalNewlineShortcutData`

**Files:**
- Modify: `apps/web/src/keybindings.ts` (constants near line 47-51; new export after `terminalNavigationShortcutData`, which starts at line 534)
- Test: `apps/web/src/keybindings.test.ts` (import block at lines 23-25; existing helper suites near lines 865-924 use the `event()` helper at lines 36-45)

**Interfaces:**
- Consumes: `ShortcutEventLike` (line 13) and `normalizeEventKey(key)` (line 67), both already in the file.
- Produces: `export function terminalNewlineShortcutData(event: ShortcutEventLike): string | null` returning `"\u001b\r"` for plain Shift+Enter keydown, else `null`. Task 2 imports it.

- [ ] **Step 1: Write the failing tests**

Add `terminalNewlineShortcutData` to the named import from `./keybindings` at the top of `apps/web/src/keybindings.test.ts`, then append:

```ts
describe("terminalNewlineShortcutData", () => {
  it("maps Shift+Enter to ESC CR so CLI prompts insert a newline", () => {
    assert.strictEqual(
      terminalNewlineShortcutData(event({ key: "Enter", shiftKey: true })),
      "\u001b\r",
    );
  });

  it("leaves plain and otherwise-modified Enter to xterm", () => {
    assert.isNull(terminalNewlineShortcutData(event({ key: "Enter" })));
    assert.isNull(
      terminalNewlineShortcutData(event({ key: "Enter", shiftKey: true, altKey: true })),
    );
    assert.isNull(
      terminalNewlineShortcutData(event({ key: "Enter", shiftKey: true, ctrlKey: true })),
    );
    assert.isNull(
      terminalNewlineShortcutData(event({ key: "Enter", shiftKey: true, metaKey: true })),
    );
    assert.isNull(terminalNewlineShortcutData(event({ key: "a", shiftKey: true })));
  });

  it("ignores non-keydown events", () => {
    assert.isNull(
      terminalNewlineShortcutData(event({ type: "keypress", key: "Enter", shiftKey: true })),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from the repository root:

```bash
node scripts/run-local-vp.mjs test run apps/web/src/keybindings.test.ts
```

Expected: FAIL. The suite cannot import `terminalNewlineShortcutData` (TypeScript/ESM export missing).

- [ ] **Step 3: Implement the helper**

In `apps/web/src/keybindings.ts`, after `const TERMINAL_DELETE_TO_LINE_START = "\u0015";` (line 51) add:

```ts
// ESC CR is what xterm already emits for Alt+Enter, what Claude Code's /terminal-setup binds
// Shift+Enter to, and what Codex maps to insert_newline. CLI prompts treat it as a soft newline.
const TERMINAL_SOFT_NEWLINE = "\u001b\r";
```

After the `terminalNavigationShortcutData` function add:

```ts
/**
 * Maps Shift+Enter to the soft-newline sequence CLI prompts (Codex, Claude Code) accept, or
 * returns null so xterm encodes the key itself.
 */
export function terminalNewlineShortcutData(event: ShortcutEventLike): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }
  if (normalizeEventKey(event.key) !== "enter") {
    return null;
  }
  if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
    return null;
  }
  return TERMINAL_SOFT_NEWLINE;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/keybindings.test.ts
```

Expected: PASS, all suites green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/keybindings.ts apps/web/src/keybindings.test.ts
git commit -m "feat(terminal): map Shift+Enter to a soft newline sequence"
```

---

### Task 2: Wire the helper into the terminal key handler

**Files:**
- Modify: `apps/web/src/components/ThreadTerminalPanel.tsx` (import block lines 52-63; custom key handler lines 1267-1318, insert before `if (!isTerminalClearShortcut(event)) return true;` at line 1314)
- Test: `apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx` (xterm mock at lines 295-420 exposes `terminal.keyHandler`; `testState.writeCommand` at line 432; existing key-handler tests at lines 3401-3447 inside `describe("TerminalViewport mounted lifecycle")`)

**Interfaces:**
- Consumes: `terminalNewlineShortcutData` from Task 1; existing `sendTerminalInput(data, failureMessage)` at lines 1231-1240.
- Produces: the terminal's `attachCustomKeyEventHandler` returns `false` for Shift+Enter after sending `"\u001b\r"`; no new exports.

- [ ] **Step 1: Write the failing component test**

Inside `describe("TerminalViewport mounted lifecycle")`, next to the existing key-handler test near line 3423, add:

```tsx
it("sends ESC CR for Shift+Enter instead of a bare carriage return", async () => {
  await mount(<TerminalViewport {...viewportProps()} />);
  const terminal = xtermState.terminals[0]!;

  const shiftEnter = new KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey: true,
    cancelable: true,
  });
  expect(terminal.keyHandler?.(shiftEnter)).toBe(false);
  await act(async () => Promise.resolve());

  // preventDefault on keydown suppresses xterm's keypress fallback, which would otherwise still
  // emit "\r" (CoreBrowserTerminal._keyPress).
  expect(shiftEnter.defaultPrevented).toBe(true);
  expect(testState.writeCommand).toHaveBeenCalledOnce();
  expect(testState.writeCommand).toHaveBeenCalledWith({
    environmentId: ENVIRONMENT_ID,
    input: { threadId: THREAD_ID, terminalId: "term-1", data: "\u001b\r" },
  });

  // Plain Enter still belongs to xterm.
  expect(terminal.keyHandler?.(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
});
```

`mount`, `viewportProps`, `xtermState`, `ENVIRONMENT_ID`, `THREAD_ID`, and `testState.writeCommand` are the names the neighbouring test "routes macOS navigation and delete shortcuts to terminal input" (line 3424) already uses, and it asserts on `testState.writeCommand` with the same `{ environmentId, input: { threadId, terminalId, data } }` shape.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/ThreadTerminalPanel.interactions.test.tsx
```

Expected: FAIL at `expect(terminal.keyHandler?.(shiftEnter)).toBe(false)` because the handler currently returns `true`.

- [ ] **Step 3: Implement the handler branch**

Add `terminalNewlineShortcutData` to the `~/keybindings` import in `ThreadTerminalPanel.tsx`. Then, immediately before `if (!isTerminalClearShortcut(event)) return true;`, insert:

```ts
      const newlineData = terminalNewlineShortcutData(event);
      if (newlineData !== null) {
        event.preventDefault();
        event.stopPropagation();
        sendTerminalInput(newlineData, "Failed to insert newline");
        return false;
      }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/ThreadTerminalPanel.interactions.test.tsx
```

Expected: PASS, all 132 tests green (131 existing plus the new one).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ThreadTerminalPanel.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx
git commit -m "fix(terminal): insert a newline on Shift+Enter in CLI prompts"
```

---

### Task 3: Documentation, reviews, and validation

**Files:**
- Modify: `docs/user/workspace-ui.md` (terminal shortcut paragraph, lines 169-177)
- Review only: `docs/user/keybindings.md` (no rebindable command is added, so no change expected), `docs/testing/` runbooks (no packaged UI flow changes)

- [ ] **Step 1: Document the shortcut**

Append this sentence to the terminal shortcut paragraph in `docs/user/workspace-ui.md` (after the sentence ending "show a notice without opening a terminal session."):

```markdown
Inside a terminal, `Shift+Enter` sends a soft newline (ESC CR) so Codex and
Claude Code prompts insert a line break instead of submitting; plain `Enter`
still submits.
```

- [ ] **Step 2: Run the required reviews**

Invoke the `vercel-react-best-practices` skill against `apps/web/src/components/ThreadTerminalPanel.tsx` (the handler branch adds no hooks or renders, so expect no findings). Check the change against `UI.md`: the shortcut matches the convention users already know from VS Code and Zed terminals ("Follow platform conventions", "Support common shortcuts users will try"). Record both review outcomes in the final report.

- [ ] **Step 3: Run repository gates**

```bash
node scripts/run-local-vp.mjs test run apps/web/src/keybindings.test.ts
cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/ThreadTerminalPanel.interactions.test.tsx && cd ../..
vp check
vp run typecheck
```

Expected: all green. Then `git diff` and `git status --short` show only the four source/test files and the doc.

- [ ] **Step 4: Commit**

```bash
git add docs/user/workspace-ui.md
git commit -m "docs(terminal): describe Shift+Enter soft newline"
```

## Residual risk

- Programs that do not treat ESC CR as newline: fish inserts a newline, bash and zsh treat Meta-Return as unbound (harmless), vim receives ESC then CR. This matches the behaviour Claude Code's own VS Code recipe produces.
- Codex behaviour is verified against upstream `main` and strings in the installed `codex-cli 0.153.4` binary, not a vendored snapshot; Claude Code behaviour is verified against its published terminal docs and binary strings.
- No test can prove "today sends `\r`" through the xterm mock; that claim rests on the xterm source cited in the spec.

## Self-review

- Spec coverage: Shift+Enter → newline (Task 2), plain Enter unchanged (Task 1 and 2 tests), documented (Task 3).
- Placeholder scan: none.
- Type consistency: `terminalNewlineShortcutData(event: ShortcutEventLike): string | null` is used with the same name and signature in Tasks 1 and 2.
