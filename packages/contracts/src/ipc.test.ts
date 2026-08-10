import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ContextMenuItemSchema,
  type DesktopBridge,
  DesktopEnvironmentBootstrapSchema,
} from "./ipc.ts";
import { expectDecodeFailure, expectEncodeFailure } from "./test/schemaAssertions.ts";

const decodeContextMenuItem = Schema.decodeUnknownSync(ContextMenuItemSchema);
const encodeContextMenuItem = Schema.encodeSync(ContextMenuItemSchema);
const decodeDesktopEnvironmentBootstrap = Schema.decodeUnknownSync(
  DesktopEnvironmentBootstrapSchema,
);

describe("DesktopBridge connection catalog", () => {
  it("exposes an exact-raw compare-and-set operation", async () => {
    let catalog: string | null = "before";
    const bridge: Pick<DesktopBridge, "compareAndSetConnectionCatalog"> = {
      compareAndSetConnectionCatalog: async (expected, next) => {
        if (catalog !== expected) return false;
        catalog = next;
        return true;
      },
    };

    await expect(bridge.compareAndSetConnectionCatalog!("stale", "ignored")).resolves.toBe(false);
    await expect(bridge.compareAndSetConnectionCatalog!("before", "after")).resolves.toBe(true);
    expect(catalog).toBe("after");
  });

  it("exposes an exact-raw comparison without mutation", async () => {
    const catalog: string | null = "current";
    const bridge: Pick<DesktopBridge, "compareConnectionCatalog"> = {
      compareConnectionCatalog: async (expected) => catalog === expected,
    };

    await expect(bridge.compareConnectionCatalog!("current")).resolves.toBe(true);
    await expect(bridge.compareConnectionCatalog!("stale")).resolves.toBe(false);
    expect(catalog).toBe("current");
  });
});

describe("DesktopEnvironmentBootstrapSchema", () => {
  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decodeDesktopEnvironmentBootstrap({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decodeDesktopEnvironmentBootstrap({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("ContextMenuItemSchema", () => {
  it("round-trips nested menu items and optional presentation fields", () => {
    const input = {
      id: "git",
      label: "Git",
      header: true,
      children: [
        {
          id: "push",
          label: "Push",
          destructive: false,
          disabled: true,
          icon: "upload",
        },
      ],
    };
    const decoded = decodeContextMenuItem(input);

    expect(decoded.children?.[0]?.id).toBe("push");
    expect(encodeContextMenuItem(decoded)).toEqual(input);
  });

  it("reports invalid recursive children on decode and encode", () => {
    const invalid = { id: "git", label: "Git", children: [{ id: 1, label: "Push" }] };
    const expected = {
      rootTag: "Composite" as const,
      paths: [["children", 0, "id"]],
      containsTag: "InvalidType" as const,
    };
    expectDecodeFailure(ContextMenuItemSchema, invalid, expected);
    expectEncodeFailure(ContextMenuItemSchema, invalid, expected);
  });
});
