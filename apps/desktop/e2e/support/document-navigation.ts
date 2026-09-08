export async function refreshDesktopUiDocument(): Promise<void> {
  const previousOrigin = await browser.execute(() => performance.timeOrigin);
  await browser.refresh();
  // The embedded driver's refresh resolves after scheduling navigation. The old
  // document can still be complete; setup must wait for its replacement.
  await browser.waitUntil(
    async () =>
      browser.execute(
        (previous: number) =>
          performance.timeOrigin !== previous && document.readyState === "complete",
        previousOrigin,
      ),
    { timeoutMsg: "The replacement desktop document did not finish loading after refresh." },
  );
}
