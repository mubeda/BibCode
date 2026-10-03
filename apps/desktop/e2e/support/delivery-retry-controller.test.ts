import { describe, expect, it } from "vite-plus/test";
import { deliveryConfiguration } from "../qualify-delivery-retry.ts";
import { deliveryScenes, deliveryThemes } from "./delivery-retry-evidence.ts";

const environment = {
  CI: "true",
  BIBCODE_UPLOAD_SOURCE: "a".repeat(40),
  BIBCODE_UPLOAD_NETNS: "net:[owned]",
  BIBCODE_UPLOAD_FIXTURE: "/owned/fixture",
  BIBCODE_UPLOAD_EVIDENCE: "/owned/evidence",
  BIBCODE_UPLOAD_SERVER: "/owned/bibcode",
  BIBCODE_DELIVERY_UI_WEB: "/owned/web",
  BIBCODE_UPLOAD_CHROME: "/owned/chrome",
  BIBCODE_UPLOAD_DRIVER: "/owned/driver",
};

describe("delivery controller admission", () => {
  it("consumes only explicit owned inputs and has a finite six-image manifest", () => {
    expect(deliveryConfiguration(environment, () => "net:[owned]")).toEqual({
      source: "a".repeat(40),
      fixture: "/owned/fixture",
      evidence: "/owned/evidence",
      binary: "/owned/bibcode",
      assets: "/owned/web",
      chrome: "/owned/chrome",
      driver: "/owned/driver",
    });
    expect(
      deliveryThemes.flatMap((theme) => deliveryScenes.map((scene) => `${scene}-${theme}.png`)),
    ).toEqual([
      "uncertain-light.png",
      "retry-cancelled-light.png",
      "new-conversation-light.png",
      "uncertain-dark.png",
      "retry-cancelled-dark.png",
      "new-conversation-dark.png",
    ]);
  });
  it.each(Object.keys(environment))("refuses missing %s before namespace access", (key) => {
    const missing: NodeJS.ProcessEnv = { ...environment };
    delete missing[key];
    let reads = 0;
    expect(() =>
      deliveryConfiguration(missing, () => {
        reads += 1;
        return "net:[owned]";
      }),
    ).toThrow(/configuration refused/);
    expect(reads).toBe(0);
  });
  it("refuses a different or unavailable namespace with closed errors", () => {
    expect(() => deliveryConfiguration(environment, () => "net:[foreign]")).toThrow(
      "Owned delivery qualification namespace refused.",
    );
    expect(() =>
      deliveryConfiguration(environment, () => {
        throw new Error("private-namespace-path");
      }),
    ).toThrow("Owned delivery qualification namespace refused.");
  });
});
