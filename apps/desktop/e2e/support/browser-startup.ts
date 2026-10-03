const resourceKinds = [
  "entry",
  "bootstrap",
  "bridge",
  "router",
  "app-root",
  "optimized",
  "source",
] as const;
const errorClasses = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "ReferenceError",
  "RangeError",
  "EvalError",
  "URIError",
  "AggregateError",
  "DOMException",
]);
const statuses = new Set(["ok", "client-error", "server-error", "other", "unknown"]);
const maximumCount = 20_000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** This is evidence of observations, never an application readiness oracle. */
export function projectBrowserStartupObservation(input: unknown) {
  const source = record(input);
  const boolean = (name: string) => (typeof source[name] === "boolean" ? source[name] : null);
  const count = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximumCount
      ? value
      : null;
  const resources = record(source.resources);
  return {
    installed: boolean("installed"),
    bootShellPresent: boolean("bootShellPresent"),
    domContentLoaded: boolean("domContentLoaded"),
    windowLoaded: boolean("windowLoaded"),
    viteErrorOverlayPresent: boolean("viteErrorOverlayPresent"),
    rootErrorHeadingPresent: boolean("rootErrorHeadingPresent"),
    desktopBridgePresent: boolean("desktopBridgePresent"),
    tauriMarkerPresent: boolean("tauriMarkerPresent"),
    errors: count(source.errors),
    rejections: count(source.rejections),
    resourceErrors: count(source.resourceErrors),
    lastErrorClass:
      typeof source.lastErrorClass === "string" && errorClasses.has(source.lastErrorClass)
        ? source.lastErrorClass
        : null,
    dynamicImportFailure: boolean("dynamicImportFailure"),
    resourceObserverAvailable: boolean("resourceObserverAvailable"),
    resourceEntriesTruncated: boolean("resourceEntriesTruncated"),
    counterSaturated: boolean("counterSaturated"),
    resources: Object.fromEntries(
      resourceKinds.map((kind) => {
        if (source.resourceObserverAvailable !== true || resources[kind] == null)
          return [kind, null];
        const resource = record(resources[kind]);
        return [
          kind,
          {
            completed: count(resource.completed),
            httpErrors: count(resource.httpErrors),
            lastStatus:
              typeof resource.lastStatus === "string" && statuses.has(resource.lastStatus)
                ? resource.lastStatus
                : null,
            lastDurationMs:
              typeof resource.lastDurationMs === "number" &&
              Number.isFinite(resource.lastDurationMs) &&
              resource.lastDurationMs >= 0 &&
              resource.lastDurationMs <= 600_000
                ? Math.round(resource.lastDurationMs)
                : null,
          },
        ];
      }),
    ),
  };
}

