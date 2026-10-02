import { describe, expect, it } from "vite-plus/test";
import { filePreviewAvailability } from "./openFileInPreview";
const pinned = { route: "in-channel" as const, connected: true };
describe("file resource preview policy", () => {
  it.each(["report.html", "report.PDF", "image.png"])(
    "refuses pinned %s without offering a file HTTP capability",
    (path) => {
      expect(filePreviewAvailability(pinned, path)).toEqual({
        enabled: false,
        reason:
          "Preview isn't available over encrypted connections yet. Download this file to open it.",
      });
    },
  );
  it("refuses missing preparation instead of guessing HTTP", () => {
    expect(filePreviewAvailability(null, "report.html")).toEqual({
      enabled: false,
      reason: "Reconnect to this environment before opening its file preview.",
    });
  });
  it("keeps unpinned HTML/PDF resource previews available", () => {
    expect(filePreviewAvailability({ route: "http", connected: true }, "report.html")).toEqual({
      enabled: true,
    });
    expect(filePreviewAvailability({ route: "http", connected: true }, "report.pdf")).toEqual({
      enabled: true,
    });
  });
});
