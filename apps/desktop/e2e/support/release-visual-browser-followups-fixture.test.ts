// @effect-diagnostics nodeBuiltinImport:off - Disposable files and inert hosted build inputs only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  prepareBrowserFollowupPng,
  browserFollowupHostedEnvironment,
  buildBrowserFollowupHostedEntry,
  prepareBrowserFollowupHostedProbe,
} from "./release-visual-browser-followups-fixture.ts";
it("reuses the actual 512 KiB staged PNG fixture with immutable source identity", () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-followups-")),
  );
  try {
    const png = prepareBrowserFollowupPng(root);
    expect(png.bytes).toBe(512 * 1024);
    expect(png.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => png.verify()).not.toThrow();
    NodeFS.appendFileSync(png.path, "changed");
    expect(() => png.verify()).toThrow();
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
it("builds the read-only hosted SDK probe from the current real source without duplicating its mode logic", () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-followups-probe-")),
  );
  const repository = NodeFS.realpathSync(NodePath.resolve(import.meta.dirname, "../../../.."));
  try {
    const probe = prepareBrowserFollowupHostedProbe({
      root,
      repository,
      outDir: NodePath.join(root, "hosted-assets"),
    });
    const source = NodeFS.readFileSync(probe.path, "utf8");
    expect(source).toContain("export { isHostedStaticApp } from");
    expect(source).not.toContain("return true");
    expect(probe.build.rolldownOptions.output.entryFileNames({ name: "qualifiedHostedMode" })).toBe(
      "qualified-hosted-mode.js",
    );
    expect(() => probe.verify()).not.toThrow();
    NodeFS.appendFileSync(probe.path, "changed");
    expect(() => probe.verify()).toThrow();
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
it("boots a separate hosted build without inheriting backend or desktop settings", () => {
  const env = browserFollowupHostedEnvironment({
    VITE_HTTP_URL: "http://backend.invalid",
    VITE_WS_URL: "ws://backend.invalid",
    VITE_DESKTOP_BUILD: "1",
    VITE_HOSTED_APP_CHANNEL: "nightly",
    PATH: "inert",
  });
  expect(env.VITE_HTTP_URL).toBeUndefined();
  expect(env.VITE_WS_URL).toBeUndefined();
  expect(env.VITE_DESKTOP_BUILD).toBeUndefined();
  expect(env.VITE_HOSTED_APP_CHANNEL).toBe("latest");
  expect(env.VITE_HOSTED_APP_URL).toBe("http://127.0.0.1:4893");
  const complete = new URL(buildBrowserFollowupHostedEntry("confirm", "owned-unused-token"));
  expect(complete.pathname).toBe("/pair");
  expect(complete.hash).toBe("#token=owned-unused-token");
  const incomplete = new URL(buildBrowserFollowupHostedEntry("incomplete", "owned-unused-token"));
  expect(incomplete.searchParams.get("host")).toBe("http://127.0.0.1:4887");
  expect(incomplete.hash).toBe("");
  expect(incomplete.searchParams.has("token")).toBe(false);
});
it("refuses arbitrary hosted modes and caller-owned existing source PNGs", () => {
  expect(() => buildBrowserFollowupHostedEntry("other" as never, "owned-unused-token")).toThrow();
  expect(() => buildBrowserFollowupHostedEntry("confirm", "")).toThrow();
});
