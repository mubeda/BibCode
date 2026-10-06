// @effect-diagnostics nodeBuiltinImport:off - Test-owned PNG fixtures and private receipt data.
import * as NodeZlib from "node:zlib";
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import {
  projectRemoteUiPrimaryImportObservation,
  remoteUiScenes,
  screenshotName,
  validateCaptureWitness,
  countInstallRequests,
  inspectScreenshot,
  remoteUiPlan,
  projectRemoteUiSetupObservation,
  projectRemoteUiCheckAgainObservation,
  projectRemoteUiCheckAgainInterception,
  projectRemoteUiSuccessRemovalObservation,
  projectRemoteUiManualRemovalObservation,
  projectRemoteUiToastErrorSignature,
} from "./remote-ui-evidence.ts";

it.each([
  ["WebDriverError: private", "protocol", null, null],
  [
    "Can't call click on element with selector \"private\" because element wasn't found",
    "implicit",
    "click",
    null,
  ],
  [
    "Can't call scrollIntoView on element with selector \"private\" because element wasn't found",
    "implicit",
    "scrollIntoView",
    null,
  ],
  [
    "Can't call getHTML on element with selector \"private\" because element wasn't found",
    "implicit",
    "getHTML",
    null,
  ],
  [
    "Can't call $ on element with selector \"private\" because element wasn't found",
    "implicit",
    "$",
    null,
  ],
  [
    "Can't call $$ on element with selector \"private\" because element wasn't found",
    "implicit",
    "$$",
    null,
  ],
  [
    "Can't call privateCommand on element with selector \"private\" because element wasn't found",
    "implicit",
    "other",
    null,
  ],
  ['element ("private") still not existing after 10000ms', "wait", null, "existing"],
  [
    'element ("private") still not displayed within viewport after 10000ms',
    "wait",
    null,
    "displayed",
  ],
  ['element ("private") still clickable after 10000ms', "wait", null, "clickable"],
  ['element ("private") still not enabled after 10000ms', "wait", null, "enabled"],
  ['element ("private") malformed private condition', "wait", null, null],
  ["waitUntil condition failed with the following reason: private", "wait-wrapper", null, null],
  [
    'The element with selector "private" you are trying to pass into the execute method wasn\'t found',
    "execute",
    null,
    null,
  ],
  ['Couldn\'t find element with selector "private"', "lookup", null, null],
  ["Element private did not become interactable", "interactable", null, null],
  ["private arbitrary body", "other", null, null],
])(
  "retains fixed SDK categories without retaining source strings: %s",
  (message, sdkTemplate, sdkCommand, sdkCondition) => {
    const signature = projectRemoteUiToastErrorSignature(message);
    expect(signature).toMatchObject({ sdkTemplate, sdkCommand, sdkCondition });
    expect(JSON.stringify(signature)).not.toContain("private");
    expect(Object.isFrozen(signature)).toBe(true);
    expect(projectRemoteUiToastErrorSignature(message + "x".repeat(4097))).toMatchObject({
      sdkTemplate: null,
      sdkCommand: null,
      sdkCondition: null,
    });
  },
);

it.each(["Existing", "Displayed", "Clickable", "Enabled"])(
  "classifies the installed SDK's actual default wait template: %s",
  async (condition) => {
    const manifest = NodeFS.realpathSync(
      new NodeURL.URL("../../node_modules/webdriverio/package.json", import.meta.url),
    );
    const sdk = NodeFS.readFileSync(
      NodePath.join(NodePath.dirname(manifest), "build", "node.js"),
      "utf8",
    );
    const method = condition === "Existing" ? "Exist" : condition;
    const marker =
      (condition === "Displayed" ? "function " : "async function ") + "waitFor" + method + "(";
    const begin = sdk.indexOf(marker);
    const end = sdk.indexOf("\n}\n", begin) + 2;
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const actual = NodeVM.runInNewContext("(" + sdk.slice(begin, end) + ")", {
      getBrowserObject33: () => ({ isMobile: false }),
    });
    const original = new Error("inert wait");
    const port = {
      selector: 'button[data-slot="toast-close"]',
      elementId: "inert",
      options: { waitforTimeout: 10000, waitforInterval: 10 },
      waitUntil: async (_predicate: unknown, options: { timeoutMsg: string }) => {
        original.message = options.timeoutMsg;
        throw original;
      },
    };
    await expect(actual.call(port)).rejects.toBe(original);
    expect(projectRemoteUiToastErrorSignature(original.message, original)).toMatchObject({
      sdkTemplate: "wait",
      sdkCommand: null,
      sdkCondition: condition.toLowerCase(),
      exactToastSelectorPresent: true,
    });
  },
);