/** Installed before navigation; no requests, imports, DOM writes or readiness changes. */
export const browserStartupObservationScript = String.raw`(() => {
  const maximum = 20000;
  const kinds = ['entry', 'bootstrap', 'bridge', 'router', 'app-root', 'optimized', 'source'];
  const knownErrors = new Set(['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'EvalError', 'URIError', 'AggregateError', 'DOMException']);
  const state = {
    domContentLoaded: document.readyState === 'interactive' || document.readyState === 'complete',
    windowLoaded: document.readyState === 'complete', errors: 0, rejections: 0, resourceErrors: 0,
    lastErrorClass: null, dynamicImportFailure: false, resourceObserverAvailable: false,
    resourceEntriesTruncated: false, counterSaturated: false,
  };
  const resources = Object.fromEntries(kinds.map((kind) => [kind, { completed: 0, httpErrors: 0, lastStatus: 'unknown', lastDurationMs: null }]));
  const increment = (object, key) => {
    if (object[key] >= maximum) state.counterSaturated = true;
    else object[key] += 1;
  };
  const inspectError = (reason) => {
    state.lastErrorClass = null;
    if (!reason || typeof reason !== 'object') return;
    if (typeof reason.name === 'string' && knownErrors.has(reason.name)) state.lastErrorClass = reason.name;
    const message = typeof reason.message === 'string' ? reason.message.slice(0, 2048) : '';
    if (['Failed to fetch dynamically imported module', 'error loading dynamically imported module', 'Importing a module script failed'].some((marker) => message.includes(marker))) state.dynamicImportFailure = true;
  };
  addEventListener('DOMContentLoaded', () => { state.domContentLoaded = true; });
  addEventListener('load', () => { state.windowLoaded = true; });
  addEventListener('error', (event) => {
    try {
      if (event && (event.target?.tagName === 'SCRIPT' || event.target?.tagName === 'LINK') && !('error' in event)) {
        increment(state, 'resourceErrors');
      } else { increment(state, 'errors'); inspectError(event?.error); }
    } catch { /* Observation never alters the page's error handling. */ }
  }, true);
  addEventListener('unhandledrejection', (event) => {
    increment(state, 'rejections');
    try { inspectError(event?.reason); } catch { /* No raw reason is retained. */ }
  });
  const kindFor = (name) => {
    if (typeof name !== 'string' || name.length > 8192) return null;
    const url = new URL(name, location.origin);
    if (url.origin !== location.origin) return null;
    const path = url.pathname;
    const exact = { '/src/main.tsx': 'entry', '/src/bootstrap.tsx': 'bootstrap', '/src/tauriDesktopBridge.ts': 'bridge', '/src/router.ts': 'router', '/src/AppRoot.tsx': 'app-root' };
    if (Object.hasOwn(exact, path)) return exact[path];
    if (path.includes('/.vite/') || path.includes('/.vite-plus/')) return 'optimized';
    return path.startsWith('/src/') || path.startsWith('/@fs/') ? 'source' : null;
  };
  try {
    const observer = new PerformanceObserver((list) => {
      try {
      const entries = list.getEntries();
      if (!Array.isArray(entries)) { state.resourceEntriesTruncated = true; return; }
      if (entries.length > 256) state.resourceEntriesTruncated = true;
      for (const entry of entries.slice(0, 256)) {
        try {
          const kind = kindFor(entry.name);
          if (!kind) continue;
          const target = resources[kind];
          increment(target, 'completed');
          const code = entry.responseStatus;
          if (Number.isInteger(code) && code >= 400 && code < 600) increment(target, 'httpErrors');
          target.lastStatus = !Number.isInteger(code) || code <= 0 || code >= 600 ? 'unknown' : code >= 500 ? 'server-error' : code >= 400 ? 'client-error' : code >= 200 && code < 300 ? 'ok' : 'other';
          target.lastDurationMs = Number.isFinite(entry.duration) && entry.duration >= 0 && entry.duration <= 600000 ? Math.round(entry.duration) : null;
        } catch { /* Names and URLs are discarded even when classification fails. */ }
      }
      } catch { state.resourceEntriesTruncated = true; }
    });
    observer.observe({ type: 'resource', buffered: true });
    state.resourceObserverAvailable = true;
  } catch { /* Unsupported observation stays explicitly unavailable. */ }
  window.__browserStartupObservation = { read: () => ({
    installed: true,
    bootShellPresent: document.getElementById('boot-shell') !== null,
    domContentLoaded: state.domContentLoaded, windowLoaded: state.windowLoaded,
    viteErrorOverlayPresent: document.querySelector('vite-error-overlay') !== null,
    rootErrorHeadingPresent: Array.from(document.querySelectorAll('h1')).slice(0, 64).some((heading) => heading.textContent?.trim() === 'Something went wrong.'),
    desktopBridgePresent: window.desktopBridge !== undefined,
    tauriMarkerPresent: window.__TAURI__ !== undefined || window.__TAURI_INTERNALS__ !== undefined,
    errors: state.errors, rejections: state.rejections, resourceErrors: state.resourceErrors,
    lastErrorClass: state.lastErrorClass, dynamicImportFailure: state.dynamicImportFailure,
    resourceObserverAvailable: state.resourceObserverAvailable,
    resourceEntriesTruncated: state.resourceEntriesTruncated, counterSaturated: state.counterSaturated,
    resources: Object.fromEntries(kinds.map((kind) => [kind, state.resourceObserverAvailable ? {
      completed: resources[kind].completed, httpErrors: resources[kind].httpErrors, lastStatus: resources[kind].lastStatus, lastDurationMs: resources[kind].lastDurationMs,
    } : null])),
  }) };
})();`;
