import { describe, expect, it, vi } from "vite-plus/test";

import {
  describeByteLimit,
  downloadWithBridge,
  interpretUploadResponse,
  sendBrowserUpload,
  triggerBrowserDownload,
  uploadUrlFor,
} from "./fileTransfers";

describe("downloadWithBridge", () => {
  it("picks a folder and saves through the bridge", async () => {
    const bridge = {
      pickFolder: vi.fn(async () => "/home/me/Downloads"),
      downloadToFolder: vi.fn(async () => "/home/me/Downloads/src.zip"),
    };
    const outcome = await downloadWithBridge({
      url: "https://h/api/transfers/t",
      fileName: "src.zip",
      bridge,
    });
    expect(bridge.downloadToFolder).toHaveBeenCalledWith({
      url: "https://h/api/transfers/t",
      directory: "/home/me/Downloads",
      fileName: "src.zip",
    });
    expect(outcome).toEqual({ _tag: "Saved", path: "/home/me/Downloads/src.zip" });
  });

  it("reports cancellation when no folder is picked", async () => {
    const bridge = { pickFolder: vi.fn(async () => null), downloadToFolder: vi.fn() };
    expect(await downloadWithBridge({ url: "u", fileName: "f", bridge })).toEqual({
      _tag: "Cancelled",
    });
    expect(bridge.downloadToFolder).not.toHaveBeenCalled();
  });

  it("falls back to a browser download without a bridge", async () => {
    expect(await downloadWithBridge({ url: "u", fileName: "f", bridge: undefined })).toEqual({
      _tag: "BrowserDownload",
      url: "u",
      fileName: "f",
    });
  });

  it("falls back to a browser download when the host cannot stream to a folder", async () => {
    const bridge = { pickFolder: vi.fn(async () => "/home/me/Downloads") };
    expect(await downloadWithBridge({ url: "u", fileName: "f", bridge })).toEqual({
      _tag: "BrowserDownload",
      url: "u",
      fileName: "f",
    });
    expect(bridge.pickFolder).not.toHaveBeenCalled();
  });
});

describe("upload helpers", () => {
  // `URLSearchParams` writes a space as "+", which the server's `url::form_urlencoded::parse`
  // decodes back to a space (see production/http_routes.rs transfer_upload).
  it("builds the upload URL with an encoded name and overwrite flag", () => {
    expect(uploadUrlFor("/api/transfers/t.k", "https://h:3773/", "a b.txt", false)).toBe(
      "https://h:3773/api/transfers/t.k?name=a+b.txt",
    );
    expect(uploadUrlFor("/api/transfers/t.k", "https://h:3773/", "a&b#c.txt", false)).toBe(
      "https://h:3773/api/transfers/t.k?name=a%26b%23c.txt",
    );
    expect(uploadUrlFor("/api/transfers/t.k", "https://h:3773/", "a.txt", true)).toBe(
      "https://h:3773/api/transfers/t.k?name=a.txt&overwrite=1",
    );
  });

  it("interprets server responses", () => {
    expect(interpretUploadResponse(201, '{"relativePath":"dir/a.txt"}')).toEqual({
      _tag: "Uploaded",
      relativePath: "dir/a.txt",
    });
    expect(interpretUploadResponse(409, '{"_tag":"TransferEntryExistsError"}')).toEqual({
      _tag: "Exists",
    });
    expect(interpretUploadResponse(413, '{"_tag":"TransferTooLargeError","limit":4}')).toEqual({
      _tag: "TooLarge",
      limit: 4,
    });
    expect(interpretUploadResponse(500, "boom")._tag).toBe("Failed");
  });

  it("explains a failure the server did not describe", () => {
    expect(interpretUploadResponse(502, "   ")).toEqual({
      _tag: "Failed",
      message: "Upload failed with HTTP 502.",
    });
  });

  it("describes a byte limit the way a person reads it", () => {
    expect(describeByteLimit(1024 ** 3)).toBe("1 GiB");
    expect(describeByteLimit(1.5 * 1024 ** 2)).toBe("1.5 MiB");
    expect(describeByteLimit(2048)).toBe("2 KiB");
    expect(describeByteLimit(900)).toBe("900 bytes");
  });

  it("triggers an anchor download", () => {
    const click = vi.fn();
    const anchor = { click, remove: vi.fn(), href: "", download: "", rel: "" };
    const doc = {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    } as unknown as Document;
    triggerBrowserDownload("https://h/x", "src.zip", doc);
    expect(anchor.href).toBe("https://h/x");
    expect(anchor.download).toBe("src.zip");
    expect(click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
  });

  it("posts a browser upload without credentials, because the token in the URL is the auth", async () => {
    const file = new Blob(["hello"]) as unknown as File;
    const fetchImpl = vi.fn(async () => ({
      status: 201,
      text: async () => '{"relativePath":"a.txt"}',
    }));
    const response = await sendBrowserUpload(
      "https://h/api/transfers/t?name=a.txt",
      file,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledWith("https://h/api/transfers/t?name=a.txt", {
      method: "POST",
      body: file,
      credentials: "omit",
    });
    expect(response).toEqual({ status: 201, body: '{"relativePath":"a.txt"}' });
  });
});
