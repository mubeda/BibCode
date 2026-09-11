#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Repository guard reads manifests before an Effect runtime exists.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { parse as parseToml, type TomlTable } from "smol-toml";
import { parse as parseYaml } from "yaml";

export type DependencyLedgerStatus = "pending" | "green" | "blocked" | "current" | "removed";

export interface DependencyInventoryEntry {
  readonly key: string;
  readonly category: "javascript" | "rust" | "action" | "toolchain";
  readonly name: string;
  readonly current: string;
  readonly locations: ReadonlyArray<string>;
  readonly dependencyKind?: "registry" | "path" | "git";
  readonly platforms?: ReadonlyArray<string> | undefined;
}

export interface DependencyInventorySummary {
  readonly javascriptDirect: number;
  readonly javascriptLedger: number;
  readonly rustRegistry: number;
  readonly rustPath: number;
  readonly rustGit: number;
  readonly actions: number;
  readonly toolchains: number;
}

export interface DependencyInventory {
  readonly entries: ReadonlyArray<DependencyInventoryEntry>;
  readonly summary: DependencyInventorySummary;
}

export interface DependencyLedgerEntry {
  key: string;
  name: string;
  current: string;
  target: string;
  channel: string;
  source: string;
  cohort: string;
  platforms: ReadonlyArray<string>;
  status: DependencyLedgerStatus | string;
  notes?: string;
  blocker?: string;
}

export interface DependencyLedger {
  readonly schemaVersion: number;
  readonly auditDate: string;
  readonly inventorySummary: DependencyInventorySummary;
  readonly baseline: {
    readonly originMainSha: string;
    readonly implementationHead: string;
    readonly baselineRepairCommit?: string;
    readonly evidenceSource?: string;
    readonly tools: {
      readonly node: string;
      readonly pnpm: string;
      readonly rust: string;
      readonly vitePlus: string;
    };
    readonly commands: Array<{
      readonly command: string;
      readonly durationSeconds?: number;
      result: string;
      readonly note?: string;
    }>;
    readonly warnings: ReadonlyArray<string>;
  };
  readonly dependencies: Array<DependencyLedgerEntry>;
}

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const INVENTORY_SUMMARY_FIELDS = [
  "javascriptDirect",
  "javascriptLedger",
  "rustRegistry",
  "rustPath",
  "rustGit",
  "actions",
  "toolchains",
] as const satisfies ReadonlyArray<keyof DependencyInventorySummary>;
const CARGO_DEPENDENCY_TABLES = new Set(["dependencies", "dev-dependencies", "build-dependencies"]);
export const DEPENDENCY_AUDIT_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  ".repos",
  ".superpowers",
  ".worktrees",
  ".vite-plus",
  "dist",
  "node_modules",
  "target",
]);
const PROGRESS_STATUSES = new Set(["green", "blocked", "current", "removed"]);
const VALID_STATUSES = new Set<DependencyLedgerStatus>([
  "pending",
  "green",
  "blocked",
  "current",
  "removed",
]);
const REQUIRED_BASELINE_COMMANDS = [
  "vp check",
  "vp run typecheck",
  "vp test",
  "vp run test",
  "cargo test --workspace --all-targets -j 2",
] as const;

interface JavaScriptDeclaration {
  readonly manifest: string;
  readonly name: string;
  readonly specifier: string;
}

interface RustCandidate {
  readonly manifest: string;
  readonly name: string;
  readonly current: string;
  readonly dependencyKind: "registry" | "path";
  readonly platforms?: ReadonlyArray<string> | undefined;
}

interface CargoDependencyTable {
  readonly dependencies: Record<string, unknown>;
  readonly platforms?: ReadonlyArray<string> | undefined;
}

interface PlatformAccumulator {
  readonly values: Set<string>;
  authoritative: boolean;
}

const SUPPORTED_PLATFORMS = ["linux", "macos", "windows"] as const;

