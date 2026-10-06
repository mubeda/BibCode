import type {
  NativeFollowupScene,
  NativeFollowupTheme,
} from "./release-visual-native-followups.ts";
/** Executed in the real packaged WebView. It only reads current public DOM and preferences. */
export function readNativeFollowupDom(input: {
  scene: NativeFollowupScene;
  theme: NativeFollowupTheme;
  privateRoots: readonly string[];
  draft: string;
  distro: string | null;
}) {
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect(),
      css = getComputedStyle(node);
    return (
      rect.width > 0 && rect.height > 0 && css.display !== "none" && css.visibility !== "hidden"
    );
  };
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(visible);
  const text = document.body.textContent ?? "";
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const main = dialogs.length === 1 ? dialogs[0] : null,
    dialogText = main?.textContent ?? "";
  const named = (label: string) =>
    buttons.filter((button) => main?.contains(button) && button.textContent?.trim() === label);
  const common = {
    themeMatched: document.documentElement.classList.contains("dark") === (input.theme === "dark"),
    publicEntryMatched: false,
    workPreserved: true,
    pixelsSafe:
      !input.privateRoots.some((root) => root.length > 1 && text.includes(root)) &&
      !/Bearer\s+\S+|-----BEGIN .*PRIVATE KEY|bc_pair_[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{25,}/.test(
        text,
      ) &&
      ![...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].some(
        (node) => visible(node) && node.value.length > 0,
      ),
  };
  if (input.scene === "native-menu-theme")
    return {
      ...common,
      publicEntryMatched:
        document.querySelectorAll('[data-testid^="primary-card-button-"]').length > 0,
      systemPreference: [null, "system"].includes(localStorage.getItem("bibcode:theme")),
      nativeMenuOriginal: ![...document.querySelectorAll('[role="menu"]')].some(visible),
    };
  if (input.scene === "native-update-protection")
    return {
      ...common,
      publicEntryMatched: main !== null && dialogText.includes("Protect projects before updating"),
      protectionDefault:
        named("Protect projects and install").length === 1 &&
        !named("Protect projects and install")[0]!.disabled,
      cancelAvailable: named("Cancel").length === 1 && !named("Cancel")[0]!.disabled,
      unsafeBypassAbsent:
        named("Install without backup").length === 0 &&
        document.querySelector('[aria-label="Acknowledge update without backup"]') === null,
    };
  if (input.scene === "native-update-recovery") {
    const restart = named("Restart server"),
      retry = named("Retry installation"),
      id = retry[0]?.getAttribute("aria-describedby"),
      reason = id ? document.getElementById(id) : null;
    return {
      ...common,
      publicEntryMatched: main !== null && dialogText.includes("Update not installed"),
      restartActionAvailable: restart.length === 1 && !restart[0]!.disabled,
      retryExplained:
        retry.length === 1 &&
        retry[0]!.disabled &&
        reason !== null &&
        visible(reason) &&
        reason.textContent?.trim() === "Restart the server before retrying the installation.",
    };
  }
  if (input.scene === "native-wsl-local") {
    const control = document.querySelector('[aria-label="WSL backend"]'),
      only = document.querySelector('[aria-label="Run WSL only"]');
    return {
      ...common,
      publicEntryMatched: location.hash.startsWith("#/settings/local-environment"),
      localSettings:
        text.includes("Local environment") &&
        control !== null &&
        visible(control) &&
        input.distro !== null &&
        control.textContent?.trim() === input.distro &&
        only !== null &&
        visible(only) &&
        !text.includes("WSL backend unavailable") &&
        !text.includes("WSL backend state unavailable"),
    };
  }
  return {
    ...common,
    publicEntryMatched: false,
    deviceToolbar: document.querySelector('[aria-label="Browser device toolbar"]') !== null,
    publicPicker: buttons.some(
      (button) => button.getAttribute("aria-label") === "Annotate preview",
    ),
    elementContext: false,
    annotationCard: document.querySelector('[aria-label="Remove preview annotation"]') !== null,
  };
}
