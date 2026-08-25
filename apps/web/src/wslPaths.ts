export interface WslUncPath {
  readonly distro: string;
  readonly linuxPath: string;
}

export interface WslEnvironmentCandidate<TEnvironmentId extends string = string> {
  readonly environmentId: TEnvironmentId;
  readonly runningDistro: string | null;
}

export interface WslEnvironmentConfiguration {
  readonly enabled: boolean;
  readonly wslOnly: boolean;
  readonly distro: string | null;
  readonly distros: ReadonlyArray<{
    readonly name: string;
    readonly isDefault: boolean;
  }>;
}

export interface WslProjectSelection<TEnvironmentId extends string = string> extends WslUncPath {
  readonly environmentId: TEnvironmentId;
}

const WSL_UNC_PREFIXES = ["\\\\wsl.localhost\\", "\\\\wsl$\\"] as const;
const WSL_DISTRO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function parseWslUncPath(input: string): WslUncPath | null {
  const normalized = input.trim().replaceAll("/", "\\");
  const prefix = WSL_UNC_PREFIXES.find((candidate) =>
    normalized.toLowerCase().startsWith(candidate.toLowerCase()),
  );
  if (!prefix) {
    return null;
  }

  const rest = normalized.slice(prefix.length);
  const segments = rest.split("\\").filter((segment) => segment.length > 0);
  const distro = segments.shift();
  if (!distro || !WSL_DISTRO_NAME_PATTERN.test(distro)) {
    return null;
  }

  return {
    distro,
    linuxPath: segments.length === 0 ? "/" : `/${segments.join("/")}`,
  };
}

export function resolveWslProjectSelection<TEnvironmentId extends string>(
  input: string,
  candidates: ReadonlyArray<WslEnvironmentCandidate<TEnvironmentId>>,
): WslProjectSelection<TEnvironmentId> | null {
  const parsed = parseWslUncPath(input);
  if (!parsed) {
    return null;
  }

  const exact = candidates.find((candidate) => {
    return candidate.runningDistro?.toLowerCase() === parsed.distro.toLowerCase();
  });
  return exact ? { ...parsed, environmentId: exact.environmentId } : null;
}

interface ConfiguredWslBackend {
  readonly runningDistro: string | null;
}

function resolveConfiguredWslBackend(
  configuration: WslEnvironmentConfiguration | null,
): ConfiguredWslBackend | null {
  if (!configuration) {
    return null;
  }

  if (configuration.distro === null) {
    return { runningDistro: null };
  }

  const configuredDistro = configuration.distro.trim();
  if (configuredDistro.length === 0) {
    return null;
  }

  const installedDistro = configuration.distros.find(
    (distro) => distro.name.toLowerCase() === configuredDistro.toLowerCase(),
  );
  const resolvedDistro = installedDistro?.name ?? configuredDistro;
  return { runningDistro: resolvedDistro };
}

export function resolveProjectPickerDistro<TEnvironmentId extends string>(input: {
  readonly browseEnvironmentId: TEnvironmentId | null;
  readonly primaryEnvironmentId: TEnvironmentId | null;
  readonly candidates: ReadonlyArray<WslEnvironmentCandidate<TEnvironmentId>>;
  readonly wslConfiguration: WslEnvironmentConfiguration | null;
  readonly primaryRunningDistro: string | null;
}): string | null {
  const candidate = input.candidates.find(
    (entry) => entry.environmentId === input.browseEnvironmentId,
  );
  if (candidate?.runningDistro !== null && candidate?.runningDistro !== undefined) {
    return candidate.runningDistro;
  }

  if (
    input.browseEnvironmentId === null ||
    input.browseEnvironmentId !== input.primaryEnvironmentId ||
    !input.wslConfiguration?.enabled ||
    !input.wslConfiguration.wslOnly
  ) {
    return null;
  }

  return (
    input.primaryRunningDistro ??
    resolveConfiguredWslBackend(input.wslConfiguration)?.runningDistro ??
    null
  );
}

export function applyWslEnvironmentConfiguration<TEnvironmentId extends string>(
  candidates: ReadonlyArray<WslEnvironmentCandidate<TEnvironmentId>>,
  primaryEnvironmentId: TEnvironmentId | null,
  configuration: WslEnvironmentConfiguration | null,
  primaryRunningDistro: string | null = null,
): ReadonlyArray<WslEnvironmentCandidate<TEnvironmentId>> {
  if (!configuration) {
    return candidates;
  }

  const configuredBackend = resolveConfiguredWslBackend(configuration);
  if (!configuredBackend) {
    return candidates;
  }

  if (
    configuration.enabled &&
    configuration.wslOnly &&
    primaryEnvironmentId !== null &&
    !candidates.some((candidate) => candidate.environmentId === primaryEnvironmentId)
  ) {
    return [
      ...candidates,
      {
        environmentId: primaryEnvironmentId,
        ...configuredBackend,
        runningDistro: primaryRunningDistro ?? configuredBackend.runningDistro,
      },
    ];
  }

  return candidates;
}