function repositoryPath(root: string, absolutePath: string): string {
  return NodePath.relative(root, absolutePath).split(NodePath.sep).join("/");
}

function walkFiles(root: string, predicate: (relativePath: string) => boolean): Array<string> {
  const files: Array<string> = [];
  const visit = (directory: string): void => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && DEPENDENCY_AUDIT_IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolutePath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = repositoryPath(root, absolutePath);
      if (predicate(relativePath)) files.push(relativePath);
    }
  };
  visit(root);
  return files.toSorted();
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function isLocalJavaScriptSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("workspace:") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("link:")
  );
}

function manifestScope(manifest: string): string {
  if (manifest === "package.json") return "workspace";
  return manifest.replace(/\/package\.json$/, "").replace(/\/Cargo\.toml$/, "");
}

function collectJavaScriptInventory(root: string): {
  readonly entries: Array<DependencyInventoryEntry>;
  readonly directCount: number;
} {
  const packageFiles = walkFiles(root, (relativePath) => relativePath.endsWith("package.json"));
  const declarations: Array<JavaScriptDeclaration> = [];
  for (const manifest of packageFiles) {
    const packageJson = readJson(NodePath.join(root, manifest));
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, specifier] of Object.entries(stringRecord(packageJson[section]))) {
        if (isLocalJavaScriptSpecifier(specifier)) continue;
        declarations.push({ manifest, name, specifier });
      }
    }
  }

  const directNames = new Set(declarations.map((declaration) => declaration.name));
  const workspacePath = NodePath.join(root, "pnpm-workspace.yaml");
  const workspace = NodeFS.existsSync(workspacePath)
    ? (parseYaml(NodeFS.readFileSync(workspacePath, "utf8")) as Record<string, unknown>)
    : {};
  const catalog = stringRecord(workspace.catalog);
  const names = new Set([...directNames, ...Object.keys(catalog)]);
  const entries: Array<DependencyInventoryEntry> = [];

  for (const name of [...names].toSorted()) {
    if (name === "vite" || name === "vite-plus" || name === "@tauri-apps/cli") continue;
    const matching = declarations.filter((declaration) => declaration.name === name);
    const catalogSpecifier = catalog[name];
    const currentValues = new Set(
      matching.map((declaration) =>
        declaration.specifier === "catalog:" && catalogSpecifier !== undefined
          ? catalogSpecifier
          : declaration.specifier,
      ),
    );
    if (matching.length === 0 && catalogSpecifier !== undefined)
      currentValues.add(catalogSpecifier);
    const locations = new Set(matching.map((declaration) => declaration.manifest));
    if (catalogSpecifier !== undefined) locations.add("pnpm-workspace.yaml");
    const firstManifest = matching.toSorted((left, right) =>
      left.manifest.localeCompare(right.manifest),
    )[0]?.manifest;
    if (catalogSpecifier === undefined && firstManifest === undefined) {
      throw new Error(`JavaScript dependency ${name} has no declaration source`);
    }
    const scope =
      catalogSpecifier === undefined ? manifestScope(firstManifest as string) : "catalog";
    entries.push({
      key: `js:${scope}:${name}`,
      category: "javascript",
      name,
      current: [...currentValues].toSorted().join(" | "),
      locations: [...locations].toSorted(),
    });
  }

  return { entries, directCount: directNames.size };
}

function cargoDependencyValue(value: unknown): {
  readonly current: string;
  readonly dependencyKind: "registry" | "path";
  readonly workspace: boolean;
} | null {
  if (typeof value === "string") {
    return { current: value, dependencyKind: "registry", workspace: false };
  }
  if (!isRecord(value)) return null;
  if (value.workspace === true) {
    return { current: "workspace", dependencyKind: "registry", workspace: true };
  }
  if (typeof value.path === "string") {
    return { current: `path:${value.path}`, dependencyKind: "path", workspace: false };
  }
  if (typeof value.version === "string") {
    return { current: value.version, dependencyKind: "registry", workspace: false };
  }
  return null;
}

