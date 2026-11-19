// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { clearResourceRefusals, useResourceRefusal, type ResourceRefusal } from "./resourceRefusal";

let container: HTMLDivElement;
let root: Root;
const seen: (ResourceRefusal | null)[] = [];

function Probe(props: {
  data: unknown;
  refusedNow: ResourceRefusal | null;
  event: { readonly refused?: ResourceRefusal } | null;
}) {
  seen.push(
    useResourceRefusal(
      "key",
      { data: props.data, error: null, isPending: false },
      props.refusedNow,
      props.event,
    ),
  );
  return null;
}

async function render(props: Parameters<typeof Probe>[0]) {
  await act(async () => root.render(<Probe {...props} />));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  clearResourceRefusals();
  seen.length = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
});

it("is lifted only by a successful read newer than the latest refusal", async () => {
  const a = { detail: "A" };
  const b = { detail: "B" };
  const poller = { refused: "forbidden" as const };
  await render({ data: a, refusedNow: null, event: null });
  await render({ data: a, refusedNow: "forbidden", event: null });
  // A successful read and a newer refusal arrive in the same update: the read is not newer.
  await render({ data: b, refusedNow: null, event: poller });
  await render({ data: b, refusedNow: null, event: poller });
  expect(seen.at(-1)).toBe("forbidden");
  await render({ data: { detail: "C" }, refusedNow: null, event: null });
  expect(seen.at(-1)).toBeNull();
});

it("still holds a refusal after a reload until a live read of it succeeds", async () => {
  await render({ data: { detail: "A" }, refusedNow: "forbidden", event: null });
  await act(async () => root.unmount());
  // A reload starts a new module with an empty in-memory map and no live value yet.
  vi.resetModules();
  const reloaded = await import("./resourceRefusal");
  const after: (ResourceRefusal | null)[] = [];
  function Reloaded(props: { data: unknown; isPending: boolean }) {
    after.push(
      reloaded.useResourceRefusal(
        "key",
        { data: props.data, error: null, isPending: props.isPending },
        null,
      ),
    );
    return null;
  }
  root = createRoot(container);
  await act(async () => root.render(<Reloaded data={null} isPending />));
  expect(after.at(-1)).toBe("forbidden");
  await act(async () => root.render(<Reloaded data={{ detail: "B" }} isPending={false} />));
  expect(after.at(-1)).toBeNull();
  // Lifted for good: the next reload starts clear.
  vi.resetModules();
  const again = await import("./resourceRefusal");
  function Again() {
    after.push(again.useResourceRefusal("key", { data: null, error: null, isPending: true }, null));
    return null;
  }
  await act(async () => root.render(<Again />));
  expect(after.at(-1)).toBeNull();
});
