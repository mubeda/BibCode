// @effect-diagnostics nodeBuiltinImport:off - Closed Node witness validation refuses untrusted proxies before reflection.
import * as NodeUtil from "node:util";
export interface NativeSharingDomFacts {
  domRouteMatched: boolean | null;
  domThemeMatched: boolean | null;
  domShareSelected: boolean | null;
  domControlsMatched: boolean | null;
  domExpectedState: boolean | null;
  domCredentialAbsent: boolean | null;
  domTargetInView: boolean | null;
}
/** Attribution only: this does not change DOM admission or create a second renderer read. */
export function projectNativeSharingDomFacts(value: unknown): NativeSharingDomFacts {
  const keys = [
    "routeMatched",
    "themeMatched",
    "shareSelected",
    "controlsMatched",
    "expectedState",
    "credentialAbsent",
    "targetInView",
  ];
  const names = [
    "domRouteMatched",
    "domThemeMatched",
    "domShareSelected",
    "domControlsMatched",
    "domExpectedState",
    "domCredentialAbsent",
    "domTargetInView",
  ];
  const absent = () =>
    Object.freeze(
      Object.fromEntries(names.map((key) => [key, null])),
    ) as unknown as NativeSharingDomFacts;
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      NodeUtil.types.isProxy(value)
    )
      return absent();
    const own = Reflect.ownKeys(value);
    if (
      own.length !== keys.length ||
      !own.every((key) => typeof key === "string" && keys.includes(key))
    )
      return absent();
    const result: Record<string, boolean> = {};
    for (let index = 0; index < keys.length; index++) {
      const field = Object.getOwnPropertyDescriptor(value, keys[index]!);
      if (!field?.enumerable || !Object.hasOwn(field, "value") || typeof field.value !== "boolean")
        return absent();
      result[names[index]!] = field.value;
    }
    return Object.freeze(result) as unknown as NativeSharingDomFacts;
  } catch {
    return absent();
  }
}
export interface NativeSharingDomInput {
  readonly scene: "native-share-no-route" | "native-share-refresh";
  readonly theme: "light" | "dark";
  readonly origin: string;
}
export function readNativeSharingDom(input: NativeSharingDomInput): unknown {
  try {
    const url = new URL(location.href);
    if (
      input.origin !== "tauri://localhost" ||
      url.protocol !== "tauri:" ||
      url.hostname !== "localhost" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "#/settings/remote-servers" ||
      location.pathname !== "/" ||
      location.search !== "" ||
      location.hash !== "#/settings/remote-servers" ||
      !["light", "dark"].includes(input.theme) ||
      !["native-share-no-route", "native-share-refresh"].includes(input.scene)
    )
      return null;
    const visible = (node: Element | null): node is HTMLElement => {
      if (!node) return false;
      const box = node.getBoundingClientRect();
      if (
        ![box.left, box.top, box.width, box.height, box.right, box.bottom].every(Number.isFinite) ||
        box.width <= 0 ||
        box.height <= 0
      )
        return false;
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number.parseFloat(style.opacity) === 0
        )
          return false;
      }
      return true;
    };
    const all = (selector: string, root: ParentNode = document) =>
      Array.from(root.querySelectorAll(selector)).filter(visible);
    const one = (selector: string, root: ParentNode = document) => {
      const values = all(selector, root);
      return values.length === 1 ? values[0]! : null;
    };
    const tabs = all('[role="tab"][aria-selected="true"]').filter(
      (node) => node.textContent?.trim() === "Share this host",
    );
    const tab = tabs.length === 1 ? tabs[0]! : null;
    const id = tab?.getAttribute("aria-controls");
    const panel = id ? document.getElementById(id) : null;
    if (!visible(panel) || panel.getAttribute("role") !== "tabpanel") return null;
    const refresh = one('button[aria-label="Refresh addresses"]', panel),
      address = one('select[aria-label="Share address"]', panel),
      radio = one('[role="radio"][aria-label="Another device"][aria-checked="true"]', panel);
    const generators = all("button", panel).filter(
        (node) => node.textContent?.trim() === "Generate pairing offer",
      ),
      generate = generators.length === 1 ? generators[0]! : null;
    const options = address instanceof HTMLSelectElement ? Array.from(address.options) : [];
    const reason = all("p", panel).some(
      (node) =>
        node.textContent?.includes("this computer has none right now.") &&
        node.textContent?.includes("then Refresh."),
    );
    const credentialAbsent =
      document.querySelector(
        '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
      ) === null &&
      !Array.from(document.querySelectorAll("label,h3,h4,p")).some((node) =>
        ["Pairing code", "Deep link", "Browser URL"].includes(node.textContent?.trim() ?? ""),
      );
    const box = panel.getBoundingClientRect(),
      hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      routeMatched: true,
      themeMatched:
        document.documentElement.classList.contains("dark") === (input.theme === "dark"),
      shareSelected: tab !== null && radio !== null,
      controlsMatched:
        refresh instanceof HTMLButtonElement &&
        !refresh.disabled &&
        generate instanceof HTMLButtonElement &&
        address instanceof HTMLSelectElement,
      expectedState:
        input.scene === "native-share-no-route"
          ? options.length === 0 &&
            generate instanceof HTMLButtonElement &&
            generate.disabled &&
            reason
          : options.length === 1 &&
            options[0]?.value === "auto-lan" &&
            address instanceof HTMLSelectElement &&
            address.value === "auto-lan" &&
            generate instanceof HTMLButtonElement &&
            !generate.disabled &&
            !reason,
      credentialAbsent:
        credentialAbsent &&
        document.getElementById("boot-shell") === null &&
        document.querySelector("vite-error-overlay") === null,
      targetInView:
        innerWidth === 1280 &&
        innerHeight === 960 &&
        box.left >= 0 &&
        box.top >= 0 &&
        box.right <= innerWidth &&
        box.bottom <= innerHeight &&
        hit !== null &&
        (hit === panel || panel.contains(hit)),
    };
  } catch {
    return null;
  }
}
export function validateNativeSharingDom(value: unknown): Record<string, true> {
  const refused = () => new Error("Owned native sharing DOM refused.");
  if (!value || typeof value !== "object" || Array.isArray(value) || NodeUtil.types.isProxy(value))
    throw refused();
  const keys = [
    "routeMatched",
    "themeMatched",
    "shareSelected",
    "controlsMatched",
    "expectedState",
    "credentialAbsent",
    "targetInView",
  ];
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    !own.every((key) => typeof key === "string" && keys.includes(key))
  )
    throw refused();
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value") || field.value !== true)
      throw refused();
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, true] as const)));
}