function targetPlatforms(selector: string): ReadonlyArray<string> | undefined {
  const normalized = selector.replaceAll(/\s/g, "");
  switch (normalized) {
    case "cfg(windows)":
    case 'cfg(target_os="windows")':
      return ["windows"];
    case 'cfg(target_os="linux")':
      return ["linux"];
    case 'cfg(target_os="macos")':
      return ["macos"];
    case "cfg(unix)":
      return ["linux", "macos"];
    default:
      return undefined;
  }
}

function dependencyTables(value: unknown): Array<CargoDependencyTable> {
  if (!isRecord(value)) return [];
  const tables: Array<CargoDependencyTable> = [];
  for (const key of CARGO_DEPENDENCY_TABLES) {
    const dependencies = value[key];
    if (isRecord(dependencies)) {
      tables.push({ dependencies, platforms: SUPPORTED_PLATFORMS });
    }
  }
  const targets = value.target;
  if (!isRecord(targets)) return tables;
  for (const [selector, target] of Object.entries(targets)) {
    if (!isRecord(target)) continue;
    const platforms = targetPlatforms(selector);
    for (const key of CARGO_DEPENDENCY_TABLES) {
      const dependencies = target[key];
      if (isRecord(dependencies)) tables.push({ dependencies, platforms });
    }
  }
  return tables;
}

function recordPlatforms(
  accumulators: Map<string, PlatformAccumulator>,
  name: string,
  platforms: ReadonlyArray<string> | undefined,
): void {
  const accumulator = accumulators.get(name) ?? {
    values: new Set<string>(),
    authoritative: true,
  };
  if (platforms === undefined) {
    accumulator.authoritative = false;
  } else {
    for (const platform of platforms) accumulator.values.add(platform);
  }
  accumulators.set(name, accumulator);
}

