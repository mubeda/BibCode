// @effect-diagnostics nodeBuiltinImport:off - Retain only finite native receipts and exact approved original PNG bytes after the existing owner joined cleanup.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { inspectScreenshot } from "./remote-ui-evidence.ts";
import {
  validateNativeFollowupOriginal,
  validateNativeFollowupWitness,
} from "./release-visual-native-followups.ts";
const read = (path: string, platform: string) => {
  const stat = NodeFS.lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 256 * 1024 ||
    (platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new Error("Native follow-up receipt refused.");
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
};
export function retainNativeFollowupEvidence(input: {
  privateEvidence: string;
  destination: string;
  cleanupSafe: boolean;
  platform?: string;
}) {
  if (!input.cleanupSafe) throw new Error("Native follow-up parent cleanup incomplete.");
  const platform = input.platform ?? "linux";
  if (!["linux", "win32"].includes(platform))
    throw new Error("Native follow-up evidence host refused.");
  const result = read(NodePath.join(input.privateEvidence, "result.json"), platform),
    originals = read(NodePath.join(input.privateEvidence, "originals.json"), platform),
    assertions = read(NodePath.join(input.privateEvidence, "assertions.json"), platform);
  if (
    Object.keys(originals).sort().join(",") !== "originals,schemaVersion" ||
    originals.schemaVersion !== 1 ||
    Object.keys(assertions).sort().join(",") !== "assertions,schemaVersion" ||
    assertions.schemaVersion !== 1
  )
    throw new Error("Native follow-up nested receipt privacy refused.");
  const keys = [
    "schemaVersion",
    "selection",
    "complete",
    "baseRowCount",
    "requiredOriginalCount",
    "originalCount",
    "outstandingRowCount",
    "prerequisiteStatus",
    "cleanup",
    "visualReview",
    "partition",
    "partitionComplete",
    "sourceSha",
    "appSha256",
    "dataRootIdentitySha256",
    "processIdentitySha256",
    "sourceFiles",
    "processes",
  ];
  if (
    Object.keys(result).length !== keys.length ||
    Object.keys(result).some((key) => !keys.includes(key)) ||
    result.schemaVersion !== 1 ||
    result.selection !== "release-visual-native-followups" ||
    result.complete !== false ||
    result.baseRowCount !== 5 ||
    result.requiredOriginalCount !== 10 ||
    result.cleanup !== "joined" ||
    result.visualReview !== "pending" ||
    result.prerequisiteStatus !== "unavailable" ||
    result.partitionComplete !== true ||
    !["linux-menu-update", "windows-wsl"].includes(String(result.partition)) ||
    typeof result.sourceSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(result.sourceSha)
  )
    throw new Error("Native follow-up result privacy refused.");
  for (const key of ["appSha256", "dataRootIdentitySha256", "processIdentitySha256"])
    if (typeof result[key] !== "string" || !/^[a-f0-9]{64}$/.test(result[key] as string))
      throw new Error("Native follow-up identity receipt refused.");
  const expected = result.partition === "linux-menu-update" ? 6 : 2;
  if (
    result.originalCount !== expected ||
    result.outstandingRowCount !== (expected === 6 ? 2 : 4) ||
    !Array.isArray(originals.originals) ||
    originals.originals.length !== expected ||
    !Array.isArray(assertions.assertions) ||
    assertions.assertions.length !== expected ||
    !Array.isArray(result.processes) ||
    result.processes.length > 256 ||
    !Array.isArray(result.sourceFiles) ||
    result.sourceFiles.length > 64
  )
    throw new Error("Native follow-up finite receipt count refused.");
  for (const item of result.sourceFiles) {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).sort().join(",") !== "path,sha256" ||
      typeof item.path !== "string" ||
      !/^(apps|packages|scripts|docs|\.github)\/[A-Za-z0-9_./-]+$/.test(item.path) ||
      item.path.split("/").includes("..") ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error("Native follow-up source privacy refused.");
  }
  for (const item of result.processes) {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).sort().join(",") !== "closed,executableSha256,outputBounded,timeout" ||
      item.closed !== true ||
      item.timeout !== false ||
      item.outputBounded !== true ||
      typeof item.executableSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.executableSha256)
    )
      throw new Error("Native follow-up child receipt refused.");
  }
  const names = new Set<string>(),
    receipts = originals.originals.map(validateNativeFollowupOriginal),
    receiptsByFile = new Map(receipts.map((receipt) => [receipt.file, receipt])),
    assertedFiles = new Set<string>();
  for (const receipt of receipts) {
    if (
      names.has(receipt.file) ||
      (expected === 6
        ? receipt.scene === "native-wsl-local" || receipt.scene === "native-preview-annotations"
        : receipt.scene !== "native-wsl-local")
    )
      throw new Error("Native follow-up partition original refused.");
    names.add(receipt.file);
  }
  for (const item of assertions.assertions) {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).sort().join(",") !==
        "after,appSha256,before,bootIdentitySha256,endpointSha256,nativeViewport,original,physicalRootSha256,processIdentitySha256,sourceSha,storageIdentitySha256,versionSha256"
    )
      throw new Error("Native follow-up joined assertion refused.");
    const original = validateNativeFollowupOriginal(item.original);
    const retained = receiptsByFile.get(original.file);
    if (
      assertedFiles.has(original.file) ||
      retained === undefined ||
      JSON.stringify(original) !== JSON.stringify(retained)
    )
      throw new Error("Native follow-up original assertion mismatch.");
    assertedFiles.add(original.file);
    const viewport = item.nativeViewport;
    if (
      !viewport ||
      typeof viewport !== "object" ||
      Object.keys(viewport).sort().join(",") !== "height,scale,width" ||
      viewport.width !== 1280 ||
      !Number.isInteger(viewport.height) ||
      viewport.height < 900 ||
      viewport.height > 960 ||
      viewport.scale !== 1
    )
      throw new Error("Native follow-up actual viewport receipt refused.");
    validateNativeFollowupWitness(original.scene, item.before);
    validateNativeFollowupWitness(original.scene, item.after);
    if (
      !names.has(original.file) ||
      item.sourceSha !== result.sourceSha ||
      item.appSha256 !== result.appSha256 ||
      item.physicalRootSha256 !== result.dataRootIdentitySha256 ||
      item.processIdentitySha256 !== result.processIdentitySha256
    )
      throw new Error("Native follow-up assertion identity refused.");
    for (const key of [
      "storageIdentitySha256",
      "bootIdentitySha256",
      "endpointSha256",
      "versionSha256",
    ])
      if (typeof item[key] !== "string" || !/^[a-f0-9]{64}$/.test(item[key]))
        throw new Error("Native follow-up assertion privacy refused.");
  }
  if (assertedFiles.size !== receiptsByFile.size)
    throw new Error("Native follow-up original assertion missing.");
  // Validate every original before any artifact publication, and copy bytes without derived pixels.
  const bytes = receipts.map((receipt) => {
    const path = NodePath.join(input.privateEvidence, receipt.file),
      stat = NodeFS.lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (platform !== "win32" && (stat.mode & 0o077) !== 0) ||
      stat.size > 12 * 1024 ** 2
    )
      throw new Error("Native follow-up image refused.");
    const data = NodeFS.readFileSync(path),
      image = inspectScreenshot(data);
    if (image.sha256 !== receipt.sha256 || image.width !== 1280 || image.height !== 960)
      throw new Error("Native follow-up original changed.");
    return data;
  });
  NodeFS.mkdirSync(input.destination, { recursive: true, mode: 0o700 });
  for (const [index, receipt] of receipts.entries())
    NodeFS.writeFileSync(NodePath.join(input.destination, receipt.file), bytes[index]!, {
      mode: 0o600,
      flag: "wx",
    });
  for (const [name, value] of [
    ["native-followups-result", result],
    ["native-followups-originals", originals],
    ["native-followups-assertions", assertions],
  ] as const)
    NodeFS.writeFileSync(NodePath.join(input.destination, name + ".json"), JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
  return {
    partition: result.partition,
    originalCount: expected,
    visualReview: "pending",
    complete: false,
  };
}
