import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { loadRepoEnv } from "./lib/public-config.ts";
import { it, expect } from "vite-plus/test";
import {
  browserFollowupBuildEnvironment,
  admitBrowserFollowupBuild,
} from "./build-browser-followup-ui.mjs";
it("keeps immutable primary API4887 and removes every backend/desktop override for a separate hosted build", () => {
  const inherited = {
    CI: "true",
    VITE_HTTP_URL: "foreign",
    vite_ws_url: "foreign",
    VITE_DESKTOP_BUILD: "1",
    VITE_DEV_SERVER_URL: "foreign",
    VITE_HOSTED_APP_CHANNEL: "foreign",
  };
  const primary = browserFollowupBuildEnvironment("primary", inherited),
    hosted = browserFollowupBuildEnvironment("hosted", inherited);
  expect(primary.VITE_HTTP_URL).toBe("http://127.0.0.1:4887");
  expect(primary.VITE_WS_URL).toBe("ws://127.0.0.1:4887");
  expect(hosted.VITE_HTTP_URL).toBe("");
  expect(hosted.vite_ws_url).toBeUndefined();
  expect(hosted.VITE_DESKTOP_BUILD).toBe("");
  expect(hosted.VITE_DEV_SERVER_URL).toBe("");
  expect(hosted.VITE_HOSTED_APP_URL).toBe("http://127.0.0.1:4893");
  expect(inherited.VITE_HTTP_URL).toBe("foreign");
});

it.each(["owned", "source", "mode", "alias", "public"])(
  "admits a private source-bound build recipe before build actions: %s",
  (mode) => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-build-inert-")),
    );
    NodeFS.chmodSync(root, 0o700);
    const alias = root + "-alias";
    try {
      NodeFS.symlinkSync(root, alias);
      if (mode === "public") NodeFS.chmodSync(root, 0o755);
      const input = {
        mode: "hosted",
        root: mode === "alias" ? alias : root,
        source: mode === "source" ? "b".repeat(40) : "a".repeat(40),
        environment: { CI: "true", GITHUB_ACTIONS: "true", GITHUB_SHA: "a".repeat(40) },
      };
      if (mode === "mode") input.mode = "desktop";
      if (mode === "owned")
        expect(admitBrowserFollowupBuild(input)).toEqual(NodePath.join(root, "hosted-assets"));
      else expect(() => admitBrowserFollowupBuild(input)).toThrow();
    } finally {
      NodeFS.unlinkSync(alias);
      NodeFS.rmSync(root, { recursive: true });
    }
  },
);

it("blank hosted overrides prevent the actual config loader from reviving root dotenv backend or desktop values", () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hosted-env-inert-")),
  );
  try {
    NodeFS.writeFileSync(
      NodePath.join(root, ".env"),
      "VITE_WS_URL=ws://foreign\nVITE_HTTP_URL=http://foreign\nVITE_DESKTOP_BUILD=1\n",
    );
    const value = loadRepoEnv({
      baseEnv: browserFollowupBuildEnvironment("hosted", {}),
      repoRoot: root,
    });
    expect(value.VITE_WS_URL).toBe("");
    expect(value.VITE_HTTP_URL).toBe("");
    expect(value.VITE_DESKTOP_BUILD).toBe("");
  } finally {
    NodeFS.rmSync(root, { recursive: true });
  }
});
