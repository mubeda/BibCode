// Shapes only: no value of the test machine (a size, a mount point, a host name) is asserted.
const sheetSelector = '[data-testid="host-dashboard"]';
const cpuSelector = `${sheetSelector} [data-testid="host-dashboard-cpu"]`;
const sinceSelector = `${sheetSelector} [data-testid="host-dashboard-since"]`;
const hiddenReason =
  /(Network volume|Container layer|File mount|Empty|Same storage as .+|Hidden by the volume filter)$/;

async function openFromResourceManager(): Promise<void> {
  // The status bar sits on every route; leave Settings so no full-page surface covers it.
  await browser.execute(() => {
    if (window.location.hash.startsWith("#/settings")) window.location.hash = "#/";
  });
  const trigger = browser.$('button[aria-label^="Combined monitored resources"]');
  await trigger.waitForDisplayed();
  await trigger.click();
  const open = browser.$('//button[normalize-space()="Host dashboard"]');
  await open.waitForDisplayed();
  await open.click();
  await browser.$(sheetSelector).waitForDisplayed();
}

async function text(selector: string): Promise<string> {
  return (await browser.$(selector).getText()).trim();
}

async function texts(selector: string): Promise<string[]> {
  return browser.execute(
    (query: string) =>
      [...document.querySelectorAll(query)].map((node) => (node.textContent ?? "").trim()),
    selector,
  );
}

describe("packaged Host dashboard", () => {
  it("opens for the local computer, updates live, discloses hidden volumes and closes", async () => {
    await openFromResourceManager();

    const title = await text(`${sheetSelector} [data-slot="sheet-title"]`);
    // The fallback title means the local environment was not resolved.
    expect(title.length).toBeGreaterThan(0);
    expect(title).not.toBe("Host dashboard");

    await browser.waitUntil(async () => /^\d+(\.\d)?%$/.test(await text(cpuSelector)), {
      timeoutMsg: "The CPU figure never showed a percentage.",
    });
    expect(await text(`${sheetSelector} [data-testid="host-dashboard-memory"]`)).toMatch(
      / of .*, \d+%$/,
    );
    await browser.waitUntil(
      async () =>
        (await texts(`${sheetSelector} [data-testid="host-dashboard-volume"]`)).length > 0,
      { timeoutMsg: "No volume was listed." },
    );
    expect(await text(`${sinceSelector} h3`)).toMatch(/^Since/);
    // A shown volume gets its own statistics row once a volume reading has been recorded.
    await browser.waitUntil(
      async () =>
        (await texts(`${sinceSelector} tbody th`)).some((label) => label.endsWith(" used")),
      { timeoutMsg: "No per-volume statistics row appeared." },
    );

    const firstSampledAt = await browser.$(cpuSelector).getAttribute("data-sampled-at");
    expect(firstSampledAt).toBeTruthy();
    await browser.pause(3_000);
    expect(await browser.$(cpuSelector).getAttribute("data-sampled-at")).not.toBe(firstSampledAt);

    // One case only: every case starts from a reset connection and route, which closes the sheet.
    const disclosure = browser.$(
      '//*[@data-testid="host-dashboard"]//button[starts-with(normalize-space(), "Hidden volumes (")]',
    );
    // Whether a host hides a volume depends on its mounts (a container's file mounts, the macOS
    // data volume); a host that hides none shows no disclosure.
    if (await disclosure.isExisting()) {
      expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
      await disclosure.click();
      await browser.waitUntil(
        async () => (await disclosure.getAttribute("aria-expanded")) === "true",
        { timeoutMsg: "The hidden volumes disclosure never opened." },
      );
      const rows = await texts(`${sheetSelector} [data-testid="host-dashboard-hidden-volume"]`);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toMatch(hiddenReason);
        expect(row).not.toMatch(/\d\s?(B|KB|MB|GB|TB)\b/);
      }
    }

    await browser.keys("Escape");
    await browser.$(sheetSelector).waitForExist({ reverse: true });
  });
});
