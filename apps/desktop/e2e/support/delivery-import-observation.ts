export interface DeliveryImportObservation {
  safeLocation: boolean | null;
  route: "pair" | "root" | "workspace" | "settings" | "other" | null;
  modalPresent: boolean | null;
  modalDisplayed: boolean | null;
  pathPresent: boolean | null;
  pathDisabled: boolean | null;
  submitPresent: boolean | null;
  submitDisabled: boolean | null;
  composerPresent: boolean | null;
  composerDisplayed: boolean | null;
  primaryCardCount: "none" | "one" | "multiple" | null;
  primaryCardSelected: boolean | null;
  errorCategory: "host-loading" | "path-invalid" | "workspace-unavailable" | "other" | null;
}

/** Admit only the closed failure sample, without invoking serialized accessors. */
export function projectDeliveryImportObservation(input: unknown): DeliveryImportObservation | null {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const booleans = [
      "safeLocation",
      "modalPresent",
      "modalDisplayed",
      "pathPresent",
      "pathDisabled",
      "submitPresent",
      "submitDisabled",
      "composerPresent",
      "composerDisplayed",
      "primaryCardSelected",
    ];
    const keys = [...booleans, "route", "primaryCardCount", "errorCategory"];
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length !== keys.length ||
      !ownKeys.every((key) => typeof key === "string" && keys.includes(key))
    )
      return null;
    const value: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      value[key] = descriptor.value;
    }
    const choice = (key: string, values: string[]) =>
      value[key] === null || (typeof value[key] === "string" && values.includes(value[key]));
    if (
      !booleans.every((key) => value[key] === null || typeof value[key] === "boolean") ||
      !choice("route", ["pair", "root", "workspace", "settings", "other"]) ||
      !choice("primaryCardCount", ["none", "one", "multiple"]) ||
      !choice("errorCategory", [
        "host-loading",
        "path-invalid",
        "workspace-unavailable",
        "other",
      ]) ||
      (value.safeLocation !== true &&
        keys.some((key) => key !== "safeLocation" && value[key] !== null))
    )
      return null;
    return value as unknown as DeliveryImportObservation;
  } catch {
    return null;
  }
}

/** Serialized once into the owned page only after an import-phase failure. */
export function readDeliveryImportObservation(
  expectedOrigin: string,
): DeliveryImportObservation | null {
  try {
    const facts: DeliveryImportObservation = {
      safeLocation: false,
      route: null,
      modalPresent: null,
      modalDisplayed: null,
      pathPresent: null,
      pathDisabled: null,
      submitPresent: null,
      submitDisabled: null,
      composerPresent: null,
      composerDisplayed: null,
      primaryCardCount: null,
      primaryCardSelected: null,
      errorCategory: null,
    };
    if (
      expectedOrigin !== "http://127.0.0.1:4885" ||
      location.origin !== expectedOrigin ||
      location.search !== "" ||
      location.hash !== ""
    )
      return facts;
    facts.safeLocation = true;
    facts.route =
      location.pathname === "/"
        ? "root"
        : location.pathname === "/pair"
          ? "pair"
          : /^\/local\/[A-Za-z0-9._:-]{1,128}$/.test(location.pathname)
            ? "workspace"
            : ["/settings/general", "/settings/remote-servers"].includes(location.pathname)
              ? "settings"
              : "other";
    const displayed = (element: Element | null): boolean | null => {
      try {
        if (!element || typeof element.checkVisibility !== "function") return null;
        const visible = element.checkVisibility({
          contentVisibilityAuto: true,
          opacityProperty: true,
          visibilityProperty: true,
        });
        if (typeof visible !== "boolean") return null;
        if (!visible) return false;
        const rect = element.getBoundingClientRect();
        if (
          ![
            innerWidth,
            innerHeight,
            rect.left,
            rect.top,
            rect.right,
            rect.bottom,
            rect.width,
            rect.height,
          ].every(Number.isFinite) ||
          innerWidth <= 0 ||
          innerHeight <= 0
        )
          return null;
        // The pinned waitForDisplayed defaults to withinViewport:false.
        // Keep an off-screen box distinct from CSS-hidden or missing content.
        return rect.width > 0 && rect.height > 0;
      } catch {
        return null;
      }
    };
    const contents = document.querySelectorAll('[data-add-project-content="true"]');
    const content = contents.length === 1 ? contents[0]! : null;
    facts.modalPresent = contents.length > 0;
    facts.modalDisplayed = displayed(
      content?.closest('[data-slot="dialog-popup"][role="dialog"]') ?? null,
    );
    const paths = content?.querySelectorAll("#add-project-host-path");
    const path = paths?.length === 1 && paths[0] instanceof HTMLInputElement ? paths[0] : null;
    facts.pathPresent = (paths?.length ?? 0) > 0;
    facts.pathDisabled = path?.disabled ?? null;
    const form = path?.form;
    const submits =
      form && content?.contains(form) ? form.querySelectorAll('button[type="submit"]') : null;
    const submit =
      submits?.length === 1 && submits[0] instanceof HTMLButtonElement ? submits[0] : null;
    facts.submitPresent = (submits?.length ?? 0) > 0;
    facts.submitDisabled = submit?.disabled ?? null;
    const surface = '[data-center-surface-host][data-visible="true"]';
    const composers = document.querySelectorAll(surface + ' [data-testid="composer-editor"]');
    facts.composerPresent = composers.length > 0;
    facts.composerDisplayed = displayed(composers.length === 1 ? composers[0]! : null);
    const cards = document.querySelectorAll('button[data-testid^="primary-card-button-"]');
    facts.primaryCardCount = cards.length === 0 ? "none" : cards.length === 1 ? "one" : "multiple";
    facts.primaryCardSelected = Array.from(cards).some(
      (card) => card.getAttribute("aria-current") === "page",
    );
    if (facts.modalDisplayed === true && content) {
      const alert = content.querySelector('[role="alert"]');
      if (displayed(alert) === true) {
        const text = alert!.textContent?.trim();
        facts.errorCategory =
          text === "Host platform information is still loading."
            ? "host-loading"
            : [
                  "Enter a project path.",
                  "Windows-style paths are only supported on Windows.",
                  "Enter an absolute or home-relative path.",
                ].includes(text ?? "")
              ? "path-invalid"
              : "other";
      } else {
        const status = content.querySelector('[role="status"]');
        if (
          displayed(status) === true &&
          status!.textContent?.trim() === "Waiting for host information…"
        )
          facts.errorCategory = "host-loading";
      }
    }
    if (facts.errorCategory === null) {
      for (const title of document.querySelectorAll(surface + ' [data-slot="alert-title"]')) {
        if (displayed(title) === true && title.textContent?.trim() === "Workspace unavailable") {
          facts.errorCategory = "workspace-unavailable";
          break;
        }
      }
    }
    if (facts.errorCategory === null) {
      for (const title of document.querySelectorAll('[data-slot="toast-title"]')) {
        if (
          displayed(title) === true &&
          ["Failed to add project", "Failed to open project"].includes(
            title.textContent?.trim() ?? "",
          )
        ) {
          facts.errorCategory = "other";
          break;
        }
      }
    }
    return facts;
  } catch {
    return null;
  }
}
