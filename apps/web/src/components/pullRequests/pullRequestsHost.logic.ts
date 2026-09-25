/**
 * The repository host's web address, taken from the repository URL the server reported (its
 * origin keeps the scheme and port), or the bare host when that URL does not parse.
 */
export function pullRequestsHostAddress(context: {
  readonly webUrl: string;
  readonly host: string;
}): string {
  try {
    const { origin } = new URL(context.webUrl);
    return origin === "null" ? context.host : origin;
  } catch {
    return context.host;
  }
}
