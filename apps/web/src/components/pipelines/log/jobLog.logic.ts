import type { PipelinesLogUnavailableReason } from "@bibcode/contracts";
import type { JobLogReaderState } from "./jobLogReader";
import type { JobLogSource } from "./useJobLogController";

/** How close to the end (in px) still counts as following the log. */
export const FOLLOW_THRESHOLD_PX = 24;

/** Whether a scroll position is at the end of the log, so new lines keep it there. */
export function logScrolledToEnd(event: {
  readonly contentOffset: { readonly y: number };
  readonly contentSize: { readonly height: number };
  readonly layoutMeasurement: { readonly height: number };
}): boolean {
  return (
    event.contentOffset.y + event.layoutMeasurement.height >=
    event.contentSize.height - FOLLOW_THRESHOLD_PX
  );
}

export interface JobLogStatusCopy {
  readonly message: string;
  readonly tone: "info" | "error";
  /** The failed read can be sent again. */
  readonly retry: boolean;
  /** Offer the host's own page for this log. */
  readonly link: boolean;
}

function unavailableCopy(
  reason: PipelinesLogUnavailableReason,
  source: JobLogSource,
  hostName: string,
): JobLogStatusCopy {
  const info = (message: string, link = false): JobLogStatusCopy => ({
    message,
    tone: "info",
    retry: false,
    link,
  });
  switch (reason) {
    case "not_started":
      return info(
        source._tag === "live" && source.started
          ? "Waiting for the job's first output."
          : "This job hasn't started yet.",
      );
    case "no_output":
      return info("This job didn't produce a log.");
    case "erased":
      return info("This job's log was erased.");
    case "expired":
      return info("This log has expired.", true);
    case "live_on_host":
      return info(`${hostName} shows live logs on its site.`, true);
    case "too_large_live":
      return info(
        `This running log is over 2 MB. BiBCode shows it once the job finishes; ${hostName} shows the live end.`,
        true,
      );
  }
}

/** What the log says under its lines, or `null` when it has nothing to add. */
export function jobLogStatusCopy({
  source,
  reader,
  hostName,
}: {
  source: JobLogSource;
  reader: JobLogReaderState;
  hostName: string;
}): JobLogStatusCopy | null {
  if (source._tag === "unavailable") return unavailableCopy(source.reason, source, hostName);
  if (reader.error !== null || reader.errorMessage !== null) {
    switch (reader.error?.code) {
      case "forbidden":
        return {
          message: "You can't view this job's log.",
          tone: "error",
          retry: false,
          link: true,
        };
      case "not_found":
        return { message: "This job no longer exists.", tone: "error", retry: false, link: false };
      default:
        return {
          message:
            reader.error?.message ?? reader.errorMessage ?? "BiBCode couldn't read this log.",
          tone: "error",
          retry: true,
          link: false,
        };
    }
  }
  if (reader.unavailable !== null)
    return unavailableCopy(reader.unavailable.reason, source, hostName);
  return null;
}
