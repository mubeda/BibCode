import { stackedThreadToast, toastManager } from "~/components/ui/toast";

import { type PreviewTargetResolution, UNREACHABLE_MESSAGES } from "./browserTargetResolver";

export function showPreviewUnreachableNotice(
  resolution: Extract<PreviewTargetResolution, { kind: "unreachable" }>,
): void {
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "Can't open this address here",
      description: UNREACHABLE_MESSAGES[resolution.reason](resolution.environmentLabel),
    }),
  );
}

export function showFileOutsideWorkspaceNotice(input: {
  readonly onOpenInEditor: () => void;
}): void {
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: "This file is outside the workspace",
      description: "Only files inside the thread's workspace can open in the browser.",
      actionVariant: "outline",
      actionProps: { children: "Open in editor", onClick: input.onOpenInEditor },
    }),
  );
}

export function showLinkOpenFailedNotice(url: string): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't open the link",
      description: url,
      actionVariant: "outline",
      actionProps: {
        children: "Copy link",
        onClick: () => void navigator.clipboard?.writeText(url).catch(() => undefined),
      },
    }),
  );
}
