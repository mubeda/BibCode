// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

export interface ThirdPartyNoticePackage {
  readonly ecosystem: "Cargo" | "npm";
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly source: string;
}

interface CargoPackage {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
  readonly source?: unknown;
  readonly repository?: unknown;
  readonly homepage?: unknown;
}

interface CargoNode {
  readonly id?: unknown;
  readonly deps?: ReadonlyArray<{
    readonly pkg?: unknown;
    readonly dep_kinds?: ReadonlyArray<{ readonly kind?: unknown }>;
  }>;
}

const parseObject = (value: string, label: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export function parseCargoNoticePackages(
  metadataText: string,
): ReadonlyArray<ThirdPartyNoticePackage> {
  const metadata = parseObject(metadataText, "Cargo metadata");
  if (!Array.isArray(metadata.packages)) throw new Error("Cargo metadata has no packages array.");
  const packages = new Map<string, CargoPackage>();
  for (const value of metadata.packages) {
    if (!value || typeof value !== "object") continue;
    const entry = value as CargoPackage;
    const id = text(entry.id);
    if (id) packages.set(id, entry);
  }
  const server = [...packages.entries()].find(([, entry]) => entry.name === "bibcode-server");
  if (!server) throw new Error("Cargo metadata does not contain bibcode-server.");
  const resolve = metadata.resolve;
  if (!resolve || typeof resolve !== "object")
    throw new Error("Cargo metadata has no resolve graph.");
  const nodesValue = (resolve as Record<string, unknown>).nodes;
  if (!Array.isArray(nodesValue)) throw new Error("Cargo metadata resolve graph has no nodes.");
  const nodes = new Map<string, CargoNode>();
  for (const value of nodesValue) {
    if (!value || typeof value !== "object") continue;
    const node = value as CargoNode;
    const id = text(node.id);
    if (id) nodes.set(id, node);
  }

  const pending = [server[0]];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    for (const dependency of nodes.get(id)?.deps ?? []) {
      const packageId = text(dependency.pkg);
      const runtime =
        !dependency.dep_kinds ||
        dependency.dep_kinds.length === 0 ||
        dependency.dep_kinds.some((kind) => kind.kind === null || kind.kind === undefined);
      if (packageId && runtime) pending.push(packageId);
    }
  }

  const notices: ThirdPartyNoticePackage[] = [];
  for (const id of visited) {
    if (id === server[0]) continue;
    const entry = packages.get(id);
    if (!entry || entry.source === null || entry.source === undefined) continue;
    const name = text(entry.name);
    const version = text(entry.version);
    const license = text(entry.license);
    if (!name || !version || !license) {
      throw new Error(`Cargo dependency ${name ?? id} has incomplete license metadata.`);
    }
    notices.push({
      ecosystem: "Cargo",
      name,
      version,
      license,
      source: text(entry.repository) ?? text(entry.homepage) ?? text(entry.source) ?? "crates.io",
    });
  }
  return sortPackages(notices);
}

interface PnpmListPackage {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly path?: unknown;
  readonly dependencies?: unknown;
}

interface PackageJsonLicense {
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly repository?: unknown;
  readonly homepage?: unknown;
}

type ReadPackageJson = (path: string) => PackageJsonLicense;

const defaultReadPackageJson: ReadPackageJson = (path) =>
  JSON.parse(NodeFS.readFileSync(path, "utf8")) as PackageJsonLicense;

const repositoryUrl = (value: unknown): string | undefined => {
  if (typeof value === "string") return text(value);
  if (value && typeof value === "object") return text((value as Record<string, unknown>).url);
  return undefined;
};

const packageLicense = (manifest: PackageJsonLicense): string | undefined => {
  const direct = text(manifest.license);
  if (direct) return direct;
  if (!Array.isArray(manifest.licenses)) return undefined;
  const values = manifest.licenses.flatMap((value) => {
    if (typeof value === "string") return text(value) ?? [];
    if (value && typeof value === "object") {
      return text((value as Record<string, unknown>).type) ?? [];
    }
    return [];
  });
  return values.length > 0 ? [...new Set(values)].join(" OR ") : undefined;
};

export function parsePnpmNoticePackages(
  listText: string,
  readPackageJson: ReadPackageJson = defaultReadPackageJson,
): ReadonlyArray<ThirdPartyNoticePackage> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listText);
  } catch {
    throw new Error("pnpm production dependency list is not valid JSON.");
  }
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  const pending: PnpmListPackage[] = [];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    const dependencies = (root as PnpmListPackage).dependencies;
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      pending.push(...(Object.values(dependencies) as PnpmListPackage[]));
    }
  }
  const notices = new Map<string, ThirdPartyNoticePackage>();
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) continue;
    const dependencies = entry.dependencies;
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      pending.push(...(Object.values(dependencies) as PnpmListPackage[]));
    }
    const name = text(entry.name);
    const version = text(entry.version);
    const packageRoot = text(entry.path);
    if (!name || !version || !packageRoot || name.startsWith("@bibcode/")) continue;
    const key = `${name}@${version}`;
    if (notices.has(key)) continue;
    const manifest = readPackageJson(NodePath.join(packageRoot, "package.json"));
    const license = packageLicense(manifest);
    if (!license) throw new Error(`npm dependency ${key} has incomplete license metadata.`);
    notices.set(key, {
      ecosystem: "npm",
      name,
      version,
      license,
      source: repositoryUrl(manifest.repository) ?? text(manifest.homepage) ?? "npm registry",
    });
  }
  return sortPackages([...notices.values()]);
}

