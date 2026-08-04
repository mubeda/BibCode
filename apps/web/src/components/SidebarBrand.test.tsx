import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarBrandContent } from "./Sidebar";

describe("SidebarBrandContent", () => {
  it("renders the configured app base name and stage", () => {
    const markup = renderToStaticMarkup(
      <SidebarBrandContent appBaseName="BiBCode" stageLabel="Dev" />,
    );

    expect(markup).toContain(">BiBCode<");
    expect(markup).toContain(">Dev<");
  });

  it("omits the stable release stage", () => {
    const markup = renderToStaticMarkup(
      <SidebarBrandContent appBaseName="BiBCode" stageLabel={null} />,
    );

    expect(markup).toContain(">BiBCode<");
    expect(markup).not.toContain("sidebar-brand-stage");
  });
});
