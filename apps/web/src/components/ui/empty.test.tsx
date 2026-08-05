import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EmptyDescription } from "./empty";

describe("EmptyDescription", () => {
  it("uses the semantic link color instead of the interaction accent", () => {
    const markup = renderToStaticMarkup(
      <EmptyDescription>
        <a href="https://example.com/docs">Read the docs</a>
      </EmptyDescription>,
    );

    expect(markup).toContain("[&amp;&gt;a:hover]:text-link");
    expect(markup).not.toContain("[&amp;&gt;a:hover]:text-primary");
  });
});
