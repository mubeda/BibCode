import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@bibcode/client-runtime/state/assets";
import type { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { Code2, LoaderCircle, Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

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

/** The asset route's own response cap; the panel enforces it again on what it received. */
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

type AssetBlobState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly objectUrl: string }
  | { readonly status: "failed"; readonly failure: MediaFailure };

/**
 * Fetches the asset through its capability URL and exposes the bytes as a `blob:` URL the app
 * made itself. The page's content security policy lets media, objects and images load from
 * `blob:` but not from environment origins, so remote and desktop environments preview the same
 * way. The fetch also tells a 413 from a broken file, which an element cannot. The URL is
 * revoked when the asset URL changes or the preview goes away.
 */
export function useAssetBlobUrl(assetUrl: string): AssetBlobState {
  const [state, setState] = useState<AssetBlobState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const fail = (failure: MediaFailure) => {
      if (!controller.signal.aborted) setState({ status: "failed", failure });
    };
    void (async () => {
      try {
        // "no-cache" revalidates, so a file saved since the last view is read again.
        const response = await fetch(assetUrl, {
          cache: "no-cache",
          credentials: "omit",
          signal: controller.signal,
        });
        if (!response.ok) return fail(response.status === 413 ? "too-large" : "unreadable");
        if (Number(response.headers.get("content-length")) > MAX_PREVIEW_BYTES) {
          controller.abort();
          return setState({ status: "failed", failure: "too-large" });
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (blob.size > MAX_PREVIEW_BYTES) return fail("too-large");
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", objectUrl });
      } catch {
        fail("unreadable");
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [assetUrl]);
  return state;
}

function MediaNotice({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
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
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

function ViewSourceButton({ onViewSource }: { onViewSource: () => void }) {
  return (
    <Button size="xs" variant="ghost" onClick={onViewSource}>
      <Code2 />
      View source
    </Button>
  );
}

function FailureNotice({
  failure,
  canOpenElsewhere,
  onViewSource,
}: {
  failure: MediaFailure;
  canOpenElsewhere: boolean;
  onViewSource: (() => void) | undefined;
}) {
  const next = canOpenElsewhere
    ? "Use Open in above to open it in another app."
    : "Open it from the machine this environment runs on.";
  // A broken SVG is still text the user can read and fix.
  const action = onViewSource ? <ViewSourceButton onViewSource={onViewSource} /> : undefined;
  return failure === "too-large" ? (
    <MediaNotice title="This file is too large to preview" action={action}>
      Previews are limited to 10 MiB. {next}
    </MediaNotice>
  ) : (
    <MediaNotice title="BiBCode couldn't display this file" action={action}>
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

function Spinner() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  );
}

function ImageSurface({
  src,
  kind,
  fileName,
  onViewSource,
  onFailed,
}: {
  src: string;
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
        {onViewSource ? <ViewSourceButton onViewSource={onViewSource} /> : null}
      </MediaToolbar>
      <div className="flex min-h-0 flex-1 overflow-auto bg-muted/30 p-4" data-file-media-surface>
        <img
          src={src}
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
  src,
  fileName,
  onFailed,
}: {
  src: string;
  fileName: string;
  onFailed: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-6">
      <audio
        className="w-full max-w-md"
        src={src}
        controls
        preload="metadata"
        aria-label={fileName}
        onError={onFailed}
      />
    </div>
  );
}

function LoadedMedia({
  assetUrl,
  kind,
  fileName,
  canOpenElsewhere,
  onViewSource,
}: Pick<FileMediaPreviewProps, "fileName" | "canOpenElsewhere" | "onViewSource"> & {
  assetUrl: string;
  kind: FileMediaKind;
}) {
  const blob = useAssetBlobUrl(assetUrl);
  const [decodeFailed, setDecodeFailed] = useState(false);
  if (blob.status === "loading") return <Spinner />;
  if (blob.status === "failed" || decodeFailed) {
    return (
      <FailureNotice
        failure={blob.status === "failed" ? blob.failure : "unreadable"}
        canOpenElsewhere={canOpenElsewhere}
        onViewSource={onViewSource}
      />
    );
  }
  const failed = () => setDecodeFailed(true);
  return kind === "audio" ? (
    <AudioSurface src={blob.objectUrl} fileName={fileName} onFailed={failed} />
  ) : kind === "pdf" ? (
    <embed
      src={blob.objectUrl}
      type="application/pdf"
      title={`${fileName} (PDF)`}
      className="min-h-0 w-full flex-1 bg-background"
    />
  ) : (
    <ImageSurface
      src={blob.objectUrl}
      kind={kind}
      fileName={fileName}
      onViewSource={onViewSource}
      onFailed={failed}
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
  const sourceAction = onViewSource ? <ViewSourceButton onViewSource={onViewSource} /> : undefined;
  if (asset._tag === "Failure") {
    return (
      <MediaNotice title="BiBCode couldn't prepare a preview" action={sourceAction}>
        {formatEnvironmentQueryError(asset.cause, "The environment refused the request.")}
      </MediaNotice>
    );
  }
  const assetUrl =
    asset._tag === "Success" ? resolveAssetUrl(httpBaseUrl, asset.value.relativeUrl) : null;
  if (assetUrl === null) {
    return asset._tag === "Success" ? (
      <MediaNotice title="BiBCode couldn't prepare a preview" action={sourceAction}>
        The environment returned an invalid address for this file.
      </MediaNotice>
    ) : (
      <Spinner />
    );
  }
  // A fresh URL (the signed one is reissued over time) starts from a clean state.
  return (
    <LoadedMedia
      key={assetUrl}
      assetUrl={assetUrl}
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
