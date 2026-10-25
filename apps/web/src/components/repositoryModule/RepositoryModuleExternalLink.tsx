import type { ReactNode } from "react";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { cn } from "../../lib/utils";

/**
 * A link to the host's own page, opened in the system browser. The URL comes from the
 * server, built from the repository's web origin; the browser never follows it in place.
 */
export function RepositoryModuleExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const openLink = useOpenPrLink();
  return (
    <a
      href={href}
      rel="noreferrer"
      target="_blank"
      className={cn("underline underline-offset-4", className)}
      onClick={(event) => openLink(event, href)}
    >
      {children}
    </a>
  );
}
