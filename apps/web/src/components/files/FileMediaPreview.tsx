import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { Code2, LoaderCircle, Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { resolveAssetUrl } from "@bibcode/client-runtime/state/assets";
import { assetEnvironment } from "~/state/assets";
import { formatEnvironmentQueryError } from "~/state/query";

import { Button } from "../ui/button";
import type { FilePreviewKind } from "./filePreviewMode";

export type FileMediaKind = Exclude<FilePreviewKind, "text">;

interface FileMediaPreviewProps {
  readonly kind: FileMediaKind;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Absolute path of the file, as the asset route resolves it under the thread's project root. */
  readonly absolutePath: string | null;
  readonly httpBaseUrl: string | null;
  readonly fileName: string;
  /** The header's Open in menu is available, so the notices can point at it. */
  readonly canOpenElsewhere: boolean;
  /** Offered for SVG: show the markup in the text editor instead of the rendered image. */
  readonly onViewSource?: (() => void) | undefined;
}

type MediaFailure = "too-large" | "unreadable";

/**
 * The asset route answers 413 above its size cap and the browser's media elements report only
 * "failed", so a failure asks the route once why. HEAD runs the same checks as GET without
 * sending a body.
 */
async function probeAssetFailure(url: string, signal?: AbortSignal): Promise<MediaFailure | null> {
  try {
    const response = await fetch(url, { method: "HEAD", ...(signal ? { signal } : {}) });
    if (response.ok) return null;
    return response.status === 413 ? "too-large" : "unreadable";
  } catch {
    return "unreadable";
  }
}

function MediaNotice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
      data-file-media-notice
      role="status"
    >
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children ? (
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{children}</p>
      ) : null}
    </div>
  );
}

function FailureNotice({
  failure,
  canOpenElsewhere,
}: {
  failure: MediaFailure;
  canOpenElsewhere: boolean;
}) {
  const next = canOpenElsewhere
    ? "Use Open in above to open it in another app."
    : "Open it from the machine this environment runs on.";
  return failure === "too-large" ? (
    <MediaNotice title="This file is too large to preview">
      Previews are limited to 10 MiB. {next}
    </MediaNotice>
  ) : (
    <MediaNotice title="BiBCode couldn't display this file">
      It may be damaged or in a format this app can't play. {next}
    </MediaNotice>
  );
}

function MediaToolbar({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex h-9 min-h-9 shrink-0 items-center gap-2 border-b border-panel-separator bg-background px-3 text-xs text-muted-foreground"
      data-file-media-toolbar
    >
      {children}
    </div>
  );
}

function ImageSurface({
  url,
  kind,
  fileName,
  onViewSource,
  onFailed,
}: {
  url: string;
  kind: "image" | "svg";
  fileName: string;
  onViewSource: (() => void) | undefined;
  onFailed: () => void;
}) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [actualSize, setActualSize] = useState(false);
  // SVG has no pixel size of its own, so it always fits the panel.
  const fit = kind === "svg" || !actualSize;
  return (
    <>
      <MediaToolbar>
        <span aria-live="polite">
          {size && size.width > 0 ? `${size.width} × ${size.height}` : ""}
        </span>
        {kind === "image" ? (
          <Button
            size="xs"
            variant="ghost"
            aria-label={actualSize ? "Fit image to panel" : "Show image at actual size"}
            onClick={() => setActualSize((current) => !current)}
          >
            {actualSize ? <Minimize2 /> : <Maximize2 />}
            {actualSize ? "Fit" : "Actual size"}
          </Button>
        ) : null}
        {onViewSource ? (
          <Button size="xs" variant="ghost" onClick={onViewSource}>
            <Code2 />
            View source
          </Button>
        ) : null}
      </MediaToolbar>
      <div className="flex min-h-0 flex-1 overflow-auto bg-muted/30 p-4" data-file-media-surface>
        <img
          key={url}
          src={url}
          alt={fileName}
          decoding="async"
          className={fit ? "m-auto max-h-full max-w-full object-contain" : "m-auto max-w-none"}
          onLoad={(event) =>
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={onFailed}
        />
      </div>
    </>
  );
}

