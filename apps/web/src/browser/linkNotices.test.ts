import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const add = vi.fn();

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add },
  stackedThreadToast: (options: unknown) => options,
}));

describe("link notices", () => {
  beforeEach(() => add.mockReset());

  it("explains why a preview address is unreachable and offers to copy it", async () => {
    const { showPreviewUnreachableNotice } = await import("./linkNotices");
    const { UNREACHABLE_MESSAGES } = await import("./browserTargetResolver");
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    showPreviewUnreachableNotice({
      kind: "unreachable",
      reason: "ssh",
      environmentLabel: "Box",
      url: "http://localhost:3000/",
    });
    const toast = add.mock.calls[0]![0];
    expect(toast).toMatchObject({
      type: "warning",
      title: "Can't open this address here",
      description: `${UNREACHABLE_MESSAGES.ssh("Box")} (http://localhost:3000/)`,
      actionProps: { children: "Copy link" },
    });
    toast.actionProps.onClick();
    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/");
    vi.unstubAllGlobals();
  });

  it("offers the editor when a file can't be previewed", async () => {
    const onOpenInEditor = vi.fn();
    const { showPreviewFailedNotice } = await import("./linkNotices");
    showPreviewFailedNotice({ onOpenInEditor });
    const toast = add.mock.calls[0]![0];
    expect(toast).toMatchObject({
      type: "warning",
      title: "Couldn't preview this file",
      actionProps: { children: "Open in editor" },
    });
    toast.actionProps.onClick();
    expect(onOpenInEditor).toHaveBeenCalledOnce();
  });

  it("offers the editor for files outside the workspace", async () => {
    const onOpenInEditor = vi.fn();
    const { showFileOutsideWorkspaceNotice } = await import("./linkNotices");
    showFileOutsideWorkspaceNotice({ onOpenInEditor });
    const toast = add.mock.calls[0]![0];
    expect(toast).toMatchObject({
      type: "info",
      title: "This file is outside the workspace",
      actionProps: { children: "Open in editor" },
    });
    toast.actionProps.onClick();
    expect(onOpenInEditor).toHaveBeenCalledOnce();
  });

  it("offers to copy a link that failed to open", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { showLinkOpenFailedNotice } = await import("./linkNotices");
    showLinkOpenFailedNotice("https://x.test/");
    const toast = add.mock.calls[0]![0];
    expect(toast).toMatchObject({
      type: "error",
      title: "Couldn't open the link",
      description: "https://x.test/",
      actionProps: { children: "Copy link" },
    });
    toast.actionProps.onClick();
    expect(writeText).toHaveBeenCalledWith("https://x.test/");
    vi.unstubAllGlobals();
  });
});
