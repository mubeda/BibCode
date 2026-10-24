import type { DeviceAvailabilityKind, DevicePlatform, DeviceSnapshot } from "@bibcode/contracts";
import { isQueryTransportCutoff } from "@bibcode/client-runtime/state/runtime";

/** The Settings → Mobile emulators section the pane's "Open settings" lands on, suffixed by environment. */
export const DEVICE_PREVIEWS_SETTINGS_ANCHOR = "device-previews";

/** Shown wherever device previews are off, with a way to Settings next to it. */
export const DEVICE_PREVIEWS_OFF_MESSAGE =
  "Device previews are off. Turn them on in Settings → Mobile emulators.";

export const DEVICE_PREVIEWS_UNSUPPORTED_MESSAGE =
  "This server's BiBCode version has no device previews. Update the server to use them.";

export const DEVICE_PREVIEWS_DESCRIPTION =
  "Android emulators and, on macOS servers, iOS simulators.";

/** The picker's heading for each platform's images. */
export const PLATFORM_LABELS: Readonly<Record<DevicePlatform, string>> = {
  android: "Android",
  ios: "iOS",
};

/** Appended to an image that already runs outside BiBCode, which the picker lists disabled. */
export const IN_USE_ELSEWHERE_SUFFIX = " — Running outside BiBCode";

/** The most devices one server runs at once; it refuses a fifth. */
export const MAX_RUNNING_DEVICES = 4;

/**
 * Appended to an image whose device runs: in this thread, in another thread (by its title, once
 * known), or with no owner. The picker still lists it, so the user need not remember it.
 */
export function runningSuffix(
  owner:
    | { readonly kind: "here" }
    | { readonly kind: "thread"; readonly title: string | null }
    | { readonly kind: "none" },
): string {
  if (owner.kind === "here") return " — Running here";
  if (owner.kind === "thread" && owner.title !== null) return ` — Running in ${owner.title}`;
  return " — Running";
}

/** Under the toolbar while the pane shows a device another thread started. */
export const startedInNote = (title: string | null) =>
  title === null ? "Started in another thread." : `Started in ${title}.`;

/** The confirmation before stopping a device another thread started. */
export const stopConfirmTitle = (name: string) => `Stop ${name}?`;
export const stopConfirmDescription = (title: string | null) =>
  `It was started in ${title ?? "another thread"}.`;

/** When no image is free to start: each one runs, in another thread or this one. */
export const EVERY_DEVICE_RUNNING_MESSAGE = "Every device is running. Pick one to show it.";

/** A device that stopped, shown until it starts again or drops out of the catalog. */
export const stoppedTitle = (name: string) => `${name} stopped.`;
/** What Start does for a stopped device: this thread's, or nobody's, starts again. */
export const STOPPED_RESTART_HINT = "Press Start to start it again.";
/** What Start does for a device another thread started and that stopped. */
export const STOPPED_START_HINT = "Press Start to start it.";

/**
 * The availability kinds whose images still open, as screenshots without input: the platform
 * is listed with its images, and its devices show why they are view only.
 */
export function isViewOnlyAvailability(kind: DeviceAvailabilityKind): boolean {
  return kind === "xcodeUnsupported" || kind === "viewOnlyHeadless";
}

/** Shown once, after the first paste into an iOS simulator. */
export const IOS_PASTE_NOTE =
  "If iOS asks to Allow Paste, answer it before typing more: keys typed meanwhile can arrive before the pasted text.";

/** Shown for a few seconds when a rotate leaves the device as it was. */
export const rotateKeptNote = (name: string) =>
  `${name} didn't rotate. The app on screen may lock its orientation, or auto-rotate may be off on the device.`;

/** The Paste button's tooltip, per platform. */
export const PASTE_HINTS: Readonly<Record<DevicePlatform, string>> = {
  android: "Paste",
  ios: "Paste. iOS may ask to Allow Paste first.",
};

/** When the browser will not hand the clipboard to the Paste button. */
export const CLIPBOARD_UNREADABLE_MESSAGE =
  "BiBCode can't read the clipboard here. Click the screen and paste with Ctrl+V or ⌘V.";

/** Why a toolbar control is disabled; every disabled control says one of these. */
export const DEVICE_DISABLED_REASONS = {
  startFirst: "Start the device first",
  notBooted: "Available once the device has booted",
  stopping: "The device is stopping",
  alreadyRunning: "The device is already running",
  limit: "Four devices are running. Stop one to start another.",
  noAvd: "Create a virtual device in Android Studio's Device Manager first",
  noImage: "No device can start on this server",
  pickFirst: "Pick a device first",
  starting: "The device is starting",
  cannotRotate: "Rotation isn't available for iOS simulators yet",
  rotating: "Rotating…",
  viewOnly: "This simulator is view only",
} as const;

