// @effect-diagnostics nodeBuiltinImport:off - Test-owned PNG fixtures and private receipt data.
import * as NodeZlib from "node:zlib";
import { expect, it } from "vite-plus/test";
import {
  remoteUiScenes,
  screenshotName,
  validateCaptureWitness,
  countInstallRequests,
  inspectScreenshot,
  remoteUiPlan,
  projectRemoteUiSetupObservation,
  projectRemoteUiCheckAgainObservation,
  projectRemoteUiSuccessRemovalObservation,
} from "./remote-ui-evidence.ts";

it("projects only closed setup facts and preserves unknown versus absent observations", () => {
  for (const input of [undefined, null, [], "private-credential"])
    expect(projectRemoteUiSetupObservation(input)).toBeNull();
  const known = {
    route: "pair",
    readyState: "complete",
    tokenPresent: true,
    submitPresent: true,
    submitDisabled: false,
    sidebarPresent: false,
    importPathPresent: false,
    importBusy: false,
    importError: "host-loading",
    themeControlPresent: false,
    pairingPendingPresent: false,
    pairingError: "unknown",
  };
  expect(projectRemoteUiSetupObservation(known)).toEqual(known);
  const projected = projectRemoteUiSetupObservation({
    ...known,
    route: "http://private/secret",
    pairingError: "private-credential",
    importError: "private-import-path",
    importBusy: "false",
    tokenPresent: "false",
    submitPresent: undefined,
    submitDisabled: 0,
    rawText: "private-payload",
    cookie: "private-cookie",
  });
  expect(projected).toMatchObject({
    route: null,
    pairingError: null,
    importError: null,
    importBusy: null,
    tokenPresent: null,
    submitPresent: null,
    submitDisabled: null,
    sidebarPresent: false,
  });
  expect(JSON.stringify(projected)).not.toContain("private-");
  expect(Object.values(projectRemoteUiSetupObservation({})!)).toEqual(Array(12).fill(null));
});

it("defaults to an honestly partial core and requires an explicit full matrix selection", () => {
  const core = remoteUiPlan(undefined);
  expect(core.selection).toBe("core");
  expect(core.flows).toEqual(["success", "failure", "manual"]);
  expect(core.scenes).not.toContain("not-back");
  expect(core.pendingCases).toEqual([
    "wrong-version",
    "real-no-return-deadline",
    "bounded-parallel",
    "actual-reload",
  ]);
  const full = remoteUiPlan("full");
  expect(full.flows).toEqual([
    "success",
    "failure",
    "restart-failures",
    "queued",
    "manual",
    "reload",
  ]);
  expect(full.scenes).toEqual(remoteUiScenes);
  expect(full.pendingCases).toEqual([]);
  expect(full.scenes).toEqual(expect.arrayContaining([...core.scenes]));
  for (const value of ["", "FULL", "private-secret", "core --override"])
    expect(() => remoteUiPlan(value)).toThrow("Unknown remote UI selection.");
});

it("has finite names for both themes and refuses arbitrary artifact paths", () => {
  const names = remoteUiScenes.flatMap((scene) => [
    screenshotName("light", scene),
    screenshotName("dark", scene),
  ]);
  expect(new Set(names).size).toBe(remoteUiScenes.length * 2);
  expect(names.every((name) => /^[a-z-]+-(light|dark)\.png$/.test(name))).toBe(true);
  expect(() => screenshotName("private" as never, "../secret" as never)).toThrow();
});

it("requires actual selected, themed, visible, safe UI evidence before capture", () => {
  const witness = {
    themeMatched: true,
    selectedMatched: true,
    expectedTextMatched: true,
    targetInView: true,
    credentialAbsent: true,
    bootShellAbsent: true,
  };
  expect(validateCaptureWitness(witness)).toEqual(witness);
  for (const key of Object.keys(witness)) {
    for (const value of [false, null, "true", undefined])
      expect(() => validateCaptureWitness({ ...witness, [key]: value })).toThrow();
  }
  expect(() => validateCaptureWitness({ ...witness, credential: "private-secret" })).toThrow();
});

it("counts only complete private requester receipts without returning labels or session prefixes", () => {
  expect(
    countInstallRequests(
      "install requested label=private-name session=private-prefix\nnoise\ninstall requested label=x session=y\n",
    ),
  ).toBe(2);
  expect(countInstallRequests("install requested label=partial session=x")).toBe(0);
  expect(() => countInstallRequests("x".repeat(65537))).toThrow();
});

