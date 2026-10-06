export interface NativeSharingApplicationPorts<Browser> {
  readonly guard: () => Promise<void>;
  readonly start: () => Promise<void>;
  readonly connect: () => Promise<Browser>;
  readonly disconnect: (browser: Browser) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly unsafeCleanup: () => void;
}
/** Join this owner even when startup or session admission failed part way through. */
export async function withNativeSharingApplication<A, Browser>(
  ports: NativeSharingApplicationPorts<Browser>,
  run: (browser: Browser) => Promise<A>,
): Promise<A> {
  await ports.guard();
  let attempted = false,
    connected = false,
    browser: Browser | undefined,
    failed = false,
    original: unknown,
    result: A | undefined;
  try {
    attempted = true;
    await ports.start();
    await ports.guard();
    browser = await ports.connect();
    connected = true;
    await ports.guard();
    result = await run(browser);
    await ports.guard();
  } catch (error) {
    failed = true;
    original = error;
  }
  let cleanupFailed = false;
  if (connected) {
    try {
      await ports.disconnect(browser!);
    } catch {
      cleanupFailed = true;
    }
  }
  if (attempted) {
    try {
      await ports.stop();
    } catch {
      cleanupFailed = true;
    }
    try {
      await ports.guard();
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    try {
      ports.unsafeCleanup();
    } catch {
      /* Preserve the original operation. */
    }
  }
  if (failed) throw original;
  if (cleanupFailed) throw new Error("Owned native sharing application cleanup refused.");
  return result as A;
}
