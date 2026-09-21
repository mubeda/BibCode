import {
  createContext,
  memo,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { readLocalApi } from "../../../localApi";
import { CHAT_MARKDOWN_SANITIZE_SCHEMA } from "../../ChatMarkdown";
const MarkdownBaseUrl = createContext<string | undefined>(undefined);
const InsideMarkdownLink = createContext(false);

function externalHref(href: string | undefined, baseUrl: string | undefined) {
  if (!href || !defaultUrlTransform(href)) return undefined;
  try {
    const url = new URL(href, baseUrl);
    return /^(https?:|mailto:)$/.test(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function PullRequestsExternalLink({
  href,
  children,
}: {
  href?: string | undefined;
  children?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const baseUrl = useContext(MarkdownBaseUrl);
  const insideLink = useContext(InsideMarkdownLink);
  const safeHref = externalHref(href, baseUrl);
  if (!safeHref || insideLink) return <span>{children}</span>;
  return (
    <>
      <a
        href={safeHref}
        rel="noreferrer"
        target="_blank"
        className="break-words text-primary underline underline-offset-4"
        onClick={(event) => {
          event.preventDefault();
          const api = readLocalApi();
          if (!api) {
            setFailed(true);
            return;
          }
          void api.shell.openExternal(safeHref).then(
            () => setFailed(false),
            () => setFailed(true),
          );
        }}
      >
        <InsideMarkdownLink value>{children}</InsideMarkdownLink>
      </a>
      {failed ? (
        <span role="alert" className="ml-2 text-xs">
          Could not open the link. Copy the link and open it in your browser.
        </span>
      ) : null}
    </>
  );
}
function ImageAsLink({ src, alt }: ComponentProps<"img">) {
  const insideLink = useContext(InsideMarkdownLink);
  if (insideLink) return <span>image: {alt || "image"}</span>;
  return (
    <PullRequestsExternalLink href={typeof src === "string" ? src : undefined}>
      image: {alt || "image"} — open in browser
    </PullRequestsExternalLink>
  );
}
function TaskCheckbox({ checked }: ComponentProps<"input">) {
  const id = useId();
  return (
    <>
      <input
        type="checkbox"
        checked={checked ?? false}
        disabled
        title="Task lists are read-only"
        aria-describedby={id}
      />
      <span id={id} className="sr-only">
        Task lists are read-only
      </span>
    </>
  );
}
const components: Components = {
  img: ImageAsLink,
  a: PullRequestsExternalLink,
  input: TaskCheckbox,
};
const remarkPlugins = [remarkGfm];
const rehypePlugins: ComponentProps<typeof ReactMarkdown>["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
];

export const PullRequestsMarkdown = memo(function PullRequestsMarkdown({
  text,
  baseUrl,
}: {
  text: string;
  baseUrl?: string;
}) {
  return (
    <div className="chat-markdown min-w-0 break-words text-sm" data-text-surface>
      <MarkdownBaseUrl value={baseUrl}>
        <ReactMarkdown
          skipHtml
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </MarkdownBaseUrl>
    </div>
  );
});
