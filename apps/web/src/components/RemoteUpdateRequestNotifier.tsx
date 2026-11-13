import { useEffect, useRef, useSyncExternalStore } from "react";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { isUpdateInstalling, subscribeLeaveQuestion } from "./files/unsavedFileEdits";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function remoteUpdateRequestToast(
  requestedBy: { readonly label: string; readonly detail: string | null },
  version: string | null,
) {
  const device =
    requestedBy.detail === null
      ? requestedBy.label
      : `${requestedBy.label} on ${requestedBy.detail}`;
  return {
    title: "Update requested from another device",
    description: `${device} is installing ${version === null ? "an update" : `v${version}`}. BiBCode restarts when it's done.`,
  };
}

/** Shown while the installing dialog holds the window: Settings would open beneath it. */
export const MANAGE_DEVICES_AFTER_INSTALL = "Manage devices is available when the update finishes.";

/** Host notice stays informational; remote installs are already authorized by the requesting client. */
export function RemoteUpdateRequestNotifier({
  onManageDevices,
}: {
  readonly onManageDevices: () => void;
}) {
  const state = useDesktopUpdateState();
  const requestedBy = state?.requestedBy ?? null;
  const installing = useSyncExternalStore(
    subscribeLeaveQuestion,
    isUpdateInstalling,
    isUpdateInstalling,
  );
  const manageDevices = useRef(onManageDevices);
  useEffect(() => {
    manageDevices.current = onManageDevices;
  });
  const notice = useRef<{ id: string; text: ReturnType<typeof remoteUpdateRequestToast> } | null>(
    null,
  );
  // Announcing tracks the request; `notice` outlives it, so a block released after the requester
  // cleared still re-enables the action and drops its reason.
  const announced = useRef(false);
  useEffect(() => {
    if (requestedBy === null) {
      announced.current = false;
      return;
    }
    if (announced.current) return;
    announced.current = true;
    const text = remoteUpdateRequestToast(
      requestedBy,
      state?.downloadedVersion ?? state?.availableVersion ?? null,
    );
    const id = toastManager.add(noticeToast(text, isUpdateInstalling(), manageDevices));
    notice.current = { id, text };
  }, [requestedBy, state?.downloadedVersion, state?.availableVersion]);
  useEffect(() => {
    const current = notice.current;
    if (current === null) return;
    toastManager.update(current.id, noticeToast(current.text, installing, manageDevices));
  }, [installing]);
  return null;
}

function noticeToast(
  text: ReturnType<typeof remoteUpdateRequestToast>,
  installing: boolean,
  manageDevices: { readonly current: () => void },
) {
  return stackedThreadToast({
    type: "info",
    title: text.title,
    description: installing
      ? `${text.description} ${MANAGE_DEVICES_AFTER_INSTALL}`
      : text.description,
    actionVariant: "outline",
    actionProps: {
      children: "Manage devices",
      disabled: installing,
      onClick: () => {
        if (!isUpdateInstalling()) manageDevices.current();
      },
    },
  });
}
