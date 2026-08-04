import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const TauriConfiguration = Schema.fromJsonString(
  Schema.Struct({
    identifier: Schema.String,
    build: Schema.Struct({ beforeBuildCommand: Schema.String }),
    app: Schema.Struct({
      withGlobalTauri: Schema.Boolean,
      security: Schema.Struct({
        csp: Schema.NullOr(Schema.String),
        devCsp: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    }),
    bundle: Schema.Struct({
      useLocalToolsDir: Schema.optionalKey(Schema.Boolean),
      icon: Schema.Array(Schema.String),
      macOS: Schema.Struct({
        minimumSystemVersion: Schema.String,
        signingIdentity: Schema.optionalKey(Schema.String),
      }),
      resources: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  }),
);
const CapabilityConfiguration = Schema.fromJsonString(
  Schema.Struct({ permissions: Schema.Array(Schema.String) }),
);
const LinuxTauriConfiguration = Schema.fromJsonString(
  Schema.Struct({ bundle: Schema.Struct({ useLocalToolsDir: Schema.Boolean }) }),
);
const DesktopPackageConfiguration = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.Struct({ build: Schema.String }) }),
);
const UpdaterConfiguration = Schema.Struct({
  pubkey: Schema.String,
  endpoints: Schema.Array(Schema.String),
  windows: Schema.optionalKey(Schema.Struct({ installMode: Schema.String })),
});
const BaseUpdaterConfiguration = Schema.fromJsonString(
  Schema.Struct({
    bundle: Schema.Struct({
      createUpdaterArtifacts: Schema.optionalKey(Schema.Boolean),
    }),
    plugins: Schema.Struct({ updater: UpdaterConfiguration }),
  }),
);
const ReleaseUpdaterConfiguration = Schema.fromJsonString(
  Schema.Struct({
    bundle: Schema.Struct({ createUpdaterArtifacts: Schema.Boolean }),
    plugins: Schema.Struct({ updater: UpdaterConfiguration }),
  }),
);
const decodeTauriConfiguration = Schema.decodeUnknownEffect(TauriConfiguration);
const decodeLinuxTauriConfiguration = Schema.decodeUnknownEffect(LinuxTauriConfiguration);
const decodeCapabilityConfiguration = Schema.decodeUnknownEffect(CapabilityConfiguration);
const decodeDesktopPackageConfiguration = Schema.decodeUnknownEffect(DesktopPackageConfiguration);
const decodeBaseUpdaterConfiguration = Schema.decodeUnknownEffect(BaseUpdaterConfiguration);
const decodeReleaseUpdaterConfiguration = Schema.decodeUnknownEffect(ReleaseUpdaterConfiguration);

it.layer(NodeServices.layer)("Tauri production hardening", (it) => {
  it.effect("prepares repository-local AppImage tools only for Linux bundle builds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const tauri = yield* decodeTauriConfiguration(
        yield* fs.readFileString(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json")),
      );
      const linux = yield* decodeLinuxTauriConfiguration(
        yield* fs.readFileString(
          path.join(repoRoot, "apps/desktop/src-tauri/tauri.linux.conf.json"),
        ),
      );

      assert.equal(tauri.bundle.useLocalToolsDir, undefined);
      assert.equal(linux.bundle.useLocalToolsDir, true);
      assert.equal(
        tauri.build.beforeBuildCommand,
        "node ../../scripts/prepare-tauri-appimage-tools.ts && vp run --filter @bibcode/web build && node ../../scripts/apply-web-brand-assets.ts production apps/web/dist",
      );
      assert.equal(
        yield* fs.exists(path.join(repoRoot, "scripts/prepare-tauri-appimage-tools.ts")),
        true,
      );
    }),
  );

  it.effect("keeps updater I/O release-only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const base = yield* decodeBaseUpdaterConfiguration(
        yield* fs.readFileString(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json")),
      );
      const release = yield* decodeReleaseUpdaterConfiguration(
        yield* fs.readFileString(
          path.join(repoRoot, "apps/desktop/src-tauri/tauri.release.conf.json"),
        ),
      );

      assert.equal(base.bundle.createUpdaterArtifacts, undefined);
      assert.equal(base.plugins.updater.pubkey, "");
      assert.deepEqual(base.plugins.updater.endpoints, []);
      assert.equal(release.bundle.createUpdaterArtifacts, true);
      assert.match(
        Buffer.from(release.plugins.updater.pubkey, "base64").toString("utf8"),
        /minisign public key/,
      );
      assert.deepEqual(release.plugins.updater.endpoints, [
        "https://github.com/mubeda/BibCode/releases/latest/download/latest.json",
      ]);
      assert.equal(release.plugins.updater.windows?.installMode, "passive");
    }),
  );

  it.effect("bundles only canonical black desktop icons", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const tauri = yield* decodeTauriConfiguration(
        yield* fs.readFileString(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json")),
      );
      const expectedIcons = [
        "../../../assets/prod/black-universal-1024.png",
        "../../../assets/prod/bibcode-black-windows.ico",
        "../../../assets/prod/bibcode-black-macos.icns",
      ];

      assert.deepEqual(tauri.bundle.icon, expectedIcons);
      assert.equal(tauri.bundle.macOS.minimumSystemVersion, "11.0");
      for (const iconPath of [
        "assets/prod/black-universal-1024.png",
        "assets/prod/bibcode-black-windows.ico",
        "assets/prod/bibcode-black-macos.icns",
      ]) {
        assert.equal(yield* fs.exists(path.join(repoRoot, iconPath)), true, iconPath);
      }
      assert.equal(yield* fs.exists(path.join(repoRoot, "apps/desktop/resources")), false);
    }),
  );

  it.effect("ad-hoc signs macOS application bundles without an Apple identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const tauri = yield* decodeTauriConfiguration(
        yield* fs.readFileString(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json")),
      );

      assert.equal(tauri.bundle.macOS.signingIdentity, "-");
    }),
  );

  it.effect("applies the production black web icons before bundling the desktop app", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const tauri = yield* decodeTauriConfiguration(
        yield* fs.readFileString(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json")),
      );

      assert.match(
        tauri.build.beforeBuildCommand,
        /apply-web-brand-assets\.ts production apps\/web\/dist/,
      );
      assert.equal(
        yield* fs.exists(path.join(repoRoot, "assets/prod/bibcode-black-web-apple-touch-180.png")),
        true,
      );
    }),
  );

  it.effect("keeps only canonical black product-icon assets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

      for (const legacyPath of ["assets/dev", "assets/nightly"]) {
        assert.equal(
          yield* fs.exists(path.join(repoRoot, legacyPath)),
          false,
          `${legacyPath} must be absent`,
        );
      }

      const publicCopies = [
        [
          "assets/prod/bibcode-black-web-favicon.ico",
          "apps/web/public/favicon.ico",
          "apps/marketing/public/favicon.ico",
        ],
        [
          "assets/prod/bibcode-black-web-favicon-16x16.png",
          "apps/web/public/favicon-16x16.png",
          "apps/marketing/public/favicon-16x16.png",
        ],
        [
          "assets/prod/bibcode-black-web-favicon-32x32.png",
          "apps/web/public/favicon-32x32.png",
          "apps/marketing/public/favicon-32x32.png",
        ],
        [
          "assets/prod/bibcode-black-web-apple-touch-180.png",
          "apps/web/public/apple-touch-icon.png",
          "apps/marketing/public/apple-touch-icon.png",
        ],
      ] as const;

      for (const [sourcePath, ...copyPaths] of publicCopies) {
        const source = yield* fs.readFile(path.join(repoRoot, sourcePath));
        for (const copyPath of copyPaths) {
          assert.deepEqual(
            yield* fs.readFile(path.join(repoRoot, copyPath)),
            source,
            `${copyPath} must match ${sourcePath}`,
          );
        }
      }
    }),
  );

  it.effect("restricts the main WebView and disables production source maps by default", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const tauri = yield* decodeTauriConfiguration(
        yield* fs.readFileString(path.join(repoRoot, "apps/desktop/src-tauri/tauri.conf.json")),
      );
      const capability = yield* decodeCapabilityConfiguration(
        yield* fs.readFileString(
          path.join(repoRoot, "apps/desktop/src-tauri/capabilities/default.json"),
        ),
      );
      const viteConfig = yield* fs.readFileString(path.join(repoRoot, "apps/web/vite.config.ts"));
      const rootPackage = yield* fs.readFileString(path.join(repoRoot, "package.json"));
      const workspace = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
      const desktopPackage = yield* fs.readFileString(
        path.join(repoRoot, "apps/desktop/package.json"),
      );
      const desktopLib = yield* fs.readFileString(
        path.join(repoRoot, "apps/desktop/src-tauri/src/lib.rs"),
      );

      for (const obsoletePath of [
        "apps/server-rust",
        "apps/desktop-tauri",
        "packages/effect-acp",
        "packages/effect-codex-app-server",
        "packages/native-command-runner",
        "packages/native-process-diagnostics",
        "packages/ssh",
        "packages/tailscale",
        "scripts/prepare-tauri-node-runtime.ts",
      ]) {
        assert.equal(
          yield* fs.exists(path.join(repoRoot, obsoletePath)),
          false,
          `${obsoletePath} must be absent`,
        );
      }

      assert.equal(tauri.app.withGlobalTauri, false);
      assert.notMatch(tauri.identifier, /\.app$/i);
      assert.equal(
        /prepare-tauri-node-runtime|server\//.test(tauri.build.beforeBuildCommand),
        false,
      );
      assert.equal(tauri.bundle.resources, undefined);
      assert.notEqual(tauri.app.security.csp, null);
      assert.match(tauri.app.security.csp ?? "", /default-src 'self'/);
      assert.match(tauri.app.security.csp ?? "", /object-src 'none'/);
      assert.match(tauri.app.security.csp ?? "", /frame-ancestors 'none'/);
      assert.notEqual(tauri.app.security.devCsp, null);
      assert.deepEqual(capability.permissions, [
        "allow-desktop-bridge",
        "allow-desktop-preview",
        "core:default",
      ]);
      assert.match(viteConfig, /tanstackRouter\(\{[\s\S]*?autoCodeSplitting: true,/);
      assert.match(viteConfig, /chunkSizeWarningLimit: 1536,/);
      assert.match(
        viteConfig,
        /const buildSourcemap:[\s\S]*?sourcemapEnv === "hidden"[\s\S]*?sourcemapEnv === "true";/,
      );
      assert.equal(/electron|electron-builder|@clerk\/electron/i.test(rootPackage), false);
      assert.equal(
        /effect-acp|effect-codex-app-server|node-pty|ffi-rs|fff-node/i.test(workspace),
        false,
      );
      assert.equal(
        /resources\/node|server-node_modules|dist\/bin\.mjs/i.test(desktopPackage),
        false,
      );
      const desktopPackageJson = yield* decodeDesktopPackageConfiguration(desktopPackage);
      assert.match(desktopPackageJson.scripts.build, /pnpm exec tauri build$/);
      assert.notMatch(desktopPackage, /pnpm dlx/);
      assert.notMatch(desktopLib, /if\s*!cfg!\(debug_assertions\)[\s\S]*?backend\.start_default/);
      assert.match(desktopLib, /backend\.start_default\(app_handle\)\.await/);
    }),
  );
});
