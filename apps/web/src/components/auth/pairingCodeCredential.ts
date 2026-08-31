import { parsePairingCode } from "@bibcode/shared/pairingCode";

/** Extracts the one-time pairing-link token carried by a remote-server code. */
export function extractEmbeddedPairingToken(code: string): string | null {
  try {
    const token = parsePairingCode(code).token.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
