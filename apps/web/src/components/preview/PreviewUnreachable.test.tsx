import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PreviewUnreachable } from "./PreviewUnreachable";

const render = (code: number, description: string) =>
  renderToStaticMarkup(
    <PreviewUnreachable
      url="http://localhost:5173/"
      code={code}
      description={description}
      onReload={() => undefined}
    />,
  );

const occurrences = (markup: string, text: string) => markup.split(text).length - 1;

describe("PreviewUnreachable", () => {
  it("states BiBCode's own reason once, without network tips", () => {
    const reason = "Nothing is listening on port 5173 on Build box.";
    const markup = render(0, reason);

    expect(occurrences(markup, reason)).toBe(1);
    expect(markup).not.toContain("Details");
    expect(markup).not.toContain("ERR_");
    expect(markup).toContain("Reload");
  });

  it("explains a network error and keeps its code and tips", () => {
    const markup = render(-105, "ERR_NAME_NOT_RESOLVED");

    expect(markup).toContain("DNS address could not be found");
    expect(markup).toContain("ERR_NAME_NOT_RESOLVED");
    expect(markup).toContain("Details");
  });
});