function collectRustInventory(root: string): Array<DependencyInventoryEntry> {
  const manifests = walkFiles(root, (relativePath) => relativePath.endsWith("Cargo.toml"));
  const workspaceManifest = manifests.includes("Cargo.toml")
    ? (parseToml(NodeFS.readFileSync(NodePath.join(root, "Cargo.toml"), "utf8")) as TomlTable)
    : {};
  const workspaceRoot = isRecord(workspaceManifest.workspace) ? workspaceManifest.workspace : {};
  const workspaceDependencies = isRecord(workspaceRoot.dependencies)
    ? workspaceRoot.dependencies
    : {};
  const entries: Array<DependencyInventoryEntry> = [];
  for (const [name, value] of Object.entries(workspaceDependencies).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const dependency = cargoDependencyValue(value);
    if (dependency === null) continue;
    entries.push({
      key: `rust:workspace:${name}`,
      category: "rust",
      name,
      current: dependency.current,
      locations: ["Cargo.toml"],
      dependencyKind: dependency.dependencyKind,
      platforms: SUPPORTED_PLATFORMS,
    });
  }

  const patches = isRecord(workspaceManifest.patch) ? workspaceManifest.patch : {};
  const cratesIoPatches = isRecord(patches["crates-io"]) ? patches["crates-io"] : {};
  for (const [name, value] of Object.entries(cratesIoPatches).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isRecord(value)) continue;
    if (typeof value.path === "string") {
      entries.push({
        key: `rust:patch:${name}`,
        category: "rust",
        name,
        current: `path:${value.path}`,
        locations: ["Cargo.toml"],
        dependencyKind: "path",
        platforms: SUPPORTED_PLATFORMS,
      });
      continue;
    }
    if (
      typeof value.git === "string" &&
      typeof value.rev === "string" &&
      /^[0-9a-f]{40}$/.test(value.rev)
    ) {
      entries.push({
        key: `rust:patch:${name}`,
        category: "rust",
        name,
        current: `git:${value.git}#${value.rev}`,
        locations: ["Cargo.toml"],
        dependencyKind: "git",
        platforms: SUPPORTED_PLATFORMS,
      });
    }
  }

  const externalCandidates = new Map<string, Array<RustCandidate>>();
  const workspacePlatforms = new Map<string, PlatformAccumulator>();
  for (const manifest of manifests) {
    if (manifest === "Cargo.toml") continue;
    const parsed = parseToml(
      NodeFS.readFileSync(NodePath.join(root, manifest), "utf8"),
    ) as TomlTable;
    for (const table of dependencyTables(parsed)) {
      for (const [name, value] of Object.entries(table.dependencies)) {
        const dependency = cargoDependencyValue(value);
        if (dependency === null) continue;
        if (dependency.workspace) {
          recordPlatforms(workspacePlatforms, name, table.platforms);
          continue;
        }
        const candidateKey = `${manifest}\0${name}`;
        const candidates = externalCandidates.get(candidateKey) ?? [];
        candidates.push({
          manifest,
          name,
          current: dependency.current,
          dependencyKind: dependency.dependencyKind,
          platforms: table.platforms,
        });
        externalCandidates.set(candidateKey, candidates);
      }
    }
  }

  for (const [index, entry] of entries.entries()) {
    if (!entry.key.startsWith("rust:workspace:")) continue;
    const usage = workspacePlatforms.get(entry.name);
    if (usage === undefined) continue;
    entries[index] = {
      ...entry,
      platforms: usage.authoritative ? [...usage.values].toSorted() : undefined,
    };
  }

  for (const [, candidates] of [...externalCandidates].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const ordered = candidates.toSorted((left, right) =>
      left.manifest.localeCompare(right.manifest),
    );
    const firstCandidate = ordered[0];
    if (firstCandidate === undefined) {
      throw new Error("Rust dependency has no declaration source");
    }
    entries.push({
      key: `rust:${manifestScope(firstCandidate.manifest)}:${firstCandidate.name}`,
      category: "rust",
      name: firstCandidate.name,
      current: [...new Set(ordered.map((candidate) => candidate.current))].toSorted().join(" | "),
      locations: [...new Set(ordered.map((candidate) => candidate.manifest))].toSorted(),
      dependencyKind: ordered.some((candidate) => candidate.dependencyKind === "path")
        ? "path"
        : "registry",
      platforms: ordered.every((candidate) => candidate.platforms !== undefined)
        ? [...new Set(ordered.flatMap((candidate) => candidate.platforms ?? []))].toSorted()
        : undefined,
    });
  }
  return entries;
}

function collectUses(value: unknown, results: Array<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectUses(child, results);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.uses === "string") results.push(value.uses);
  for (const child of Object.values(value)) collectUses(child, results);
}

function collectActionInventory(root: string): Array<DependencyInventoryEntry> {
  const workflowDirectory = NodePath.join(root, ".github/workflows");
  if (!NodeFS.existsSync(workflowDirectory)) return [];
  const workflowFiles = walkFiles(root, (relativePath) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(relativePath),
  );
  const actions = new Map<string, { refs: Set<string>; locations: Set<string> }>();
  for (const workflow of workflowFiles) {
    const uses: Array<string> = [];
    collectUses(parseYaml(NodeFS.readFileSync(NodePath.join(root, workflow), "utf8")), uses);
    for (const declaration of uses) {
      if (declaration.startsWith("./") || declaration.startsWith("docker://")) continue;
      const separator = declaration.lastIndexOf("@");
      if (separator <= 0 || separator === declaration.length - 1) continue;
      const name = declaration.slice(0, separator);
      const reference = declaration.slice(separator + 1);
      const action = actions.get(name) ?? { refs: new Set(), locations: new Set() };
      action.refs.add(reference);
      action.locations.add(workflow);
      actions.set(name, action);
    }
  }
  return [...actions]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, action]) => ({
      key: `action:${name}`,
      category: "action" as const,
      name,
      current: [...action.refs].toSorted().join(" | "),
      locations: [...action.locations].toSorted(),
    }));
}

