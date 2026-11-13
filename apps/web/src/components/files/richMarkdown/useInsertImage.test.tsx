// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  createUploadUrl: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.createUploadUrl }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { createUploadUrl: {} } }));
vi.mock("~/state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => "http://example-server:3773",
}));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (options: Record<string, unknown>) => options,
  toastManager: { add: (toast: unknown) => mocks.toastAdd(toast) },
}));

import type { RichMarkdownEditor } from "./richMarkdownExtensions";
import { useInsertImage } from "./useInsertImage";

type UploadResponse = { status: number; body: string };

let container: HTMLDivElement;
let root: Root;
let insertImage: ReturnType<typeof vi.fn<(path: string) => void>>;
let uploadFile: ReturnType<
  typeof vi.fn<(input: { url: string; path: string }) => Promise<UploadResponse>>
>;

function fakeEditor(): RichMarkdownEditor {
  insertImage = vi.fn();
  return { insertImage } as unknown as RichMarkdownEditor;
}

const probe = { pick: () => {} };

function Probe(props: { markdownPath: string; editor: RichMarkdownEditor | null }) {
  const image = useInsertImage({ cwd: "/workspace", environmentId: "environment-1", ...props });
  useEffect(() => {
    probe.pick = image.pick;
  });
  return <input {...image.inputProps} />;
}

async function render(props: { markdownPath: string; editor: RichMarkdownEditor | null }) {
  await act(async () => root.render(<Probe {...props} />));
}

function bridgePicks(path: string) {
  (window as unknown as { desktopBridge: unknown }).desktopBridge = {
    pickFiles: vi.fn(async () => [path]),
    uploadFile,
  };
}

const created = { status: 201, body: JSON.stringify({ relativePath: "docs/diagram.png" }) };
const taken = { status: 409, body: "{}" };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.toastAdd.mockReset();
  mocks.createUploadUrl
    .mockReset()
    .mockImplementation(async ({ input }: { input: { fileName: string } }) => ({
      _tag: "Success",
      value: { relativeUrl: `/api/transfers/upload.${input.fileName}` },
    }));
  uploadFile = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { desktopBridge?: unknown }).desktopBridge;
});

describe("useInsertImage", () => {
  it("a picked image is copied next to the markdown file and linked", async () => {
    uploadFile.mockResolvedValue(created);
    bridgePicks("pictures/diagram.png");
    await render({ markdownPath: "docs/guide.md", editor: fakeEditor() });

    await act(async () => probe.pick());

    await vi.waitFor(() => expect(insertImage).toHaveBeenCalledOnce());
    expect(mocks.createUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { cwd: "/workspace", relativeDirectory: "docs", fileName: "diagram.png" },
      }),
    );
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "pictures/diagram.png" }),
    );
    expect(insertImage).toHaveBeenCalledWith("diagram.png");
  });

  it("passes the file name unencoded, because the editor encodes the link", async () => {
    uploadFile.mockResolvedValue(created);
    bridgePicks("pictures/my image#1.png");
    await render({ markdownPath: "docs/guide.md", editor: fakeEditor() });

    await act(async () => probe.pick());

    await vi.waitFor(() => expect(insertImage).toHaveBeenCalledWith("my image#1.png"));
  });

  it("a taken name gets a numbered suffix and nothing is overwritten", async () => {
    uploadFile.mockResolvedValueOnce(taken).mockResolvedValueOnce(created);
    bridgePicks("pictures/diagram.png");
    await render({ markdownPath: "docs/guide.md", editor: fakeEditor() });

    await act(async () => probe.pick());

    await vi.waitFor(() => expect(insertImage).toHaveBeenCalledWith("diagram-1.png"));
    expect(mocks.createUploadUrl.mock.calls.map(([call]) => call.input.fileName)).toEqual([
      "diagram.png",
      "diagram-1.png",
    ]);
    for (const [request] of uploadFile.mock.calls) {
      expect(request.url).not.toContain("overwrite=1");
    }
  });

  it("a failed copy shows an error and inserts nothing", async () => {
    uploadFile.mockResolvedValue({ status: 500, body: JSON.stringify({ message: "Disk full." }) });
    bridgePicks("pictures/diagram.png");
    await render({ markdownPath: "docs/guide.md", editor: fakeEditor() });

    await act(async () => probe.pick());

    await vi.waitFor(() => expect(mocks.toastAdd).toHaveBeenCalledOnce());
    expect(mocks.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "Disk full." }),
    );
    expect(insertImage).not.toHaveBeenCalled();
  });

  it("a non-image file is refused before any upload", async () => {
    bridgePicks("notes/plan.txt");
    await render({ markdownPath: "docs/guide.md", editor: fakeEditor() });

    await act(async () => probe.pick());

    await vi.waitFor(() => expect(mocks.toastAdd).toHaveBeenCalledOnce());
    expect(mocks.createUploadUrl).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(insertImage).not.toHaveBeenCalled();
  });

  it("an upload that finishes after the file was closed or replaced inserts nothing", async () => {
    let finish!: (response: UploadResponse) => void;
    uploadFile.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    bridgePicks("pictures/diagram.png");
    const editor = fakeEditor();
    await render({ markdownPath: "docs/guide.md", editor });

    await act(async () => probe.pick());
    await vi.waitFor(() => expect(uploadFile).toHaveBeenCalled());
    await render({ markdownPath: "docs/guide.md", editor: fakeEditor() });
    const replacement = insertImage;
    await act(async () => finish(created));

    expect(editor.insertImage).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
  });
});
