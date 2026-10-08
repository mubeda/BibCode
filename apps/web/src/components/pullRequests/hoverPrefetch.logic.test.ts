import { describe, expect, it } from "vite-plus/test";
import { createPrefetchGate, MAX_HOVER_PREFETCHES } from "./hoverPrefetch.logic";

describe("createPrefetchGate", () => {
  it("allows two acquisitions and refuses the third until one releases", () => {
    const gate = createPrefetchGate();
    expect(MAX_HOVER_PREFETCHES).toBe(2);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    gate.release();
    expect(gate.tryAcquire()).toBe(true);
  });
});
