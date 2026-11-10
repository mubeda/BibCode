import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Input } from "./input";

describe("Input", () => {
  it("the input placeholder uses the placeholder token", () => {
    const markup = renderToStaticMarkup(<Input placeholder="Search" />);

    expect(markup).toContain("placeholder:text-placeholder");
    expect(markup).not.toContain("placeholder:text-muted-foreground/72");
  });
});
