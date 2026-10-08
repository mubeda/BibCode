// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Only closed capture receipts are used here.
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  readBrowserFollowupWitness,
  browserFollowupRows,
  browserFollowupScenes,
  browserFollowupFacts,
  validateBrowserFollowupWitness,
  projectBrowserFollowupCapture,
  validateBrowserFollowupJoins,
  admitBrowserFollowupObservation,
  type BrowserFollowupObservation,
} from "./release-visual-browser-followups.ts";
const witness = (scene: (typeof browserFollowupScenes)[number]) =>
  Object.fromEntries(browserFollowupFacts(scene).map((key) => [key, true]));
const capture = (scene: (typeof browserFollowupScenes)[number], theme: "light" | "dark") => ({
  scene,
  theme,
  file: scene + "-" + theme + ".png",
  width: 1280,
  height: 960,
  nonBlank: true,
  sha256: "a".repeat(64),
  witness: witness(scene),
});
it("closes observation packets before WebDriver can serialize private fields or getters", () => {
  const input = {
    scene: "hosted-pair-confirm",
    theme: "light",
    origin: "http://127.0.0.1:4893",
    environmentId: "local",
    threadId: "owned-thread",
    projectId: "owned-project",
    terminalId: "term-1",
    terminalLabel: "Terminal 1",
    environmentLabel: "Local",
    hostedHost: "127.0.0.1:4887",
  };
  expect(admitBrowserFollowupObservation(input).scene).toBe("hosted-pair-confirm");
  expect(() =>
    admitBrowserFollowupObservation({ ...input, token: "inert-private-value" }),
  ).toThrow();
  const getter = { ...input };
  Object.defineProperty(getter, "theme", {
    enumerable: true,
    get: () => {
      throw new Error("Getter must not execute");
    },
  });
  expect(() => admitBrowserFollowupObservation(getter)).toThrow();
  const captures = (["light", "dark"] as const).flatMap((theme) =>
    browserFollowupScenes.map((scene) => projectBrowserFollowupCapture(capture(scene, theme))),
  );
  expect(() =>
    validateBrowserFollowupJoins(
      captures.map((value, index) =>
        index === 0 ? { ...value, private: "inert-private-value" } : value,
      ),
    ),
  ).toThrow();
});
it("keeps six original rows and twelve base names with two finite Source Control supplements", () => {
  expect(browserFollowupRows).toHaveLength(6);
  expect(browserFollowupScenes).toHaveLength(7);
  const captures = (["light", "dark"] as const).flatMap((theme) =>
    browserFollowupScenes.map((scene) => projectBrowserFollowupCapture(capture(scene, theme))),
  );
  expect(captures.filter((value) => value.baseOriginal)).toHaveLength(12);
  expect(() => validateBrowserFollowupJoins(captures)).not.toThrow();
});
it.each([
  "false",
  "extra",
  "getter",
  "missing",
  "wrong-row",
  "wrong-size",
  "blank",
  "duplicate",
  "missing-original",
])("refuses %s admission without retaining a success receipt", (mode) => {
  const scene = "hosted-pair-confirm";
  const value = capture(scene, "light");
  if (mode === "false") value.witness.credentialAbsent = false as never;
  if (mode === "extra") Object.assign(value.witness, { private: true });
  if (mode === "getter")
    Object.defineProperty(value.witness, "credentialAbsent", { get: () => true });
  if (mode === "missing") delete value.witness.credentialAbsent;
  if (["false", "extra", "getter", "missing"].includes(mode))
    expect(() => validateBrowserFollowupWitness(scene, value.witness)).toThrow();
  else if (mode === "wrong-row")
    expect(() => projectBrowserFollowupCapture({ ...value, scene: "new-row" })).toThrow();
  else if (mode === "wrong-size")
    expect(() => projectBrowserFollowupCapture({ ...value, width: 1279 })).toThrow();
  else if (mode === "blank")
    expect(() => projectBrowserFollowupCapture({ ...value, nonBlank: false })).toThrow();
  else {
    const all = (["light", "dark"] as const).flatMap((theme) =>
      browserFollowupScenes.map((scene) => projectBrowserFollowupCapture(capture(scene, theme))),
    );
    expect(() =>
      validateBrowserFollowupJoins(mode === "duplicate" ? [...all, all[0]!] : all.slice(1)),
    ).toThrow();
  }
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
it.each(["dialog", "alertdialog"])(
  "refuses active %s while ignoring only explicitly unavailable ancestry",
  (role) => {
    vi.stubGlobal("location", {
      origin: "http://127.0.0.1:4885",
      pathname: "/local/owned-thread",
      search: "",
      hash: "",
    });
    const input: BrowserFollowupObservation = {
      scene: "chat-staged-attachment" as const,
      theme: "light" as const,
      origin: "http://127.0.0.1:4885",
      environmentId: "local",
      threadId: "owned-thread",
      projectId: "owned-project",
      terminalId: "owned-terminal",
      environmentLabel: "Local",
      terminalLabel: "Terminal 1",
      hostedHost: "127.0.0.1:4887",
    };
    const parent = document.createElement("div"),
      modal = document.createElement("div");
    modal.setAttribute("role", role);
    parent.append(modal);
    document.body.append(parent);
    expect(readBrowserFollowupWitness(input)?.unrelatedModalAbsent).toBe(false);
    for (const node of [parent, modal])
      for (const attribute of ["hidden", "inert", "aria-hidden"]) {
        node.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
        expect(readBrowserFollowupWitness(input)?.unrelatedModalAbsent).toBe(true);
        node.removeAttribute(attribute);
        expect(readBrowserFollowupWitness(input)?.unrelatedModalAbsent).toBe(false);
      }
    modal.setAttribute("data-closed", "");
    expect(readBrowserFollowupWitness(input)?.unrelatedModalAbsent).toBe(false);
    modal.removeAttribute("data-closed");
    modal.style.cssText = "position:absolute;left:-100px;top:-100px;opacity:0";
    parent.style.overflow = "hidden";
    expect(readBrowserFollowupWitness(input)?.unrelatedModalAbsent).toBe(false);
  },
);
