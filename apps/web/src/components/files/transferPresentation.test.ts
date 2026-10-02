import { expect, it } from "vite-plus/test";
import {
  transferProgressCopy,
  transferUnavailableCopy,
  transferErrorMessage,
  transferBusyCopy,
} from "./transferPresentation";
it("uses approved transfer copy and total units", () => {
  expect(
    transferProgressCopy({
      direction: "download",
      fileName: "report.zip",
      sentBytes: 120 * 1024 ** 2,
      totalBytes: 900 * 1024 ** 2,
      phase: "transferring",
    }),
  ).toBe("Downloading report.zip — 120 of 900 MiB");
  expect(
    transferProgressCopy({
      direction: "download",
      fileName: "src.zip",
      sentBytes: 120 * 1024 ** 2,
      totalBytes: null,
      phase: "transferring",
    }),
  ).toBe("Downloading src.zip — 120 MiB");
  expect(
    transferProgressCopy({
      direction: "upload",
      fileName: "photo.png",
      sentBytes: 3 * 1024 ** 2,
      totalBytes: 10 * 1024 ** 2,
      phase: "transferring",
    }),
  ).toBe("Uploading photo.png — 3 of 10 MiB");
});
it("shows reconnecting and actionable unavailable/busy reasons", () => {
  expect(
    transferProgressCopy({
      direction: "download",
      fileName: "report.zip",
      sentBytes: 10,
      totalBytes: 20,
      phase: "reconnecting",
    }),
  ).toBe("Reconnecting…");
  expect(transferUnavailableCopy("Studio")).toBe(
    "Update Studio to transfer files over its encrypted connection",
  );
  expect(transferBusyCopy("running")).toBe("Finish or cancel the current transfer.");
  expect(transferBusyCopy("ready")).toBe(
    "Save or dismiss the ready download before starting another.",
  );
});
it("keeps nonblank native and structured messages", () => {
  expect(transferErrorMessage(" Disk is full. ", "Failed.")).toBe("Disk is full.");
  expect(transferErrorMessage(new Error("Pick another folder."), "Failed.")).toBe(
    "Pick another folder.",
  );
  expect(transferErrorMessage({ message: "Permission denied." }, "Failed.")).toBe(
    "Permission denied.",
  );
  expect(transferErrorMessage("  ", "Failed.")).toBe("Failed.");
});
