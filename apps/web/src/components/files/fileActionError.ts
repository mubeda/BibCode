import { sanitizeFrontendLogText } from "~/diagnostics/frontendLogCapture";

/** Preserve useful file failures while keeping signed capabilities out of UI and diagnostics. */
export function fileActionErrorMessage(error: unknown): string {
  const failure =
    typeof error === "object" && error !== null && "failure" in error
      ? (error as { failure?: unknown }).failure
      : undefined;
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? error.message
        : undefined;
  return sanitizeFrontendLogText(
    failure === "resolved_path_outside_root"
      ? "Can't operate on a symlink that points outside the workspace."
      : typeof message === "string" && message.trim()
        ? message
        : "An error occurred.",
  ).replace(/\/api\/transfers\/[^\s"'<>)]*/g, "/api/transfers/[REDACTED]");
}