function toolchainEntry(
  key: string,
  name: string,
  current: string,
  locations: ReadonlyArray<string>,
): DependencyInventoryEntry {
  return { key, category: "toolchain", name, current, locations };
}

function collectToolchainInventory(root: string): Array<DependencyInventoryEntry> {
  const entries: Array<DependencyInventoryEntry> = [];
  const rootPackagePath = NodePath.join(root, "package.json");
  const rootPackage = NodeFS.existsSync(rootPackagePath) ? readJson(rootPackagePath) : {};
  const engines = stringRecord(rootPackage.engines);
  if (engines.node !== undefined) {
    entries.push(toolchainEntry("toolchain:node", "Node.js", engines.node, ["package.json"]));
  }
  if (typeof rootPackage.packageManager === "string") {
    entries.push(
      toolchainEntry("toolchain:pnpm", "pnpm", rootPackage.packageManager.replace(/^pnpm@/, ""), [
        "package.json",
      ]),
    );
  }

  const cargoPath = NodePath.join(root, "Cargo.toml");
  if (NodeFS.existsSync(cargoPath)) {
    const cargo = parseToml(NodeFS.readFileSync(cargoPath, "utf8")) as TomlTable;
    const workspace = isRecord(cargo.workspace) ? cargo.workspace : {};
    const workspacePackage = isRecord(workspace.package) ? workspace.package : {};
    if (typeof workspacePackage["rust-version"] === "string") {
      entries.push(
        toolchainEntry("toolchain:rust", "Rust", workspacePackage["rust-version"], ["Cargo.toml"]),
      );
    }
  }

  const workspacePath = NodePath.join(root, "pnpm-workspace.yaml");
  if (NodeFS.existsSync(workspacePath)) {
    const workspace = parseYaml(NodeFS.readFileSync(workspacePath, "utf8")) as Record<
      string,
      unknown
    >;
    const catalog = stringRecord(workspace.catalog);
    if (catalog.vite !== undefined) {
      entries.push(
        toolchainEntry("toolchain:vite-core", "@voidzero-dev/vite-plus-core", catalog.vite, [
          "pnpm-workspace.yaml",
        ]),
      );
    }
    if (catalog["vite-plus"] !== undefined) {
      entries.push(
        toolchainEntry("toolchain:vite-plus", "vite-plus", catalog["vite-plus"], [
          "pnpm-workspace.yaml",
        ]),
      );
    }
  }

  const packageFiles = walkFiles(root, (relativePath) => relativePath.endsWith("package.json"));
  const tauriCliDeclarations: Array<{ manifest: string; version: string }> = [];
  for (const manifest of packageFiles) {
    const packageJson = readJson(NodePath.join(root, manifest));
    for (const section of DEPENDENCY_SECTIONS) {
      const version = stringRecord(packageJson[section])["@tauri-apps/cli"];
      if (version !== undefined) tauriCliDeclarations.push({ manifest, version });
    }
    for (const script of Object.values(stringRecord(packageJson.scripts))) {
      const match = /@tauri-apps\/cli@([^\s]+)/.exec(script);
      if (match?.[1] !== undefined) tauriCliDeclarations.push({ manifest, version: match[1] });
    }
  }
  if (tauriCliDeclarations.length > 0) {
    entries.push(
      toolchainEntry(
        "toolchain:tauri-cli",
        "@tauri-apps/cli",
        [...new Set(tauriCliDeclarations.map((entry) => entry.version))].toSorted().join(" | "),
        [...new Set(tauriCliDeclarations.map((entry) => entry.manifest))].toSorted(),
      ),
    );
  }

  const devcontainerPath = NodePath.join(root, ".devcontainer/devcontainer.json");
  if (NodeFS.existsSync(devcontainerPath)) {
    const devcontainer = readJson(devcontainerPath);
    if (isRecord(devcontainer.features)) {
      for (const [feature, options] of Object.entries(devcontainer.features).toSorted(
        ([left], [right]) => left.localeCompare(right),
      )) {
        const featurePath = feature.split("/features/")[1] ?? feature;
        const name = featurePath.split(":")[0];
        const version =
          isRecord(options) && typeof options.version === "string"
            ? options.version
            : (feature.split(":").at(-1) ?? "unversioned");
        entries.push(
          toolchainEntry(`toolchain:devcontainer:${name}`, `devcontainer ${name}`, version, [
            ".devcontainer/devcontainer.json",
          ]),
        );
      }
    }
  }
  return entries;
}

