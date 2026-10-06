export interface DeliveryImportModelBinding {
  environmentId: string;
  projectId: string;
  threadId: string;
}
export type DeliveryImportObservationInput =
  | string
  | { origin: string; binding: DeliveryImportModelBinding | null };
export interface DeliveryImportModelFacts {
  expectedTriggerLabel: boolean | null;
  triggerDisabled: boolean | null;
  desiredOptionSelected: boolean | null;
  desiredOptionDisabled: boolean | null;
}
export interface DeliveryImportObservation {
  safeLocation: boolean | null;
  route:
    | "pair"
    | "root"
    | "workspace"
    | "settings-general"
    | "settings-remote-servers"
    | "other"
    | null;
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
  modelFacts?: DeliveryImportModelFacts | null;
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
    const ownKeys = Reflect.ownKeys(input);
    const keys = [...booleans, "route", "primaryCardCount", "errorCategory"];
    if (ownKeys.includes("modelFacts")) keys.push("modelFacts");
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
    if (keys.includes("modelFacts") && value.modelFacts !== null) {
      if (
        value.safeLocation !== true ||
        value.route !== "workspace" ||
        value.modalPresent !== false ||
        value.composerPresent !== true ||
        value.primaryCardSelected !== true ||
        value.errorCategory !== null
      )
        return null;
      const model = value.modelFacts;
      if (model === null || typeof model !== "object" || Array.isArray(model)) return null;
      const modelKeys = [
        "expectedTriggerLabel",
        "triggerDisabled",
        "desiredOptionSelected",
        "desiredOptionDisabled",
      ];
      const actualKeys = Reflect.ownKeys(model);
      if (
        actualKeys.length !== modelKeys.length ||
        !actualKeys.every((key) => typeof key === "string" && modelKeys.includes(key))
      )
        return null;
      const projected: Record<string, boolean | null> = {};
      for (const key of modelKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(model, key);
        if (
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, "value") ||
          !(descriptor.value === null || typeof descriptor.value === "boolean")
        )
          return null;
        projected[key] = descriptor.value;
      }
      value.modelFacts = projected;
    }
    if (
      !booleans.every((key) => value[key] === null || typeof value[key] === "boolean") ||
      !choice("route", [
        "pair",
        "root",
        "workspace",
        "settings-general",
        "settings-remote-servers",
        "other",
      ]) ||
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
  input: DeliveryImportObservationInput,
): DeliveryImportObservation | null {
  try {
    let expectedOrigin: unknown = input;
    let binding: DeliveryImportModelBinding | null | undefined;
    if (typeof input !== "string") {
      if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
      const keys = Reflect.ownKeys(input);
      if (keys.length !== 2 || !keys.every((key) => key === "origin" || key === "binding"))
        return null;
      const originDescriptor = Object.getOwnPropertyDescriptor(input, "origin");
      const bindingDescriptor = Object.getOwnPropertyDescriptor(input, "binding");
      if (
        !originDescriptor?.enumerable ||
        !bindingDescriptor?.enumerable ||
        !Object.hasOwn(originDescriptor, "value") ||
        !Object.hasOwn(bindingDescriptor, "value")
      )
        return null;
      expectedOrigin = originDescriptor.value;
      binding = bindingDescriptor.value;
    }
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
    if (binding !== undefined) facts.modelFacts = null;
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
            : location.pathname === "/settings/general"
              ? "settings-general"
              : location.pathname === "/settings/remote-servers"
                ? "settings-remote-servers"
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
    if (
      binding !== undefined &&
      binding !== null &&
      facts.modalPresent === false &&
      facts.errorCategory === null
    ) {
      if (
        document.querySelector(
          '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
        ) !== null
      )
        return facts;
      const bindingKeys = ["environmentId", "projectId", "threadId"];
      const ownKeys = Reflect.ownKeys(binding);
      if (
        ownKeys.length !== bindingKeys.length ||
        !ownKeys.every((key) => typeof key === "string" && bindingKeys.includes(key))
      )
        return facts;
      const bound: Record<string, unknown> = {};
      for (const key of bindingKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(binding, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return facts;
        bound[key] = descriptor.value;
      }
      if (
        bound.environmentId !== "local" ||
        ![bound.projectId, bound.threadId].every(
          (id) => typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id),
        ) ||
        location.pathname !== "/local/" + bound.threadId
      )
        return facts;
      const selectedCards = document.querySelectorAll(
        'button[data-testid^="primary-card-button-"][aria-current="page"]',
      );
      const rails = document.querySelectorAll(
        '[data-testid="environment-rail-local"][aria-checked="true"] [data-status="connected"]',
      );
      const hosts = document.querySelectorAll(
        '[data-center-surface-host="chat:host"][data-visible="true"]',
      );
      if (
        selectedCards.length !== 1 ||
        selectedCards[0]!.getAttribute("data-testid") !==
          "primary-card-button-" + bound.projectId ||
        displayed(selectedCards[0]!) !== true ||
        rails.length !== 1 ||
        hosts.length !== 1 ||
        displayed(hosts[0]!) !== true
      )
        return facts;
      const forms = hosts[0]!.querySelectorAll('[data-chat-composer-form="true"]');
      const ownedComposers = hosts[0]!.querySelectorAll('[data-testid="composer-editor"]');
      if (
        forms.length !== 1 ||
        displayed(forms[0]!) !== true ||
        ownedComposers.length !== 1 ||
        !forms[0]!.contains(ownedComposers[0]!) ||
        displayed(ownedComposers[0]!) !== true
      )
        return facts;
      const triggers = forms[0]!.querySelectorAll('button[data-chat-provider-model-picker="true"]');
      const trigger =
        triggers.length === 1 && triggers[0] instanceof HTMLButtonElement ? triggers[0] : null;
      if (!trigger || displayed(trigger) !== true) return facts;
      const booleanAttribute = (element: Element, name: string): boolean | null => {
        const value = element.getAttribute(name);
        return value === "true" ? true : value === "false" ? false : null;
      };
      const modelFacts: DeliveryImportModelFacts = {
        expectedTriggerLabel: trigger.getAttribute("aria-label") === "Claude · Opus 5",
        triggerDisabled: trigger.disabled || booleanAttribute(trigger, "aria-disabled") === true,
        desiredOptionSelected: null,
        desiredOptionDisabled: null,
      };
      if (trigger.getAttribute("aria-expanded") === "true") {
        const control = trigger.getAttribute("aria-controls");
        const popups = Array.from(document.querySelectorAll('[data-slot="popover-popup"]')).filter(
          (popup) =>
            control !== null &&
            control !== "" &&
            popup.getAttribute("id") === control &&
            displayed(popup) === true,
        );
        const contents =
          popups.length === 1
            ? popups[0]!.querySelectorAll('[data-model-picker-content="true"]')
            : null;
        const options =
          contents?.length === 1 && displayed(contents[0]!) === true
            ? contents[0]!.querySelectorAll(
                '[role="option"][data-model-picker-instance-id="claudeAgent"][data-model-picker-model-slug="opus"]',
              )
            : null;
        if (options?.length === 1 && displayed(options[0]!) === true) {
          const option = options[0]!;
          modelFacts.desiredOptionSelected =
            booleanAttribute(option, "aria-selected") ??
            (option.hasAttribute("data-selected") ? true : null);
          modelFacts.desiredOptionDisabled =
            booleanAttribute(option, "aria-disabled") ??
            (option.hasAttribute("data-disabled") ? true : null);
        }
      }
      facts.modelFacts = modelFacts;
    }
    return facts;
  } catch {
    return null;
  }
}
