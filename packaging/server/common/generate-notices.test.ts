// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";

import {
  generateThirdPartyNoticesMarkdown,
  parseCargoNoticePackages,
  parsePnpmNoticePackages,
} from "./generate-notices.ts";

describe("third-party notice generation", () => {
  it("walks only the locked server runtime Cargo dependency closure", () => {
    const packages = parseCargoNoticePackages(
      JSON.stringify({
        packages: [
          { id: "server", name: "bibcode-server", version: "0.4.1", source: null },
          {
            id: "serde",
            name: "serde",
            version: "1.0.0",
            license: "MIT OR Apache-2.0",
            source: "registry+https://github.com/rust-lang/crates.io-index",
            repository: "https://github.com/serde-rs/serde",
          },
          {
            id: "desktop-only",
            name: "desktop-only",
            version: "9.0.0",
            license: "MIT",
            source: "registry+https://github.com/rust-lang/crates.io-index",
          },
        ],
        resolve: {
          nodes: [
            {
              id: "server",
              deps: [{ pkg: "serde", dep_kinds: [{ kind: null, target: null }] }],
            },
            { id: "serde", deps: [] },
            { id: "desktop-only", deps: [] },
          ],
        },
      }),
    );

    expect(packages).toEqual([
      {
        ecosystem: "Cargo",
        name: "serde",
        version: "1.0.0",
        license: "MIT OR Apache-2.0",
        source: "https://github.com/serde-rs/serde",
      },
    ]);
  });

  it("walks nested production npm dependencies, reads licenses, and deduplicates", () => {
    const packages = parsePnpmNoticePackages(
      JSON.stringify([
        {
          name: "@bibcode/web",
          version: "0.4.1",
          dependencies: {
            react: {
              name: "react",
              version: "19.2.7",
              path: "/repo/node_modules/react",
              dependencies: {
                scheduler: {
                  name: "scheduler",
                  version: "0.27.0",
                  path: "/repo/node_modules/scheduler",
                },
              },
            },
            duplicate: {
              name: "scheduler",
              version: "0.27.0",
              path: "/repo/node_modules/scheduler",
            },
          },
        },
      ]),
      (path) =>
        path.endsWith("/react/package.json")
          ? {
              license: "MIT",
              repository: { url: "https://github.com/facebook/react.git" },
            }
          : { license: "MIT", homepage: "https://github.com/facebook/react" },
    );

    expect(packages.map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      "react@19.2.7",
      "scheduler@0.27.0",
    ]);
    expect(packages[0]?.source).toBe("https://github.com/facebook/react.git");
  });

  it("emits deterministic, path-free Markdown and rejects missing license metadata", () => {
    const packages = [
      {
        ecosystem: "npm" as const,
        name: "zeta",
        version: "2.0.0",
        license: "MIT",
        source: "https://example.test/zeta",
      },
      {
        ecosystem: "Cargo" as const,
        name: "alpha",
        version: "1.0.0",
        license: "Apache-2.0",
        source: "https://example.test/alpha",
      },
    ];
    const first = generateThirdPartyNoticesMarkdown(packages);
    const second = generateThirdPartyNoticesMarkdown(packages.toReversed());

    expect(first).toBe(second);
    expect(first.indexOf("alpha")).toBeLessThan(first.indexOf("zeta"));
    expect(first).not.toContain("/repo/");
    expect(() => generateThirdPartyNoticesMarkdown([{ ...packages[0], license: "" }])).toThrow(
      /license/iu,
    );
  });
});
