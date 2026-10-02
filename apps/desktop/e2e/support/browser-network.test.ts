import { expect, it, vi } from "vite-plus/test";
import {
  BrowserConnectivityFailure,
  ensureBrowserOnline,
  parseNetworkProof,
} from "./browser-network.ts";

const containment = {
  privateNet: true,
  pidOwnerMatches: true,
  userOwnerMatches: true,
  loopbackOnlyBefore: true,
  linksContained: true,
  routeContained: true,
  interfaceCount: 3,
  elapsedMs: 1,
} as const;
function fixture(values: unknown[]) {
  let time = 0;
  return {
    readOnline: vi.fn(async () => (values.length > 1 ? values.shift() : values[0])),
    setup: vi.fn(async () => containment),
    now: () => time,
    sleep: vi.fn(async (ms: number) => {
      time += ms;
    }),
  };
}
it("already online skips every helper/network mutation", async () => {
  const f = fixture([true]);
  const proof = await ensureBrowserOnline(f);
  expect(f.setup).not.toHaveBeenCalled();
  expect(f.sleep).not.toHaveBeenCalled();
  expect(proof).toMatchObject({ before: true, after: true, setupRan: false, containment: null });
});
it("only actual offline invokes setup once and waits for true before navigation", async () => {
  const f = fixture([false, false, true]);
  const navigate = vi.fn();
  await ensureBrowserOnline(f).then(navigate);
  expect(f.setup).toHaveBeenCalledOnce();
  expect(f.readOnline).toHaveBeenCalledTimes(3);
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ before: false, after: true, setupRan: true, containment }),
  );
});
it("offline deadline fails closed without navigation or repeat setup", async () => {
  const f = fixture([false]);
  const navigate = vi.fn();
  let failure: unknown;
  try {
    await ensureBrowserOnline(f).then(navigate);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BrowserConnectivityFailure);
  expect((failure as BrowserConnectivityFailure).proof).toMatchObject({
    before: false,
    after: false,
    setupRan: true,
    elapsedMs: 10000,
  });
  expect(f.setup).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
});
it.each([undefined, null, "false", 0, {}])(
  "invalid online observation %s never mutates",
  async (value) => {
    const f = fixture([value]);
    await expect(ensureBrowserOnline(f)).rejects.toBeInstanceOf(BrowserConnectivityFailure);
    expect(f.setup).not.toHaveBeenCalled();
  },
);
it("setup and post-setup observation failures retain only projected safe evidence", async () => {
  const f = fixture([false]);
  f.setup.mockRejectedValueOnce(new Error("credential-secret raw routes"));
  try {
    await ensureBrowserOnline(f);
  } catch (error) {
    expect(JSON.stringify(error)).not.toContain("credential-secret");
    expect((error as BrowserConnectivityFailure).proof.setupRan).toBe(true);
  }
  await expect(ensureBrowserOnline(fixture([false, "true"]))).rejects.toBeInstanceOf(
    BrowserConnectivityFailure,
  );
});
it("proof decoder refuses extra fields, false containment and unbounded numeric values", () => {
  expect(parseNetworkProof(JSON.stringify(containment))).toEqual(containment);
  for (const value of [
    { ...containment, routeContained: false },
    { ...containment, ip: "secret" },
    { ...containment, elapsedMs: Infinity },
    { ...containment, interfaceCount: 4 },
  ])
    expect(() => parseNetworkProof(JSON.stringify(value))).toThrow();
});

it("does not navigate when true arrives after the observation deadline", async () => {
  const f = fixture([false]);
  f.readOnline
    .mockImplementationOnce(async () => false)
    .mockImplementationOnce(async () => {
      await f.sleep(10_001);
      return true;
    });
  const navigate = vi.fn();
  await expect(ensureBrowserOnline(f).then(navigate)).rejects.toBeInstanceOf(
    BrowserConnectivityFailure,
  );
  expect(navigate).not.toHaveBeenCalled();
});