function AudioSurface({
  url,
  fileName,
  onFailed,
}: {
  url: string;
  fileName: string;
  onFailed: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-6">
      <audio
        key={url}
        className="w-full max-w-md"
        src={url}
        controls
        preload="metadata"
        aria-label={fileName}
        onError={onFailed}
      />
    </div>
  );
}

function PdfSurface({
  url,
  fileName,
  onFailed,
}: {
  url: string;
  fileName: string;
  onFailed: (failure: MediaFailure) => void;
}) {
  // A frame shows an error response as a page and reports nothing, so ask before showing it.
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void probeAssetFailure(url, controller.signal).then((failure) => {
      if (controller.signal.aborted) return;
      if (failure === null) setChecked(true);
      else onFailed(failure);
    });
    return () => controller.abort();
  }, [url, onFailed]);
  return checked ? (
    // Not an <iframe>: browsers refuse to run their PDF viewer inside a sandboxed frame, and an
    // unsandboxed frame would be the only one in the app.
    <embed
      key={url}
      src={url}
      type="application/pdf"
      title={`${fileName} (PDF)`}
      className="min-h-0 w-full flex-1 bg-background"
    />
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  );
}

function LoadedMedia({
  url,
  kind,
  fileName,
  canOpenElsewhere,
  onViewSource,
}: Pick<FileMediaPreviewProps, "fileName" | "canOpenElsewhere" | "onViewSource"> & {
  url: string;
  kind: FileMediaKind;
}) {
  const [failure, setFailure] = useState<MediaFailure | null>(null);
  if (failure !== null) {
    return <FailureNotice failure={failure} canOpenElsewhere={canOpenElsewhere} />;
  }
  const mediaFailed = () => {
    void probeAssetFailure(url).then((reason) => setFailure(reason ?? "unreadable"));
  };
  return kind === "audio" ? (
    <AudioSurface url={url} fileName={fileName} onFailed={mediaFailed} />
  ) : kind === "pdf" ? (
    <PdfSurface url={url} fileName={fileName} onFailed={setFailure} />
  ) : (
    <ImageSurface
      url={url}
      kind={kind}
      fileName={fileName}
      onViewSource={onViewSource}
      onFailed={mediaFailed}
    />
  );
}

function FileMediaAsset({
  kind,
  environmentId,
  threadId,
  absolutePath,
  httpBaseUrl,
  fileName,
  canOpenElsewhere,
  onViewSource,
}: Omit<FileMediaPreviewProps, "absolutePath" | "httpBaseUrl"> & {
  absolutePath: string;
  httpBaseUrl: string;
}) {
  const asset = useAtomValue(
    assetEnvironment.createUrl({
      environmentId,
      input: { resource: { _tag: "workspace-file", threadId, path: absolutePath } },
    }),
  );
  if (asset._tag === "Failure") {
    return (
      <MediaNotice title="BiBCode couldn't prepare a preview">
        {formatEnvironmentQueryError(asset.cause, "The environment refused the request.")}
      </MediaNotice>
    );
  }
  const url =
    asset._tag === "Success" ? resolveAssetUrl(httpBaseUrl, asset.value.relativeUrl) : null;
  if (url === null) {
    return asset._tag === "Success" ? (
      <MediaNotice title="BiBCode couldn't prepare a preview">
        The environment returned an invalid address for this file.
      </MediaNotice>
    ) : (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }
  // A fresh URL (the signed one is reissued over time) starts from a clean failure state.
  return (
    <LoadedMedia
      key={url}
      url={url}
      kind={kind}
      fileName={fileName}
      canOpenElsewhere={canOpenElsewhere}
      onViewSource={onViewSource}
    />
  );
}

export function FileMediaPreview(props: FileMediaPreviewProps) {
  const { absolutePath, httpBaseUrl } = props;
  if (absolutePath === null || httpBaseUrl === null) {
    return (
      <MediaNotice title="Preview isn't available yet">
        BiBCode is still connecting to this environment.
      </MediaNotice>
    );
  }
  return (
    <FileMediaAsset
      key={absolutePath}
      {...props}
      absolutePath={absolutePath}
      httpBaseUrl={httpBaseUrl}
    />
  );
}