export function discoverDependencyInventory(root: string): DependencyInventory {
  const javascript = collectJavaScriptInventory(root);
  const rust = collectRustInventory(root);
  const actions = collectActionInventory(root);
  const toolchains = collectToolchainInventory(root);
  const entries = [...javascript.entries, ...rust, ...actions, ...toolchains].toSorted(
    (left, right) => left.key.localeCompare(right.key),
  );
  const entriesByKey = new Map<string, DependencyInventoryEntry>();
  for (const entry of entries) {
    const existing = entriesByKey.get(entry.key);
    if (existing !== undefined) {
      throw new Error(
        `duplicate dependency inventory key ${entry.key}: ${[
          ...existing.locations,
          ...entry.locations,
        ].join(", ")}`,
      );
    }
    entriesByKey.set(entry.key, entry);
  }
  return {
    entries,
    summary: {
      javascriptDirect: javascript.directCount,
      javascriptLedger: javascript.entries.length,
      rustRegistry: rust.filter((entry) => entry.dependencyKind === "registry").length,
      rustPath: rust.filter((entry) => entry.dependencyKind === "path").length,
      rustGit: rust.filter((entry) => entry.dependencyKind === "git").length,
      actions: actions.length,
      toolchains: toolchains.length,
    },
  };
}

function pluralizedCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function missingString(entry: DependencyLedgerEntry, field: keyof DependencyLedgerEntry): boolean {
  return typeof entry[field] !== "string" || entry[field].trim().length === 0;
}

function normalizedPlatforms(platforms: ReadonlyArray<string>): string {
  return [...new Set(platforms)].toSorted().join(",");
}

const MAX_BASELINE_COMMAND_DURATION_SECONDS = 86_400;
const MAX_BASELINE_COMMAND_NOTE_LENGTH = 2_000;

