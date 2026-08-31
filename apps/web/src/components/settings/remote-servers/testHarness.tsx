import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** Shared zero-DOM smoke renderer for focused Remote Servers component tests. */
export function renderRemoteServersElement(element: ReactElement): string {
  return renderToStaticMarkup(element);
}
