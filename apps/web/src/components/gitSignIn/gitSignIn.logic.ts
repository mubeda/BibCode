import type { GitSignInDirection } from "@bibcode/contracts";

/** Where a Git Credential Manager sign-in goes, as a `sign-in-required` failure names it (#325). */
export interface GitSignInOffer {
  readonly remote: string;
  readonly destination: string;
  readonly host: string;
  readonly direction: GitSignInDirection;
}

export const SIGN_IN_DECLINED_MESSAGE =
  "Authentication failed. Check the configured credentials and try again.";
export const SIGN_IN_REPEATED_MESSAGE =
  "Signed in, but Git Credential Manager still asked to sign in. Sign in with your own Git, then try again.";
export const SIGN_IN_CANCELLED_MESSAGE = "Sign-in cancelled. Nothing was fetched or pushed.";
export const SIGN_IN_WAITING_MESSAGE =
  "Finish signing in with Git Credential Manager in the window or browser page it opened.";

const MAX_PATH_LENGTH = 48;

/**
 * Host and path of the destination, for the approval title: never user information or a query.
 * A long path is shortened in the middle; the host never is.
 */
export function signInLocation(offer: GitSignInOffer): string {
  let path = "";
  try {
    path = new URL(offer.destination).pathname.replace(/\/+$/, "");
  } catch {
    path = "";
  }
  if (path.length > MAX_PATH_LENGTH) {
    const keep = Math.floor((MAX_PATH_LENGTH - 1) / 2);
    path = `${path.slice(0, keep)}…${path.slice(-keep)}`;
  }
  return `${offer.host}${path}`;
}