interface InstalledPackageJson extends PackageJsonLicense {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly dependencies?: unknown;
  readonly optionalDependencies?: unknown;
}

const installedPackageManifest = (packageName: string, parentManifest: string): string => {
  let directory = NodePath.dirname(parentManifest);
  for (;;) {
    const candidate = NodePath.join(directory, "node_modules", packageName, "package.json");
    if (NodeFS.existsSync(candidate)) return candidate;
    const parent = NodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const require = NodeModule.createRequire(parentManifest);
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch {
    let current = NodePath.dirname(require.resolve(packageName));
    for (;;) {
      const candidate = NodePath.join(current, "package.json");
      if (NodeFS.existsSync(candidate)) {
        const manifest = JSON.parse(NodeFS.readFileSync(candidate, "utf8")) as InstalledPackageJson;
        if (manifest.name === packageName) return candidate;
      }
      const parent = NodePath.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error(`Installed production dependency ${packageName} has no resolvable package.json.`);
};

const dependencyEntries = (
  manifest: InstalledPackageJson,
): ReadonlyArray<{ readonly name: string; readonly optional: boolean }> => {
  const names = new Map<string, boolean>();
  for (const [value, optional] of [
    [manifest.dependencies, false],
    [manifest.optionalDependencies, true],
  ] as const) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const name of Object.keys(value)) {
      names.set(name, (names.get(name) ?? true) && optional);
    }
  }
  return [...names].map(([name, optional]) => ({ name, optional }));
};

export function collectInstalledPnpmNoticePackages(
  rootPackageJsonPath: string,
): ReadonlyArray<ThirdPartyNoticePackage> {
  const rootManifestPath = NodeFS.realpathSync(rootPackageJsonPath);
  const rootManifest = JSON.parse(
    NodeFS.readFileSync(rootManifestPath, "utf8"),
  ) as InstalledPackageJson;
  const pending = dependencyEntries(rootManifest).map((dependency) => ({
    ...dependency,
    parentManifest: rootManifestPath,
  }));
  const visitedManifests = new Set<string>();
  const notices = new Map<string, ThirdPartyNoticePackage>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    let resolvedManifest: string;
    try {
      resolvedManifest = installedPackageManifest(item.name, item.parentManifest);
    } catch (error) {
      if (item.optional) continue;
      throw error;
    }
    const manifestPath = NodeFS.realpathSync(resolvedManifest);
    if (visitedManifests.has(manifestPath)) continue;
    visitedManifests.add(manifestPath);
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as InstalledPackageJson;
    const name = text(manifest.name);
    if (!name) {
      throw new Error(`Installed production dependency at ${manifestPath} has no identity.`);
    }
    for (const dependency of dependencyEntries(manifest)) {
      pending.push({ ...dependency, parentManifest: manifestPath });
    }
    if (name.startsWith("@bibcode/")) continue;
    const version = text(manifest.version);
    if (!version) {
      throw new Error(`Installed production dependency ${name} has no version.`);
    }
    const license = packageLicense(manifest);
    if (!license) {
      throw new Error(`npm dependency ${name}@${version} has incomplete license metadata.`);
    }
    notices.set(`${name}@${version}`, {
      ecosystem: "npm",
      name,
      version,
      license,
      source: repositoryUrl(manifest.repository) ?? text(manifest.homepage) ?? "npm registry",
    });
  }
  return sortPackages([...notices.values()]);
}

const sortPackages = (
  packages: ReadonlyArray<ThirdPartyNoticePackage>,
): ReadonlyArray<ThirdPartyNoticePackage> =>
  packages.toSorted((left, right) => {
    for (const pair of [
      [left.name, right.name],
      [left.version, right.version],
      [left.ecosystem, right.ecosystem],
    ] as const) {
      const result = Buffer.compare(Buffer.from(pair[0], "utf8"), Buffer.from(pair[1], "utf8"));
      if (result !== 0) return result;
    }
    return 0;
  });

const markdownCell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");

export function generateThirdPartyNoticesMarkdown(
  packages: ReadonlyArray<ThirdPartyNoticePackage>,
): string {
  const unique = new Map<string, ThirdPartyNoticePackage>();
  for (const entry of packages) {
    if (!entry.name || !entry.version || !entry.license.trim()) {
      throw new Error(
        `Third-party dependency ${entry.name || "<unknown>"} has no license metadata.`,
      );
    }
    unique.set(`${entry.ecosystem}:${entry.name}:${entry.version}`, entry);
  }
  const rows = sortPackages([...unique.values()]).map(
    (entry) =>
      `| ${markdownCell(entry.ecosystem)} | ${markdownCell(entry.name)} | ${markdownCell(entry.version)} | ${markdownCell(entry.license)} | ${markdownCell(entry.source)} |`,
  );
  return `# Third-Party Notices

This inventory is generated from the locked production dependency graphs used to build BiBCode Server and its compiled web interface. Package licenses remain authoritative.

| Ecosystem | Package | Version | License | Source |
| --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
}
