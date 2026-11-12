import { describe, expect, it } from "vite-plus/test";
import {
  shouldClaimTerminalSize,
  shouldShowTerminalSizeNotice,
  hasForeignTerminalSizeOwner,
  terminalMirrorScale,
  TERMINAL_MIRROR_MIN_SCALE,
} from "./terminalSizePolicy";

const applied = { cols: 151, rows: 50, sizeClaim: "other" };
const fitted = { cols: 91, rows: 42 };
const base = {
  sizeClaim: "mine",
  applied,
  fitted,
  documentFocused: true,
  userActive: true,
  claimInFlight: false,
};

describe("unattended windows (#348)", () => {
  it.each(["attach", "focus"] as const)(
    "does not take a live owner's size on %s without recent input in this page",
    (trigger) => {
      expect(shouldClaimTerminalSize({ ...base, trigger, userActive: false })).toBe(false);
      expect(shouldClaimTerminalSize({ ...base, trigger, userActive: true })).toBe(true);
    },
  );

  it("still claims a released size and still claims on pointer, keypress and fit", () => {
    const released = { ...applied, sizeClaim: null };
    expect(
      shouldClaimTerminalSize({ ...base, trigger: "attach", applied: released, userActive: false }),
    ).toBe(true);
    for (const trigger of ["pointer", "keypress", "fit"] as const) {
      expect(shouldClaimTerminalSize({ ...base, trigger, userActive: false })).toBe(true);
    }
  });
});

describe("mirror scale (#348)", () => {
  const owner = (cols: number, rows: number) => ({ cols, rows, sizeClaim: "other" });

  it("scales a mirror down by the tighter of rows and columns so nothing is cut off", () => {
    expect(terminalMirrorScale("mine", owner(100, 50), { cols: 100, rows: 30 })).toBe(0.6);
    expect(terminalMirrorScale("mine", owner(160, 30), { cols: 120, rows: 30 })).toBe(0.75);
    expect(terminalMirrorScale("mine", owner(160, 50), { cols: 120, rows: 40 })).toBe(0.75);
  });

  it("never scales up, and leaves the owner and an unmeasured mirror at full size", () => {
    expect(terminalMirrorScale("mine", owner(80, 24), { cols: 120, rows: 40 })).toBe(1);
    expect(terminalMirrorScale("other", owner(160, 50), { cols: 120, rows: 30 })).toBe(1);
    expect(terminalMirrorScale("mine", owner(160, 50), null)).toBe(1);
    expect(terminalMirrorScale("mine", null, { cols: 120, rows: 30 })).toBe(1);
  });

  it("stops at the readability floor", () => {
    expect(terminalMirrorScale("mine", owner(300, 100), { cols: 100, rows: 30 })).toBe(
      TERMINAL_MIRROR_MIN_SCALE,
    );
  });
});

describe("terminal size ownership", () => {
  it.each(["focus", "pointer", "keypress"] as const)(
    "claims on %s when a mirror even at equal size",
    (trigger) => {
      expect(shouldClaimTerminalSize({ ...base, trigger })).toBe(true);
      expect(shouldClaimTerminalSize({ ...base, trigger, fitted: applied })).toBe(true);
      expect(
        shouldClaimTerminalSize({ ...base, trigger, fitted: applied, sizeClaim: "other" }),
      ).toBe(false);
      expect(shouldClaimTerminalSize({ ...base, trigger, sizeClaim: "other" })).toBe(true);
    },
  );

  it("claims focused attachments but avoids an owner no-op with no possible echo", () => {
    expect(shouldClaimTerminalSize({ ...base, trigger: "attach", fitted: applied })).toBe(true);
    expect(shouldClaimTerminalSize({ ...base, trigger: "attach", documentFocused: false })).toBe(
      false,
    );
    expect(
      shouldClaimTerminalSize({ ...base, trigger: "attach", fitted: applied, sizeClaim: "other" }),
    ).toBe(false);
  });

  it("claims a null owner immediately even in an unfocused document", () => {
    expect(
      shouldClaimTerminalSize({
        ...base,
        trigger: "attach",
        documentFocused: false,
        applied: { ...applied, sizeClaim: null },
      }),
    ).toBe(true);
    expect(hasForeignTerminalSizeOwner({ ...applied, sizeClaim: null }, "mine")).toBe(false);
    expect(hasForeignTerminalSizeOwner(applied, "mine")).toBe(true);
    expect(hasForeignTerminalSizeOwner(applied, "other")).toBe(false);
  });

  it("allows only the owner to resize on layout changes", () => {
    expect(shouldClaimTerminalSize({ ...base, trigger: "layout" })).toBe(false);
    expect(shouldClaimTerminalSize({ ...base, trigger: "layout", sizeClaim: "other" })).toBe(true);
  });

  it("the explicit fit action claims a mirror", () => {
    expect(shouldClaimTerminalSize({ ...base, trigger: "fit" })).toBe(true);
  });

  it("waits for geometry and deduplicates every trigger while a claim is in flight", () => {
    expect(shouldClaimTerminalSize({ ...base, trigger: "focus", applied: null })).toBe(false);
    expect(shouldClaimTerminalSize({ ...base, trigger: "attach", fitted: null })).toBe(false);
    for (const trigger of ["attach", "focus", "pointer", "keypress", "layout", "fit"] as const) {
      expect(shouldClaimTerminalSize({ ...base, trigger, claimInFlight: true })).toBe(false);
    }
  });

  it("shows the notice only for a different-size mirror with no pending claim", () => {
    expect(shouldShowTerminalSizeNotice(base)).toBe(true);
    expect(shouldShowTerminalSizeNotice({ ...base, fitted: applied })).toBe(false);
    expect(shouldShowTerminalSizeNotice({ ...base, sizeClaim: "other" })).toBe(false);
    expect(
      shouldShowTerminalSizeNotice({ ...base, applied: { ...applied, sizeClaim: null } }),
    ).toBe(false);
    expect(shouldShowTerminalSizeNotice({ ...base, claimInFlight: true })).toBe(false);
  });
});
