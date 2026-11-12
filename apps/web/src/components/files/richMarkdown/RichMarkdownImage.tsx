import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@bibcode/client-runtime/state/assets";
import type { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { ImageOff } from "lucide-react";
import { useState } from "react";

import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";

import { useAssetBlobUrl } from "../FileMediaPreview";
import { joinWorkspacePath } from "../FileTreeContextMenu.logic";
import { resolveRichMarkdownImageSource } from "./richMarkdownImageSource";

/** The Markdown file the rendered view shows, and where its images are read from. */
export interface RichMarkdownWorkspace {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  /** The Markdown file, relative to `cwd`. */
  readonly markdownPath: string;
}

interface ImageProps {
  readonly src: string;
  readonly alt: string;
}

const unreadable = (src: string) => `Couldn't read ${src}. Check that the file exists.`;

/** The image's own text, shown while it loads and when it can't be shown. */
function ImageText({ src, alt, problem }: ImageProps & { problem: string | null }) {
  const label = alt || src.slice(src.lastIndexOf("/") + 1) || src;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm bg-muted px-1 text-muted-foreground"
      data-rich-markdown-image-text={problem ? "failed" : "loading"}
      role="img"
      aria-label={problem ? `${label}. ${problem}` : label}
      aria-busy={problem ? undefined : true}
      title={problem ?? undefined}
    >
      {problem ? <ImageOff className="size-3.5 shrink-0" aria-hidden /> : null}
      {label}
    </span>
  );
}

function DrawnImage({ url, src, alt }: ImageProps & { url: string }) {
  // Tied to the URL, so a reissued one gets another try.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url) return <ImageText src={src} alt={alt} problem={`Couldn't show ${src}.`} />;
  return (
    <img src={url} alt={alt} decoding="async" draggable={false} onError={() => setFailedUrl(url)} />
  );
}

function BlobImage({ assetUrl, src, alt }: ImageProps & { assetUrl: string }) {
  const blob = useAssetBlobUrl(assetUrl);
  if (blob.status === "loading") return <ImageText src={src} alt={alt} problem={null} />;
  if (blob.status === "failed") {
    return (
      <ImageText
        src={src}
        alt={alt}
        problem={blob.failure === "too-large" ? `${src} is larger than 10 MiB.` : unreadable(src)}
      />
    );
  }
  return <DrawnImage url={blob.objectUrl} src={src} alt={alt} />;
}

function WorkspaceImage({
  workspace,
  path,
  src,
  alt,
}: ImageProps & { workspace: RichMarkdownWorkspace; path: string }) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(workspace.environmentId);
  const asset = useAtomValue(
    assetEnvironment.createUrl({
      environmentId: workspace.environmentId,
      input: {
        resource: {
          _tag: "workspace-file",
          threadId: workspace.threadId,
          path: joinWorkspacePath(workspace.cwd, path),
        },
      },
    }),
  );
  if (asset._tag === "Failure") {
    return <ImageText src={src} alt={alt} problem={unreadable(src)} />;
  }
  const assetUrl =
    asset._tag === "Success" && httpBaseUrl !== null
      ? resolveAssetUrl(httpBaseUrl, asset.value.relativeUrl)
      : null;
  if (assetUrl === null) return <ImageText src={src} alt={alt} problem={null} />;
  // Not keyed by the URL: the signed URL is reissued over time, and the drawn image stays.
  return <BlobImage assetUrl={assetUrl} src={src} alt={alt} />;
}

/**
 * An image in the rendered view. A relative `src` is read from the workspace, relative to the
 * Markdown file, the way the Files preview reads media; other URLs load as they are.
 */
export function RichMarkdownImage({
  workspace,
  src,
  alt,
}: ImageProps & { workspace: RichMarkdownWorkspace }) {
  const source = resolveRichMarkdownImageSource(workspace.markdownPath, src);
  if (source.kind === "url") return <DrawnImage url={source.url} src={src} alt={alt} />;
  if (source.kind === "refused") {
    return <ImageText src={src} alt={alt} problem="Only images inside this project are shown." />;
  }
  return <WorkspaceImage workspace={workspace} path={source.path} src={src} alt={alt} />;
}