export function validateDependencyLedger(
  inventory: DependencyInventory,
  ledger: DependencyLedger,
): Array<string> {
  const errors: Array<string> = [];
  for (const field of INVENTORY_SUMMARY_FIELDS) {
    const declared = ledger.inventorySummary?.[field];
    const discovered = inventory.summary[field];
    if (declared !== discovered) {
      errors.push(
        `inventory summary ${field} does not match discovered count: ${String(declared)} != ${discovered}`,
      );
    }
  }

  const ledgerByKey = new Map<string, DependencyLedgerEntry>();
  for (const entry of ledger.dependencies) {
    if (ledgerByKey.has(entry.key)) errors.push(`duplicate ledger key ${entry.key}`);
    ledgerByKey.set(entry.key, entry);
    for (const field of ["current", "target", "channel", "source", "cohort", "status"] as const) {
      if (missingString(entry, field)) errors.push(`${entry.key} is missing ${field}`);
    }
    if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
      errors.push(`${entry.key} is missing platforms`);
    }
    if (!VALID_STATUSES.has(entry.status as DependencyLedgerStatus)) {
      errors.push(`${entry.key} has invalid status ${entry.status}`);
    }
  }

  const baselineCommands: ReadonlyArray<unknown> = Array.isArray(ledger.baseline?.commands)
    ? ledger.baseline.commands
    : [];
  for (const [index, value] of baselineCommands.entries()) {
    if (!isRecord(value)) {
      errors.push(`baseline command at index ${index} is invalid`);
      continue;
    }
    if (typeof value.command !== "string" || value.command.trim().length === 0) {
      errors.push(`baseline command at index ${index} has invalid command`);
    }
    if (typeof value.result !== "string" || value.result.trim().length === 0) {
      errors.push(`baseline command at index ${index} has invalid result`);
    }
    if (
      value.durationSeconds !== undefined &&
      (typeof value.durationSeconds !== "number" ||
        !Number.isInteger(value.durationSeconds) ||
        value.durationSeconds < 0 ||
        value.durationSeconds > MAX_BASELINE_COMMAND_DURATION_SECONDS)
    ) {
      errors.push(`baseline command at index ${index} has invalid durationSeconds`);
    }
    if (
      value.note !== undefined &&
      (typeof value.note !== "string" ||
        value.note.trim().length === 0 ||
        value.note.length > MAX_BASELINE_COMMAND_NOTE_LENGTH)
    ) {
      errors.push(`baseline command at index ${index} has invalid note`);
    }
  }

  const inventoryByKey = new Map(inventory.entries.map((entry) => [entry.key, entry]));
  for (const entry of inventory.entries) {
    const ledgerEntry = ledgerByKey.get(entry.key);
    if (ledgerEntry === undefined) {
      errors.push(`missing ledger entry ${entry.key}`);
      continue;
    }
    if (ledgerEntry.current !== entry.current) {
      errors.push(
        `${entry.key} current value does not match declarations: ${ledgerEntry.current} != ${entry.current}`,
      );
    }
    if (
      entry.platforms !== undefined &&
      Array.isArray(ledgerEntry.platforms) &&
      normalizedPlatforms(ledgerEntry.platforms) !== normalizedPlatforms(entry.platforms)
    ) {
      errors.push(
        `${entry.key} platforms do not match declarations: ${normalizedPlatforms(ledgerEntry.platforms)} != ${normalizedPlatforms(entry.platforms)}`,
      );
    }
  }
  for (const entry of ledger.dependencies) {
    if (!inventoryByKey.has(entry.key) && entry.status !== "removed") {
      errors.push(`${entry.key} is no longer declared and must be marked removed`);
    }
  }

  const hasProgress = ledger.dependencies.some((entry) => PROGRESS_STATUSES.has(entry.status));
  if (hasProgress) {
    for (const command of REQUIRED_BASELINE_COMMANDS) {
      const evidence = baselineCommands.find(
        (entry) => isRecord(entry) && entry.command === command,
      );
      if (!isRecord(evidence) || evidence.result !== "passed") {
        errors.push(`baseline command ${command} did not pass before dependency progress`);
      }
    }
  }
  return errors;
}

function run(): void {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const ledgerPath = NodePath.join(root, "docs/dependency-upgrades/2026-07-17-ledger.json");
  const inventory = discoverDependencyInventory(root);
  const ledger = JSON.parse(NodeFS.readFileSync(ledgerPath, "utf8")) as DependencyLedger;
  const errors = validateDependencyLedger(inventory, ledger);
  if (errors.length > 0) {
    process.stderr.write(`${errors.map((error) => `dependency-ledger: ${error}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${[
      "Dependency ledger is complete",
      `${inventory.summary.javascriptDirect} direct JavaScript dependencies`,
      `${inventory.summary.rustRegistry} registry Rust crates`,
      `${inventory.summary.rustPath} path Rust declarations`,
      pluralizedCount(inventory.summary.rustGit, "Git Rust revision"),
      `${inventory.summary.actions} GitHub Actions`,
      `${inventory.summary.toolchains} toolchain pins`,
      "0 unaccounted entries",
    ].join("; ")}\n`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  NodeURL.pathToFileURL(NodePath.resolve(invokedPath)).href === import.meta.url
) {
  run();
}
