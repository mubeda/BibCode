import type { EnvironmentId, ScopedThreadRef } from "@bibcode/contracts";
import { isAtomCommandInterrupted } from "@bibcode/client-runtime/state/runtime";

import { getClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";

import { resolvePreviewTarget } from "./browserTargetResolver";
import { type OpenPreviewMutation, openUrlInPreview } from "./openFileInPreview";
import {
  showLinkOpenFailedNotice,
  showPreviewUnreachableMessage,
  showPreviewUnreachableNotice,
} from "./linkNotices";

export type LinkDestination = "app" | "system";
export type OpenLinkOutcome = "app" | "system" | "unreachable" | "unavailable";

export function chooseLinkDestination(input: {
  readonly setting: LinkDestination;
  readonly invert: boolean;
  readonly canUseApp: boolean;
}): LinkDestination {
  if (!input.canUseApp) return "system";
  if (!input.invert) return input.setting;
  return input.setting === "app" ? "system" : "app";
}

export function openLink(input: {
  readonly url: string;
  readonly threadRef: ScopedThreadRef | null;
  /** Resolves server-loopback URLs when there is no thread (e.g. a thread-less terminal). */
  readonly environmentId?: EnvironmentId | null;
  readonly invert: boolean;
  readonly openPreview: OpenPreviewMutation<unknown>;
  /** Called for internal-browser failures only; a system-browser failure shows its own notice. */
  readonly onError?: (cause: unknown) => void;
}): OpenLinkOutcome {
  let url = input.url;
  let viaGateway = false;
  const environmentId = input.threadRef?.environmentId ?? input.environmentId ?? null;
  if (environmentId !== null) {
    const resolution = resolvePreviewTarget(environmentId, url);
    if (resolution.kind === "unreachable") {
      showPreviewUnreachableNotice(resolution);
      return "unreachable";
    }
    // A gateway URL stays canonical: the internal browser resolves it per client.
    url = resolution.url;
    viaGateway = resolution.kind === "gateway";
  }
  const destination = chooseLinkDestination({
    setting: getClientSettings().browserLinkTarget,
    invert: input.invert,
    canUseApp: input.threadRef !== null && isPreviewSupportedInRuntime(),
  });
  if (destination === "system" || input.threadRef === null) {
    if (viaGateway) {
      // ponytail: handing a gateway session to the system browser needs async
      // resolution this synchronous path lacks. Refuse rather than open this
      // computer's own localhost; resolve-then-open is the upgrade path.
      showPreviewUnreachableMessage(
        "Open it in BiBCode's browser instead; opening a server port in your system browser isn't supported yet.",
        url,
      );
      return "unreachable";
    }
    const api = readLocalApi();
    if (!api) return "unavailable";
    // Called synchronously so browser-mode window.open keeps the click's activation.
    api.shell.openExternal(url).catch(() => showLinkOpenFailedNotice(url));
    return "system";
  }
  openUrlInPreview({ threadRef: input.threadRef, url, openPreview: input.openPreview })
    .then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
        input.onError?.(result.cause);
    })
    .catch((cause: unknown) => input.onError?.(cause));
  return "app";
}
