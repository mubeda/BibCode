// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  AttachmentUploadNotice,
  attachmentUploadCopy,
  attachmentUploadFailureCopy,
  type PendingAttachmentUpload,
} from "./AttachmentUploadNotice";

const progress: PendingAttachmentUpload = {
  attachmentCount: 2,
  fileName: "photo.png",
  sentBytes: 3.1 * 1024 ** 2,
  totalBytes: 20 * 1024 ** 2,
  phase: "uploading",
};

describe("AttachmentUploadNotice", () => {
  it("uses acknowledged progress and singular/plural copy", () => {
    expect(attachmentUploadCopy(progress)).toBe("Uploading 2 attachments — 3.1 of 20 MiB");
    expect(attachmentUploadCopy({ ...progress, attachmentCount: 1 })).toBe(
      "Uploading 1 attachment — 3.1 of 20 MiB",
    );
    expect(attachmentUploadCopy({ ...progress, phase: "reconnecting" })).toBe("Reconnecting…");
  });

  it("explains failure and restoration with a safe cause or a useful generic retry", () => {
    expect(attachmentUploadFailureCopy("photo.png", "the upload expired")).toBe(
      'Couldn\'t upload "photo.png": the upload expired. Your message is back in the composer.',
    );
    expect(attachmentUploadFailureCopy("photo.png", null)).toBe(
      'Couldn\'t upload "photo.png". Your message is back in the composer. Try sending it again.',
    );
  });

  it.each(["uploading", "reconnecting"] as const)(
    "keeps %s progress and Cancel visible",
    (phase) => {
      const markup = renderToStaticMarkup(
        <AttachmentUploadNotice progress={{ ...progress, phase }} onCancel={vi.fn()} />,
      );
      expect(markup).toContain('role="status"');
      expect(markup).toContain("Cancel");
      expect(markup).toContain(phase === "uploading" ? "3.1 of 20 MiB" : "Reconnecting…");
      expect(markup).not.toMatch(/hover:opacity|group-hover|disabled=/u);
    },
  );

  it("provides a focusable Cancel button that invokes cancellation once per click", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const cancel = vi.fn();
    try {
      await act(async () =>
        root.render(<AttachmentUploadNotice progress={progress} onCancel={cancel} />),
      );
      const button = container.querySelector("button")!;
      button.focus();
      expect(document.activeElement).toBe(button);
      await act(async () => button.click());
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
