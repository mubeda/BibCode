import { ProviderDriverKind, type ServerProviderModel } from "@bibcode/contracts";
import { createModelCapabilities } from "@bibcode/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { getProviderModelCapabilities } from "./providerModels";

describe("getProviderModelCapabilities", () => {
  it("uses a directly selected dynamic provider model before alias normalization", () => {
    const capabilities = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    });
    const models: ReadonlyArray<ServerProviderModel> = [
      { slug: "opus", name: "Opus", isCustom: false, capabilities },
    ];

    expect(
      getProviderModelCapabilities(models, "opus", ProviderDriverKind.make("claudeAgent")),
    ).toBe(capabilities);
  });
});
