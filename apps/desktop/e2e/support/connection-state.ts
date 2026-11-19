// @effect-diagnostics globalTimers:off - The timer runs inside the page under test, not in an Effect.
/**
 * What the web client holds when the app stays at "Project data is still loading" (#381): the
 * sidebar text, the requests it made that are not scripts or styles, and the connection
 * catalog in IndexedDB. A spec writes it to its evidence when the project never loads, so an
 * intermittent hang leaves a record instead of only a timeout.
 */
export async function captureStuckConnectionState(): Promise<unknown> {
  return browser.executeAsync((done: (value: unknown) => void) => {
    const result: Record<string, unknown> = {
      sidebar: document.body.innerText.replaceAll(/\s+/g, " ").slice(0, 300),
      resources: performance
        .getEntriesByType("resource")
        .map((entry) => {
          const resource = entry as PerformanceResourceTiming;
          return `${resource.name.replace(/\?.*/, "")} start=${Math.round(resource.startTime)} end=${Math.round(resource.responseEnd)} status=${(resource as unknown as { responseStatus?: number }).responseStatus ?? "?"}`;
        })
        .filter((line) => !/\.(js|css|woff2?|png|svg)\b/.test(line)),
      now: Math.round(performance.now()),
    };
    const timer = setTimeout(() => {
      result.indexedDb = "open did not settle in 8 s";
      done(result);
    }, 8_000);
    const request = indexedDB.open("bibcode:connection-runtime");
    request.addEventListener("blocked", () => (result.indexedDbBlocked = true));
    request.addEventListener("error", () => {
      clearTimeout(timer);
      result.indexedDb = `error ${String(request.error)}`;
      done(result);
    });
    request.addEventListener("success", () => {
      const database = request.result;
      const stores = [...database.objectStoreNames];
      result.indexedDb = `version ${database.version} stores ${stores.join(",")}`;
      if (stores.length === 0) {
        clearTimeout(timer);
        database.close();
        done(result);
        return;
      }
      const transaction = database.transaction(stores, "readonly");
      const counts: string[] = [];
      for (const store of stores) {
        const keys = transaction.objectStore(store).getAllKeys();
        keys.addEventListener("success", () =>
          counts.push(`${store}: ${keys.result.map(String).join("|").slice(0, 200)}`),
        );
      }
      transaction.addEventListener("complete", () => {
        clearTimeout(timer);
        result.indexedDbKeys = counts;
        database.close();
        done(result);
      });
    });
  });
}