/** Why the screen shows still images (JPEG) instead of video. */
export type StillImagesReason =
  | "unsupported"
  | "noVideo"
  | "noFirstFrame"
  | "decoderError"
  | "rejected";

/** Why the screen shows still images, in the words its badge shows. */
export interface StillImages {
  readonly reason: StillImagesReason;
  readonly message: string;
}

/** The toolbar badge shown while the screen updates as still images. */
export const STILL_IMAGES_LABEL = "Still images";

/** The badge's tooltip: why there is no video, and what to do about it. */
export const STILL_IMAGES_REASONS: Readonly<Record<StillImagesReason, string>> = {
  unsupported:
    "Video isn't available in this browser or on this connection, so the screen updates as still images. The desktop app or an HTTPS connection usually shows video.",
  // The server says why (no sign-in, or a view-only simulator); this is only its fallback.
  noVideo: "The server has no video for this device, so the screen updates as still images.",
  noFirstFrame:
    "Video did not start, so the screen updates as still images. Reopen the device panel to try video again.",
  decoderError:
    "Video could not be decoded, so the screen updates as still images. Reopen the device panel to try video again.",
  rejected:
    "The server refused video, or the video connection kept failing, so the screen updates as still images. This happens when too many video viewers are connected to this device. Reopen the device panel to try video again.",
};

const AVAILABILITY_TITLES: Readonly<Record<DeviceAvailabilityKind, string>> = {
  ready: "Devices ready",
  sdkMissing: "Android SDK not found",
  adbMissing: "Android platform-tools missing",
  noAvds: "No virtual devices",
  accelerationUnavailable: "Hardware acceleration unavailable",
  xcodeMissing: "Xcode not found",
  xcodeSetupIncomplete: "Xcode setup incomplete",
  noSimulators: "No simulators",
  xcodeUnsupported: "Xcode version not supported",
  viewOnlyHeadless: "View only",
};

/** The heading above the server's own explanation of why no device can start. */
export function availabilityTitle(kind: DeviceAvailabilityKind): string {
  return AVAILABILITY_TITLES[kind];
}

/** The state pill text, such as `Booting…` or `Failed: <reason>`. */
export function deviceStateLabel(device: DeviceSnapshot): string {
  switch (device.state) {
    case "starting":
      return "Starting…";
    case "booting":
      return "Booting…";
    case "ready":
      return "Ready";
    case "stopping":
      return "Stopping…";
    case "stopped":
      return "Stopped";
    case "failed":
      return `Failed: ${device.failure ?? (device.platform === "ios" ? "the simulator stopped unexpectedly" : "the emulator stopped unexpectedly")}`;
  }
}

/** A device RPC failure, as the pane shows it. */
export interface DeviceErrorView {
  readonly message: string;
  /** A start was refused at the device limit; the pane offers to stop each live device. */
  readonly limit: boolean;
  /** Device previews were turned off meanwhile; the pane offers Settings. */
  readonly disabled: boolean;
}

const CONNECTION_DROPPED = "The connection to the server dropped. Try again once it reconnects.";

function taggedField(error: unknown, field: string): string | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Maps a device RPC failure to actionable copy. The server's messages already say what to do
 * (set `ANDROID_HOME`, create an AVD, stop a running device, try again), so they are kept;
 * the pane adds the action buttons.
 */
export function describeDeviceError(error: unknown, fallback: string): DeviceErrorView {
  const tag = taggedField(error, "_tag");
  const message = taggedField(error, "message");
  const plain = (text: string): DeviceErrorView => ({
    message: text,
    limit: false,
    disabled: false,
  });
  switch (tag) {
    case "DevicePreviewsDisabledError":
      return { message: DEVICE_PREVIEWS_OFF_MESSAGE, limit: false, disabled: true };
    case "DeviceLimitError":
      // The server says which limit: four devices, or one per platform on an older server.
      return {
        message: message ?? "Too many devices are running. Stop one to start another.",
        limit: true,
        disabled: false,
      };
    case "DeviceBusyError":
      return plain(
        message ??
          "This device is already running outside BiBCode. Shut it down there, then open it here.",
      );
    case "DeviceSdkUnavailableError":
      return plain(message ?? "The Android SDK is not available on this server.");
    case "DeviceNotFoundError":
      return plain(message ?? "This device is no longer running. Start it again.");
    case "DeviceNotReadyError":
      return plain(message ?? "The device is not ready yet. Try again in a moment.");
    case "DeviceInputError":
      return plain(message ?? "The device did not accept that input.");
    case "DeviceEmulatorError":
      return plain(
        message ??
          "The emulator did not respond. Try again; if it keeps failing, stop the device and start it again.",
      );
    default:
      if (isQueryTransportCutoff(error)) return plain(CONNECTION_DROPPED);
      return plain(fallback);
  }
}
