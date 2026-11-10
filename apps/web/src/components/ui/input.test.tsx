import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Input } from "./input";

describe("Input", () => {
  it("the input wrapper carries the focus ring owner marker", () => {
    const markup = renderToStaticMarkup(<Input placeholder="Search" />);
    expect(markup).toMatch(/<span[^>]*data-slot="input-control"[^>]*>/);
    expect(markup).toMatch(
      /<span[^>]*data-focus-ring-owner=""[^>]*data-slot="input-control"|<span[^>]*data-slot="input-control"[^>]*data-focus-ring-owner=""/,
    );
  });

  it("the input placeholder uses the placeholder token", () => {
    const markup = renderToStaticMarkup(<Input placeholder="Search" />);

    expect(markup).toContain("placeholder:text-placeholder");
    expect(markup).not.toContain("placeholder:text-muted-foreground/72");
  });
});