it("keeps toast string-shape facts finite and separate from any recovery verdict", () => {
  const message =
    'WebDriverError: no such element: private detail button[data-slot="toast-close"] when running "element/private-id/click" with method "POST"';
  const error = { name: "no such element", privateText: "private-value" };
  const signature = projectRemoteUiToastErrorSignature(message, error);
  expect(signature).toEqual({
    wrapperPrefix: true,
    messageFamily: "missing",
    clickPostSuffix: true,
    argumentsSuffix: false,
    lengthBucket: "0-1024",
    exactToastSelectorPresent: true,
    nameFamily: "missing",
    sdkTemplate: "protocol",
    sdkCommand: null,
    sdkCondition: null,
  });
  expect(Object.isFrozen(signature)).toBe(true);
  expect(JSON.stringify(signature)).not.toMatch(
    /private-|button\[|no such element|WebDriverError:/,
  );
  const unknown = projectRemoteUiToastErrorSignature("private text mentioning no such element", {
    name: "unknown private name",
  });
  expect(unknown).toMatchObject({
    wrapperPrefix: false,
    messageFamily: "other",
    nameFamily: "other",
  });
});

it.each([
  { size: 1024, bucket: "0-1024" },
  { size: 1025, bucket: "1025-2048" },
  { size: 2048, bucket: "1025-2048" },
  { size: 2049, bucket: "2049-4096" },
  { size: 4096, bucket: "2049-4096" },
  { size: 4097, bucket: "over-4096" },
])(
  "bounds toast detail inspection at the $size size seam without retaining its length/text",
  (input) => {
    const signature = projectRemoteUiToastErrorSignature("x".repeat(input.size));
    expect(signature).toEqual({
      wrapperPrefix: false,
      messageFamily: "other",
      clickPostSuffix: input.size > 4096 ? null : false,
      argumentsSuffix: input.size > 4096 ? null : false,
      lengthBucket: input.bucket,
      exactToastSelectorPresent: input.size > 4096 ? null : false,
      nameFamily: "unavailable",
      sdkTemplate: input.size > 4096 ? null : "other",
      sdkCommand: null,
      sdkCondition: null,
    });
  },
);

it.each(["missing", "accessor", "inherited", "non-string", "reflection", "revoked"])(
  "quarantines unavailable own toast name metadata without evaluating readers: %s",
  (shape) => {
    let reads = 0;
    let error: unknown = {};
    if (shape === "accessor")
      error = Object.defineProperty({}, "name", {
        get() {
          reads++;
          throw new Error("private getter");
        },
      });
    else if (shape === "inherited") error = Object.create({ name: "no such element" });
    else if (shape === "non-string") error = { name: { private: "private-name" } };
    else if (shape === "reflection")
      error = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error("private reflection");
          },
        },
      );
    else if (shape === "revoked") {
      const proxy = Proxy.revocable({}, {});
      proxy.revoke();
      error = proxy.proxy;
    }
    const signature = projectRemoteUiToastErrorSignature("unknown private message", error);
    expect(signature?.nameFamily).toBe("unavailable");
    expect(reads).toBe(0);
    expect(JSON.stringify(signature)).not.toContain("private");
  },
);

it("never reads unrelated toast error properties or coerces non-string messages", () => {
  let reads = 0;
  const error: Record<string, unknown> = { name: "stale element reference" };
  for (const key of ["message", "stack", "url", "opts", "cause", "_tag", "private"])
    Object.defineProperty(error, key, {
      get() {
        reads++;
        throw new Error("private reader");
      },
    });
  expect(projectRemoteUiToastErrorSignature("unknown", error)?.nameFamily).toBe("stale");
  for (const message of [undefined, null, [], {}, Object("private")])
    expect(projectRemoteUiToastErrorSignature(message, error)).toBeNull();
  expect(reads).toBe(0);
});

