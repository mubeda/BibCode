// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { useLatestHandler } from "./useLatestHandler";

interface ProbeProps {
  readonly value: string;
  readonly onHandler: (handler: (suffix: string) => string) => void;
}

function Probe({ value, onHandler }: ProbeProps) {
  const read = useLatestHandler((suffix: string) => `${value}${suffix}`);
  useEffect(() => {
    onHandler(read);
  });
  return <output>{value}</output>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("useLatestHandler", () => {
  it("keeps one identity and runs the latest committed render's handler", async () => {
    const handlers: Array<(suffix: string) => string> = [];
    const onHandler = (handler: (suffix: string) => string) => {
      handlers.push(handler);
    };

    await act(async () => root.render(<Probe value="first" onHandler={onHandler} />));
    await act(async () => root.render(<Probe value="second" onHandler={onHandler} />));
    await act(async () => root.render(<Probe value="third" onHandler={onHandler} />));

    expect(container.textContent).toBe("third");
    expect(handlers).toHaveLength(3);
    expect(new Set(handlers).size).toBe(1);
    expect(handlers[0]!("!")).toBe("third!");
  });
});
