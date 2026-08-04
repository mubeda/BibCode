export function readBiBCodeEnvironmentVariable(
  env: Readonly<Record<string, string | undefined>>,
  suffix: string,
): string | undefined {
  return env[`BIBCODE_${suffix}`];
}