it.each(["GET", "args", "trailing text", "trailing newline", "malformed prefix"])(
  "reports refused toast signature shapes without admitting a recovery: %s",
  (shape) => {
    let message =
      'WebDriverError: stale element reference: detail when running "element/owned/click" with method "POST"';
    if (shape === "GET") message = message.replace('"POST"', '"GET"');
    else if (shape === "args") message += ' and args "{\\"button\\":0}"';
    else if (shape === "trailing text") message += " private suffix";
    else if (shape === "trailing newline") message += "\n";
    else message = message.replace("WebDriverError: ", "WebDriverError:");
    const signature = projectRemoteUiToastErrorSignature(message);
    expect(signature?.clickPostSuffix).toBe(shape === "malformed prefix");
    expect(signature?.argumentsSuffix).toBe(shape === "args");
    expect(signature?.wrapperPrefix).toBe(shape !== "malformed prefix");
    expect(JSON.stringify(signature)).not.toMatch(/private|button|owned\//);
  },
);

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

it("admits only exact safe primary import facts and refuses private/coercive/getter/proxy inputs", () => {
  const facts = {
    safePage: true,
    pathCount: "one",
    expectedPathMatched: true,
    formUnique: true,
    submitCount: "one",
    submitDisabled: false,
    formState: "idle",
    composerCount: "none",
  };
  expect(projectRemoteUiPrimaryImportObservation(facts)).toEqual(facts);
  expect(Object.isFrozen(projectRemoteUiPrimaryImportObservation(facts))).toBe(true);
  for (const value of [
    null,
    undefined,
    [],
    { ...facts, safePage: false },
    { ...facts, pathCount: "private" },
    { ...facts, rawValue: "private path" },
    { ...facts, pathCount: "multiple" },
    { ...facts, expectedPathMatched: "true" },
    { ...facts, submitCount: "none" },
    { ...facts, formState: "absent" },
  ])
    expect(projectRemoteUiPrimaryImportObservation(value)).toBeNull();
  let reads = 0;
  const coercive = {
    toString() {
      reads++;
      return "one";
    },
  };
  expect(projectRemoteUiPrimaryImportObservation({ ...facts, pathCount: coercive })).toBeNull();
  for (const key of Object.keys(facts)) {
    const missing = { ...facts };
    Reflect.deleteProperty(missing, key);
    expect(projectRemoteUiPrimaryImportObservation(missing)).toBeNull();
    Object.defineProperty(missing, key, {
      enumerable: true,
      get() {
        reads++;
        return true;
      },
    });
    expect(projectRemoteUiPrimaryImportObservation(missing)).toBeNull();
  }
  const proxy = new Proxy(facts, {
    ownKeys() {
      reads++;
      throw new Error("Private reflection trap.");
    },
  });
  expect(projectRemoteUiPrimaryImportObservation(proxy)).toBeNull();
  const revoked = Proxy.revocable(facts, {});
  revoked.revoke();
  expect(projectRemoteUiPrimaryImportObservation(revoked.proxy)).toBeNull();
  expect(reads).toBe(0);
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

it("retains only an exact safe manual-removal own-data snapshot", () => {
  const facts = {
    safeLocation: true,
    rowCount: "none",
    toastCloseCount: "multiple",
    visibleToastCloseCount: "one",
    endingToastCount: "one",
    removalDialogPresent: false,
  };
  expect(projectRemoteUiManualRemovalObservation(facts)).toEqual(facts);
  expect(Object.isFrozen(projectRemoteUiManualRemovalObservation(facts))).toBe(true);
  for (const input of [
    undefined,
    null,
    [],
    "private",
    Object.create(facts),
    { ...facts, safeLocation: false },
    { ...facts, private: "private" },
    { ...facts, [Symbol("private")]: true },
  ])
    expect(projectRemoteUiManualRemovalObservation(input)).toBeNull();
  for (const field of Object.keys(facts)) {
    expect(projectRemoteUiManualRemovalObservation({ ...facts, [field]: "private" })).toBeNull();
    for (const kind of ["getter", "nonenumerable", "missing"]) {
      let reads = 0;
      const input: Record<string, unknown> = { ...facts };
      delete input[field];
      if (kind !== "missing")
        Object.defineProperty(
          input,
          field,
          kind === "getter"
            ? {
                enumerable: true,
                get() {
                  reads++;
                  throw new Error("private getter");
                },
              }
            : { value: Reflect.get(facts, field), enumerable: false },
        );
      expect(projectRemoteUiManualRemovalObservation(input)).toBeNull();
      expect(reads).toBe(0);
    }
  }
  let traps = 0;
  const proxy = new Proxy(facts, {
    ownKeys() {
      traps++;
      return Reflect.ownKeys(facts);
    },
    getOwnPropertyDescriptor() {
      traps++;
      throw new Error("private reflection");
    },
  });
  const revoked = Proxy.revocable(facts, {});
  revoked.revoke();
  for (const input of [new Proxy(facts, {}), proxy, revoked.proxy])
    expect(projectRemoteUiManualRemovalObservation(input)).toBeNull();
  expect(traps).toBe(0);
  let getters = 0;
  const extra = Object.assign(Object.create(null), facts);
  Object.defineProperty(extra, "private", {
    enumerable: true,
    get() {
      getters++;
      throw new Error("private accessor");
    },
  });
  expect(projectRemoteUiManualRemovalObservation(extra)).toBeNull();
  expect(getters).toBe(0);
  for (const value of ["none", "one", "multiple"])
    expect(
      projectRemoteUiManualRemovalObservation({
        ...facts,
        rowCount: value,
        toastCloseCount: value,
        visibleToastCloseCount: value,
        endingToastCount: value,
      }),
    ).toEqual({
      ...facts,
      rowCount: value,
      toastCloseCount: value,
      visibleToastCloseCount: value,
      endingToastCount: value,
    });
});

it("keeps ambiguous self-closing receiver fragments unknown", () => {
  const error = new Error(
    'element click intercepted: Other element would receive the click: <button data-slot="toast-close" />',
  );
  expect(projectRemoteUiCheckAgainInterception(error)).toBeNull();
});

it("refuses a receiver marker embedded in the target element's quoted attribute", () => {
  const error = new Error(
    'element click intercepted: Element <button title="Other element would receive the click: <button data-slot=\"toast-close\">\"',
  );
  expect(projectRemoteUiCheckAgainInterception(error)).toBeNull();
});

it.each([
  [
    '<button data-slot="toast-close" data-ending-style id="private-id" title="private input > detail"></button>',
    { receiverSlot: "toast-close", receiverEndingStyle: true },
  ],
  [
    "<div data-slot='toast-description'></div>",
    { receiverSlot: "toast-description", receiverEndingStyle: false },
  ],
  [
    '<div role="alertdialog" data-position="top-right" style="--toast-index: 0; --toast-offset-y: 0px;" data-ending-style="">',
    { receiverSlot: "toast-root", receiverEndingStyle: true },
  ],
  [
    '<div role="dialog" data-slot="dialog-popup">',
    { receiverSlot: "dialog-popup", receiverEndingStyle: false },
  ],
  [
    '<span data-slot="private-unknown-slot" id="private-id">',
    { receiverSlot: "other", receiverEndingStyle: false },
  ],
  ['<span id="private-id">', { receiverSlot: null, receiverEndingStyle: false }],
])("retains only the receiver's fixed own slot and ending fact", (fragment, expected) => {
  const error = new Error(
    "element click intercepted: Other element would receive the click: " + fragment,
  );
  const facts = projectRemoteUiCheckAgainInterception(error);
  expect(facts).toEqual(expected);
  expect(Object.isFrozen(facts)).toBe(true);
  expect(Object.keys(facts!)).toEqual(["receiverSlot", "receiverEndingStyle"]);
  expect(JSON.stringify(facts)).not.toMatch(/private|id=|title=|style=|</);
});

it.each([
  "element click intercepted: private input without a receiver",
  'Other element would receive the click: <button data-slot="toast-close">',
  'element click intercepted: Other element would receive the click: &lt;button data-slot="toast-close"&gt;',
  "element click intercepted: Other element would receive the click: </button>",
  "element click intercepted: Other element would receive the click: <!--private-->",
  'element click intercepted: Other element would receive the click: <button data-slot="toast-close"',
  'element click intercepted: Other element would receive the click: <button data-slot="toast-close" title="private>',
  'element click intercepted: Other element would receive the click: <button data-slot="toast-close" DATA-SLOT="dialog-popup">',
  'element click intercepted: Other element would receive the click: <button data-slot="toast-close" data-ending-style data-ending-style>',
  "element click intercepted: Other element would receive the click: <button data-slot=toast-close>",
  'element click intercepted: Other element would receive the click: <button data-slot="toast-close"></button><div data-slot="dialog-popup">',
  'element click intercepted: Other element would receive the click: <button data-slot="toast-close"> Other element would receive the click: <div>',
  'element click intercepted: Other element would receive the click: <button data-slot="toast-close">' +
    "p".repeat(4096),
  "element click intercepted: Other element would receive the click: <button " +
    ' x="private"'.repeat(65) +
    ">",
])(
  "keeps unavailable or ambiguous receiver data unknown without retaining its string",
  (message) => {
    expect(projectRemoteUiCheckAgainInterception(new Error(message))).toBeNull();
  },
);

it.each([
  ["toast-close", true],
  ["dialog-popup", false],
  ["private-unknown-slot", true],
] as const)(
  "projects only the header of a literal Chrome ellipsis receiver: %s",
  (slot, ending) => {
    const error = new Error(
      'element click intercepted: Element <button>...</button> is not clickable at point (10, 20). Other element would receive the click: <div data-slot="' +
        slot +
        '"' +
        (ending ? " data-ending-style" : "") +
        ">...</div>",
    );
    const facts = projectRemoteUiCheckAgainInterception(error);
    expect(facts).toEqual({
      receiverSlot: slot === "private-unknown-slot" ? "other" : slot,
      receiverEndingStyle: ending,
    });
    expect(Object.keys(facts!)).toEqual(["receiverSlot", "receiverEndingStyle"]);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(JSON.stringify(facts)).not.toMatch(/private|button|div|point|10|20|<|>/);
  },
);

it.each([
  "....</div>",
  "…</div>",
  "... </div>",
  "...</span>",
  "...<span></span></div>",
  "...</div><span>",
  "..</div>",
  "<span></span></div>",
])(
  "refuses malformed or nested ellipsis receiver contents without parsing arbitrary HTML: %s",
  (body) => {
    const error = new Error(
      'element click intercepted: Other element would receive the click: <div data-slot="dialog-popup">' +
        body,
    );
    expect(projectRemoteUiCheckAgainInterception(error)).toBeNull();
  },
);

it("refuses inherited, accessor, live-proxy and revoked-proxy messages before reflection", () => {
  let reads = 0;
  const message =
    'element click intercepted: Other element would receive the click: <button data-slot="toast-close">';
  const inherited = Object.create({ message });
  const accessor = Object.defineProperty({}, "message", {
    get() {
      reads++;
      throw new Error("private getter");
    },
  });
  const proxy = new Proxy(
    { message },
    {
      ownKeys() {
        reads++;
        return [];
      },
      getOwnPropertyDescriptor() {
        reads++;
        throw new Error("private trap");
      },
      get() {
        reads++;
        return message;
      },
    },
  );
  const revoked = Proxy.revocable({ message }, {});
  revoked.revoke();
  for (const value of [
    null,
    undefined,
    1,
    "private",
    [],
    () => {},
    inherited,
    accessor,
    proxy,
    revoked.proxy,
    { message: Symbol("private") },
    { message: new String(message) },
  ]) {
    expect(projectRemoteUiCheckAgainInterception(value)).toBeNull();
  }
  expect(reads).toBe(0);
});
