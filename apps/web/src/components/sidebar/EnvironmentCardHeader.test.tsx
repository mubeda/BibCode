import { EnvironmentId } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentCardHeader } from "./EnvironmentCardHeader";

describe("EnvironmentCardHeader", () => {
  it("names the environment, its state and the checkout path", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentCardHeader
        identity={{
          environmentId: EnvironmentId.make("env-ai"),
          label: "ai-server",
          isLocal: false,
          avatar: "AS",
          status: "connected",
          statusLabel: "Connected",
          available: true,
        }}
        workspaceRoot="/work/tripunkt/pathfinder-application-server"
      />,
    );
    expect(markup).toContain('data-testid="environment-card-header-env-ai"');
    expect(markup).toContain("ai-server");
    expect(markup).toContain("Connected");
    expect(markup).toContain("AS");
    expect(markup).toContain("/work/tripunkt/pathfinder-application-server");
  });
});
