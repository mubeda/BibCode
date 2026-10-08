import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const resolvePreviewTarget = vi.fn();
const showPreviewUnreachableNotice = vi.fn();
const openUrlInPreview = vi.fn();
const openExternal = vi.fn();
let previewSupported = true;
let setting: "app" | "system" = "app";

vi.mock("./browserTargetResolver", () => ({ resolvePreviewTarget }));
const showLinkOpenFailedNotice = vi.fn();
const showPreviewUnreachableMessage = vi.fn();
vi.mock("./linkNotices", () => ({
  showPreviewUnreachableNotice,
  showLinkOpenFailedNotice,
  showPreviewUnreachableMessage,
}));
vi.mock("./openFileInPreview", () => ({ openUrlInPreview }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => previewSupported }));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ shell: { openExternal } }) }));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ browserLinkTarget: setting }),
}));

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const openPreview = vi.fn();

describe("chooseLinkDestination", () => {
  it.each([
    ["app", false, true, "app"],
    ["app", true, true, "system"],
    ["system", false, true, "system"],
    ["system", true, true, "app"],
    ["app", false, false, "system"],
    ["system", true, false, "system"],
  ] as const)("setting %s invert %s canUseApp %s -> %s", async (s, invert, canUseApp, want) => {
    const { chooseLinkDestination } = await import("./openLink");
    expect(chooseLinkDestination({ setting: s, invert, canUseApp })).toBe(want);
  });
});

describe("openLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewSupported = true;
    setting = "app";
    openUrlInPreview.mockResolvedValue(AsyncResult.success(undefined));
    openExternal.mockResolvedValue(undefined);
  });

  it("opens resolved loopback URLs in the app", async () => {
    resolvePreviewTarget.mockReturnValue({ kind: "reachable", url: "http://10.0.0.2:5173/" });
    const { openLink } = await import("./openLink");
    expect(openLink({ url: "http://localhost:5173/", threadRef, invert: false, openPreview })).toBe(
      "app",
    );
    expect(openUrlInPreview).toHaveBeenCalledWith({
      threadRef,
      url: "http://10.0.0.2:5173/",
      openPreview,
    });
  });

  it("shows the notice and opens nothing for unreachable targets, even when inverted", async () => {
    const unreachable = { kind: "unreachable", reason: "ssh", environmentLabel: "Box" };
    resolvePreviewTarget.mockReturnValue(unreachable);
    const { openLink } = await import("./openLink");
    expect(openLink({ url: "http://localhost:5173/", threadRef, invert: true, openPreview })).toBe(
      "unreachable",
    );
    expect(showPreviewUnreachableNotice).toHaveBeenCalledWith(unreachable);
    expect(openExternal).not.toHaveBeenCalled();
    expect(openUrlInPreview).not.toHaveBeenCalled();
  });

  it("opens external without awaiting first", async () => {
    resolvePreviewTarget.mockReturnValue({ kind: "reachable", url: "https://example.com/" });
    setting = "system";
    const { openLink } = await import("./openLink");
    openLink({ url: "https://example.com/", threadRef, invert: false, openPreview });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
  });

  it("falls back to the system browser without a thread", async () => {
    const { openLink } = await import("./openLink");
    expect(
      openLink({ url: "https://example.com/", threadRef: null, invert: false, openPreview }),
    ).toBe("system");
    expect(resolvePreviewTarget).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
  });

  it("falls back to the system browser when preview is unsupported", async () => {
    previewSupported = false;
    resolvePreviewTarget.mockReturnValue({ kind: "reachable", url: "https://example.com/" });
    const { openLink } = await import("./openLink");
    expect(openLink({ url: "https://example.com/", threadRef, invert: false, openPreview })).toBe(
      "system",
    );
  });

  it("shows a copyable notice when the system browser fails, without reporting it twice", async () => {
    resolvePreviewTarget.mockReturnValue({ kind: "reachable", url: "https://example.com/" });
    setting = "system";
    openExternal.mockRejectedValue(new Error("no handler"));
    const onError = vi.fn();
    const { openLink } = await import("./openLink");
    openLink({ url: "https://example.com/", threadRef, invert: false, openPreview, onError });
    await vi.waitFor(() =>
      expect(showLinkOpenFailedNotice).toHaveBeenCalledWith("https://example.com/"),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("resolves through the environment when there is no thread", async () => {
    const unreachable = { kind: "unreachable", reason: "ssh", environmentLabel: "Box" };
    resolvePreviewTarget.mockReturnValue(unreachable);
    const { openLink } = await import("./openLink");
    const environmentId = EnvironmentId.make("env-2");
    expect(
      openLink({
        url: "http://localhost:5173/",
        threadRef: null,
        environmentId,
        invert: false,
        openPreview,
      }),
    ).toBe("unreachable");
    expect(resolvePreviewTarget).toHaveBeenCalledWith(environmentId, "http://localhost:5173/");
    expect(showPreviewUnreachableNotice).toHaveBeenCalledWith(unreachable);
    expect(openExternal).not.toHaveBeenCalled();

    resolvePreviewTarget.mockReturnValue({ kind: "reachable", url: "http://10.0.0.2:5173/" });
    expect(
      openLink({
        url: "http://localhost:5173/",
        threadRef: null,
        environmentId,
        invert: false,
        openPreview,
      }),
    ).toBe("system");
    expect(openExternal).toHaveBeenCalledWith("http://10.0.0.2:5173/");
  });

  it("hands the canonical URL of a gateway address to the internal browser", async () => {
    resolvePreviewTarget.mockReturnValue({
      kind: "gateway",
      via: "ssh",
      url: "http://localhost:5173/",
    });
    const { openLink } = await import("./openLink");
    expect(openLink({ url: "http://0.0.0.0:5173/", threadRef, invert: false, openPreview })).toBe(
      "app",
    );
    expect(openUrlInPreview).toHaveBeenCalledWith({
      threadRef,
      url: "http://localhost:5173/",
      openPreview,
    });
  });

  it("never opens a gateway address on this computer's own localhost", async () => {
    resolvePreviewTarget.mockReturnValue({
      kind: "gateway",
      via: "host",
      host: "10.0.0.2",
      url: "http://localhost:5173/",
    });
    setting = "system";
    const { openLink } = await import("./openLink");
    expect(openLink({ url: "http://localhost:5173/", threadRef, invert: false, openPreview })).toBe(
      "unreachable",
    );
    expect(openExternal).not.toHaveBeenCalled();
    expect(showPreviewUnreachableMessage).toHaveBeenCalledWith(
      expect.stringContaining("BiBCode's browser"),
      "http://localhost:5173/",
    );
  });

  it("reports async preview failures through onError", async () => {
    resolvePreviewTarget.mockReturnValue({ kind: "reachable", url: "https://example.com/" });
    const failure = new Error("boom");
    openUrlInPreview.mockRejectedValue(failure);
    const onError = vi.fn();
    const { openLink } = await import("./openLink");
    openLink({ url: "https://example.com/", threadRef, invert: false, openPreview, onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });
});
