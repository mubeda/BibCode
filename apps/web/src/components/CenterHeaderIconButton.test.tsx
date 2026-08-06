import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CenterHeaderIconButton } from "./CenterHeaderIconButton";

describe("CenterHeaderIconButton", () => {
  it("owns the uniform outlined center-header geometry", () => {
    const markup = renderToStaticMarkup(
      <CenterHeaderIconButton aria-label="New panel">
        <svg aria-hidden="true" />
      </CenterHeaderIconButton>,
    );

    expect(markup).toContain('data-center-header-icon-control="true"');
    expect(markup).toContain("size-8 sm:size-7");
    expect(markup).toContain("border-input");
    expect(markup).toContain("bg-popover");
    expect(markup).toContain("focus-visible:ring-ring");
  });
});