function png(blank: boolean, filter = 0, channels = 3) {
  const chunk = (name: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(name, 4);
    data.copy(bytes, 8);
    bytes.writeUInt32BE(NodeZlib.crc32(bytes.subarray(4, data.length + 8)), data.length + 8);
    return bytes;
  };
  const width = 640,
    height = 480;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 3 ? 2 : 6;
  const stride = width * channels;
  const rows = Buffer.alloc((stride + 1) * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const original = Buffer.alloc(stride, 255);
    if (!blank) {
      for (let x = 0; x < width / 3; x++) original.fill(20, x * channels, x * channels + 3);
    }
    rows[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const left = x < channels ? 0 : original[x - channels]!;
      const above = previous[x]!;
      const corner = x < channels ? 0 : previous[x - channels]!;
      const estimate = left + above - corner;
      const ranked = [left, above, corner]
        .map((value, index) => ({ value, index, distance: Math.abs(estimate - value) }))
        .sort((a, b) => a.distance - b.distance || a.index - b.index);
      const prediction = [0, left, above, Math.floor((left + above) / 2), ranked[0]!.value][
        filter
      ]!;
      rows[y * (stride + 1) + 1 + x] = (original[x]! - prediction + 256) % 256;
    }
    previous = original;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

it("inspects original PNG bytes, rejects blank/malformed images and never rewrites them", () => {
  const image = png(false),
    before = Buffer.from(image);
  expect(inspectScreenshot(image)).toMatchObject({ width: 640, height: 480, nonBlank: true });
  expect(image).toEqual(before);
  expect(() => inspectScreenshot(png(true))).toThrow();
  expect(() => inspectScreenshot(Buffer.from("private-data"))).toThrow();
  const corrupt = Buffer.from(image);
  corrupt[40] = corrupt[40]! ^ 1;
  expect(() => inspectScreenshot(corrupt)).toThrow();
});

it.each([1, 2, 3, 4])(
  "accepts real RGB/RGBA PNG filter %i while still refusing uniform pixels",
  (filter) => {
    for (const channels of [3, 4]) {
      expect(inspectScreenshot(png(false, filter, channels))).toMatchObject({
        nonBlank: true,
        width: 640,
        height: 480,
      });
      expect(() => inspectScreenshot(png(true, filter, channels))).toThrow("blank");
    }
  },
);

it("decodes only closed Check again row fields and quarantines unsafe or ambiguous scope", () => {
  for (const input of [undefined, null, [], "private-credential"])
    expect(projectRemoteUiCheckAgainObservation(input)).toBeNull();
  const known = {
    safeLocation: true,
    rowCount: "one",
    controlCount: "one",
    controlLabel: "check-again",
    controlVisible: true,
    controlDisabled: false,
    hitTarget: "toast",
    updateActionPresent: false,
    badgeVariant: "error",
    dismissPresent: false,
  };
  expect(projectRemoteUiCheckAgainObservation(known)).toEqual(known);
  expect(
    projectRemoteUiCheckAgainObservation({
      ...known,
      safeLocation: false,
      extra: "private-credential",
    }),
  ).toEqual({
    ...Object.fromEntries(Object.keys(known).map((key) => [key, null])),
    safeLocation: false,
  });
  for (const field of Object.keys(known)) {
    const output = projectRemoteUiCheckAgainObservation({
      ...known,
      [field]: "private-credential /private/path http://private-host",
      rawText: "private-credential",
      input: "private-credential",
    });
    expect(JSON.stringify(output)).not.toContain("private-");
    expect(Object.keys(output!)).toEqual(Object.keys(known));
    expect(output![field as keyof typeof output]).toBeNull();
  }
  for (const value of ["none", "multiple", null, "private-credential"]) {
    const output = projectRemoteUiCheckAgainObservation({ ...known, rowCount: value });
    expect(Object.values(output!).slice(2)).toEqual(Array(8).fill(null));
  }
});

it.each(["accessor", "throwing-accessor", "nonenumerable", "inherited"])(
  "admits only own enumerable data facts in the actual projection: %s",
  (kind) => {
    const known = {
      safeLocation: true,
      rowCount: "one",
      controlCount: "one",
      controlLabel: "check-again",
      controlVisible: true,
      controlDisabled: false,
      hitTarget: "toast",
      updateActionPresent: false,
      badgeVariant: "error",
      dismissPresent: false,
    };
    for (const field of Object.keys(known) as Array<keyof typeof known>) {
      let reads = 0;
      const input = Object.assign(
        kind === "inherited" ? Object.create({ [field]: known[field] }) : {},
        known,
      );
      delete input[field];
      if (kind !== "inherited")
        Object.defineProperty(
          input,
          field,
          kind === "nonenumerable"
            ? {
                enumerable: false,
                value: known[field],
              }
            : {
                enumerable: true,
                get() {
                  reads++;
                  if (kind === "throwing-accessor") throw new Error("private getter/error");
                  return known[field];
                },
              },
        );
      let output: ReturnType<typeof projectRemoteUiCheckAgainObservation>;
      expect(() => {
        output = projectRemoteUiCheckAgainObservation(input);
      }).not.toThrow();
      if (kind === "inherited") expect(output![field]).toBeNull();
      else expect(output!).toBeNull();
      expect(reads).toBe(0);
    }
  },
);

it("locally refuses descriptor inspection failures and keeps unknown accessors unread", () => {
  const known = {
    safeLocation: true,
    rowCount: "one",
    controlCount: "one",
    controlLabel: "check",
    controlVisible: true,
    controlDisabled: false,
    hitTarget: "target",
    updateActionPresent: true,
    badgeVariant: "update-available",
    dismissPresent: false,
  };
  const revoked = Proxy.revocable(known, {});
  revoked.revoke();
  const throwing = new Proxy(known, {
    getOwnPropertyDescriptor() {
      throw new Error("private descriptor/error");
    },
  });
  for (const input of [throwing, revoked.proxy]) {
    let output: ReturnType<typeof projectRemoteUiCheckAgainObservation>;
    expect(() => {
      output = projectRemoteUiCheckAgainObservation(input);
    }).not.toThrow();
    expect(output!).toBeNull();
  }
  const allowed = Object.assign(Object.create(null), known);
  Object.defineProperty(allowed, "privateRawText", {
    enumerable: true,
    get() {
      throw new Error("Unknown keys must not be read.");
    },
  });
  expect(projectRemoteUiCheckAgainObservation(allowed)).toEqual(known);
  expect(Object.values(projectRemoteUiCheckAgainObservation(Object.create(known))!)).toEqual(
    Array(10).fill(null),
  );
});

const successRemovalFacts = {
  safeLocation: true,
  rowCount: "none",
  toastCloseCount: "one",
  visibleToastCloseCount: "none",
  endingToastCount: "one",
  removalDialogPresent: false,
};

it("keeps success-removal snapshots closed without treating absent controls as prior click proof", () => {
  for (const input of [undefined, null, [], "private-credential"])
    expect(projectRemoteUiSuccessRemovalObservation(input)).toBeNull();
  expect(projectRemoteUiSuccessRemovalObservation(successRemovalFacts)).toEqual(
    successRemovalFacts,
  );
  for (const field of Object.keys(successRemovalFacts)) {
    const output = projectRemoteUiSuccessRemovalObservation({
      ...successRemovalFacts,
      [field]: "private-credential /private/path http://private-host",
      privateText: "private-credential",
    });
    expect(output![field as keyof typeof output]).toBeNull();
    expect(Object.keys(output!)).toEqual(Object.keys(successRemovalFacts));
    expect(JSON.stringify(output)).not.toContain("private-");
  }
  for (const safeLocation of [false, undefined, "true"]) {
    expect(
      projectRemoteUiSuccessRemovalObservation({ ...successRemovalFacts, safeLocation }),
    ).toEqual({
      safeLocation: safeLocation === false ? false : null,
      rowCount: null,
      toastCloseCount: null,
      visibleToastCloseCount: null,
      endingToastCount: null,
      removalDialogPresent: null,
    });
  }
  for (const value of ["none", "one", "multiple"]) {
    expect(
      projectRemoteUiSuccessRemovalObservation({
        ...successRemovalFacts,
        rowCount: value,
        toastCloseCount: value,
        visibleToastCloseCount: value,
        endingToastCount: value,
      }),
    ).toEqual({
      ...successRemovalFacts,
      rowCount: value,
      toastCloseCount: value,
      visibleToastCloseCount: value,
      endingToastCount: value,
    });
  }
});

it.each(["accessor", "throwing-accessor", "nonenumerable", "inherited"])(
  "does not execute untrusted success-removal fact readers: %s",
  (kind) => {
    for (const field of Object.keys(successRemovalFacts)) {
      let reads = 0;
      const input: Record<string, unknown> = { ...successRemovalFacts };
      delete input[field];
      if (kind === "inherited")
        Object.setPrototypeOf(input, { [field]: Reflect.get(successRemovalFacts, field) });
      else
        Object.defineProperty(
          input,
          field,
          kind === "nonenumerable"
            ? { enumerable: false, value: Reflect.get(successRemovalFacts, field) }
            : {
                enumerable: true,
                get() {
                  reads++;
                  if (kind === "throwing-accessor") throw new Error("private getter/error");
                  return Reflect.get(successRemovalFacts, field);
                },
              },
        );
      let output: ReturnType<typeof projectRemoteUiSuccessRemovalObservation>;
      expect(() => {
        output = projectRemoteUiSuccessRemovalObservation(input);
      }).not.toThrow();
      if (kind === "inherited") expect(output![field as keyof typeof output]).toBeNull();
      else expect(output!).toBeNull();
      expect(reads).toBe(0);
    }
  },
);

it("quarantines unreadable success-removal proxies and leaves unrelated private fields unread", () => {
  const revoked = Proxy.revocable(successRemovalFacts, {});
  revoked.revoke();
  const throwing = new Proxy(successRemovalFacts, {
    getOwnPropertyDescriptor() {
      throw new Error("private descriptor/error");
    },
  });
  for (const input of [throwing, revoked.proxy]) {
    expect(() => projectRemoteUiSuccessRemovalObservation(input)).not.toThrow();
    expect(projectRemoteUiSuccessRemovalObservation(input)).toBeNull();
  }
  const input = Object.assign(Object.create(null), successRemovalFacts);
  Object.defineProperty(input, "privateRawText", {
    enumerable: true,
    get() {
      throw new Error("Unknown fields must remain unread.");
    },
  });
  expect(projectRemoteUiSuccessRemovalObservation(input)).toEqual(successRemovalFacts);
  expect(
    Object.values(projectRemoteUiSuccessRemovalObservation(Object.create(successRemovalFacts))!),
  ).toEqual(Array(6).fill(null));
});
