import type { GitManagerPullRequestsResult } from "@bibcode/contracts";

export type ProviderPanePresentation =
  | { readonly kind: "not-loaded"; readonly message: string }
  | { readonly kind: "loading"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "loaded"; readonly message: string };

export function resolveProviderPanePresentation(input: {
  readonly requested: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly result: GitManagerPullRequestsResult | null;
}): ProviderPanePresentation {
  if (!input.requested) {
    return {
      kind: "not-loaded",
      message: "Pull requests and checks load only when you choose Refresh.",
    };
  }
  if (input.pending) {
    return { kind: "loading", message: "Loading pull requests and checks…" };
  }
  if (input.error !== null) {
    return { kind: "error", message: input.error };
  }
  if (input.result?.status === "unavailable") {
    return {
      kind: "unavailable",
      message: "Pull requests or checks are unavailable for this repository provider.",
    };
  }
  return {
    kind: "loaded",
    message:
      input.result?.pullRequests.length === 0
        ? "No open pull request was found for the current branch."
        : "Pull requests and checks loaded.",
  };
}

export function createPullRequestAction(actionId: string) {
  return { actionId, action: "create_pr" as const };
}
