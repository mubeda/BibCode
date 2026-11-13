// @vitest-environment happy-dom
import { Terminal } from "@xterm/xterm";
import { expect, it } from "vite-plus/test";

// `syncXtermScrollArea` calls a private xterm method; an upgrade that drops it must fail here,
// not silently switch the repair off (#348).
it("the installed xterm still has the private scroll-area sync the follow repair calls", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
  terminal.open(host);
  const viewport = (
    terminal as unknown as { _core?: { _viewport?: { _sync?: unknown; queueSync?: unknown } } }
  )._core?._viewport;
  expect(typeof viewport?._sync === "function" || typeof viewport?.queueSync === "function").toBe(
    true,
  );
  terminal.dispose();
  host.remove();
});
