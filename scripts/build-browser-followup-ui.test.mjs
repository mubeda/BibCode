import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { loadRepoEnv } from "./lib/public-config.ts";
import { it, expect } from "@effect/vitest";
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
  expect(primary.VITE_DEV_SERVER_URL).toBe("http://127.0.0.1:4885");
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

import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import {
  prepareBrowserFollowupCaller,
  readBrowserFollowupBuildRecipe,
} from "../apps/desktop/e2e/support/release-visual-browser-followups-caller.ts";

import { afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PrimaryEnvironmentHttpClient,
  layer,
} from "../apps/web/src/environments/primary/httpClient.ts";
import { makePrimaryEnvironmentHttpLayer } from "../apps/web/src/environments/primary/httpLayer.ts";
import {
  resolvePrimaryEnvironmentHttpUrl,
  readPrimaryEnvironmentTarget,
} from "../apps/web/src/environments/primary/target.ts";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it.effect.each(["ordinary", "stale-ui-origin", "primary"])(
  "actual typed browser-session and reload flow: %s",
  (mode) =>
    Effect.gen(function* () {
      const env = browserFollowupBuildEnvironment("primary", {});
      if (mode === "ordinary") {
        env.VITE_HTTP_URL = "http://127.0.0.1:4885";
        env.VITE_WS_URL = "ws://127.0.0.1:4885";
        env.VITE_DEV_SERVER_URL = "http://127.0.0.1:4885";
      }
      if (mode === "stale-ui-origin") env.VITE_DEV_SERVER_URL = "http://127.0.0.1:4887";
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const ui = "http://127.0.0.1:4885";
      vi.stubGlobal("window", { location: { href: ui + "/pair", origin: ui } });
      let cookieStored = false;
      const requests = [];
      const auth = {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-access-token"],
        sessionCookieName: "inert-session",
      };
      vi.stubGlobal("fetch", async (input, init) => {
        const request = new Request(input, init),
          path = new URL(request.url).pathname;
        requests.push({
          path,
          credentials: request.credentials,
          authorization: request.headers.has("authorization"),
        });
        if (path === "/api/auth/browser-session") {
          // Standard browser Fetch cookie handling is modeled here; Node does not implement a browser cookie jar.
          cookieStored =
            request.credentials !== "omit" &&
            (request.credentials === "include" || new URL(request.url).origin === ui);
          return Response.json(
            {
              authenticated: true,
              scopes: ["orchestration:read"],
              sessionMethod: "browser-session-cookie",
              expiresAt: "2030-10-06T00:00:00.000Z",
            },
            {
              headers: {
                "set-cookie": "inert-session=owned-cookie; Path=/; HttpOnly; SameSite=Lax",
              },
            },
          );
        }
        if (path === "/api/auth/session")
          return Response.json({ authenticated: cookieStored, auth });
        if (path === "/api/auth/websocket-ticket") {
          if (!cookieStored)
            return Response.json(
              { _tag: "EnvironmentAuthInvalidError", reason: "missing_credential" },
              { status: 401 },
            );
          return Response.json({ ticket: "owned-ticket", expiresAt: "2030-10-06T00:00:00.000Z" });
        }
        throw new Error("Unexpected inert path");
      });
      const result = yield* Effect.gen(function* () {
        const client = yield* PrimaryEnvironmentHttpClient;
        const paired = yield* client.auth.browserSession({
          payload: { credential: "owned-pairing-credential" },
        });
        const session = yield* client.auth.session({ headers: {} });
        const ticket = yield* Effect.exit(client.auth.webSocketTicket({ headers: {} }));
        return { paired, session, ticket };
      }).pipe(Effect.provide(layer.pipe(Layer.provide(makePrimaryEnvironmentHttpLayer()))));
      const expected = mode !== "stale-ui-origin";
      expect(result.paired.authenticated).toBe(true);
      expect(result.session.authenticated).toBe(expected);
      expect(result.ticket._tag).toBe(expected ? "Success" : "Failure");
      expect(requests).toHaveLength(3);
      expect(requests.every((request) => !request.authorization)).toBe(true);
      expect(new URL(resolvePrimaryEnvironmentHttpUrl("/api/auth/session")).port).toBe(
        expected ? "4885" : "4887",
      );
      expect(new URL(readPrimaryEnvironmentTarget().target.wsBaseUrl).port).toBe(
        mode === "ordinary" ? "4885" : "4887",
      );
    }),
);

it.effect(
  "actual prepared asset/throttle chain preserves cookie-session, ticket and WebSocket authorization",
  () =>
    Effect.gen(function* () {
      const out = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-cookie-flow-")),
        ),
        repo = NodePath.resolve(import.meta.dirname, "..");
      NodeFS.chmodSync(out, 0o700);
      const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(out, "owned-proxy-")));
      NodeFS.chmodSync(root, 0o700);
      const sdkSourceSha256 = NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(repo + "/apps/web/src/hostedPairing.ts"))
          .digest("hex"),
        binary = NodePath.join(root, "binary");
      NodeFS.writeFileSync(binary, "inert executable", { mode: 0o500 });
      for (const [mode, name] of [
        ["primary", "web"],
        ["hosted", "hosted-web"],
      ]) {
        const dir = NodePath.join(root, name);
        NodeFS.mkdirSync(dir, { mode: 0o700 });
        NodeFS.writeFileSync(NodePath.join(dir, "index.html"), "inert original UI", {
          mode: 0o600,
        });
        NodeFS.writeFileSync(
          NodePath.join(dir, "qualified-browser-build.json"),
          JSON.stringify({
            schema: 1,
            mode,
            source: "a".repeat(40),
            sdkSourceSha256,
            backendHttp: mode === "primary" ? "http://127.0.0.1:4887" : "",
            backendWs: mode === "primary" ? "ws://127.0.0.1:4887" : "",
            devServerUrl: mode === "primary" ? "http://127.0.0.1:4885" : "",
            hostedOrigin: "http://127.0.0.1:4893",
            probeEntry: mode === "hosted" ? "qualified-hosted-mode.js" : null,
          }),
          { mode: 0o600 },
        );
        if (mode === "hosted")
          NodeFS.writeFileSync(
            NodePath.join(dir, "qualified-hosted-mode.js"),
            "export const inert=true",
            { mode: 0o600 },
          );
      }
      let cookieStored = false,
        upgradeObserved = false;
      const observed = [];
      const auth = {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-access-token"],
        sessionCookieName: "inert-session",
      };
      const backend = NodeHttp.createServer(async (request, response) => {
        for await (const _ of request) {
        }
        const path = new URL(request.url, "http://127.0.0.1:4897").pathname;
        const cookie = request.headers.cookie === "inert-session=owned-cookie";
        observed.push({ path, cookie, origin: request.headers.origin === "http://127.0.0.1:4885" });
        response.setHeader("content-type", "application/json");
        if (path === "/api/auth/browser-session") {
          response.setHeader(
            "set-cookie",
            "inert-session=owned-cookie; Path=/; HttpOnly; SameSite=Lax",
          );
          response.end(
            JSON.stringify({
              authenticated: true,
              scopes: ["orchestration:read"],
              sessionMethod: "browser-session-cookie",
              expiresAt: "2030-10-06T00:00:00.000Z",
            }),
          );
        } else if (path === "/api/auth/session")
          response.end(JSON.stringify({ authenticated: cookie, auth }));
        else if (path === "/api/auth/websocket-ticket") {
          response.statusCode = cookie ? 200 : 401;
          response.end(
            JSON.stringify(
              cookie
                ? { ticket: "owned-ticket", expiresAt: "2030-10-06T00:00:00.000Z" }
                : { _tag: "EnvironmentAuthInvalidError", reason: "missing_credential" },
            ),
          );
        } else response.end("{}");
      });
      backend.on("upgrade", (request, socket) => {
        if (
          new URL(request.url, "http://127.0.0.1:4897").searchParams.get("wsTicket") !==
            "owned-ticket" ||
          request.headers.origin !== "http://127.0.0.1:4885"
        ) {
          socket.destroy();
          return;
        }
        upgradeObserved = true;
        const accept = NodeCrypto.createHash("sha1")
          .update(
            String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
          )
          .digest("base64");
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
            accept +
            "\r\n\r\n",
        );
      });
      yield* Effect.promise(
        () => new Promise((resolve) => backend.listen(4897, "127.0.0.1", resolve)),
      );
      let prepared;
      const nativeFetch = globalThis.fetch;
      try {
        prepared = yield* Effect.promise(() =>
          prepareBrowserFollowupCaller({
            CI: "true",
            root,
            primaryAssets: NodePath.join(root, "web"),
            hostedAssets: NodePath.join(root, "hosted-web"),
            source: "a".repeat(40),
            repository: repo,
            binary,
            admitOwner: async () => {},
            verifyInputs: async () => {},
            observeUnsafeCleanup: () => {},
          }),
        );
        const env = browserFollowupBuildEnvironment("primary", {});
        for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
        vi.stubGlobal("window", {
          location: { href: "http://127.0.0.1:4885/pair", origin: "http://127.0.0.1:4885" },
        });
        vi.stubGlobal("fetch", async (input, init) => {
          const request = new Request(input, init);
          const permitted =
            request.credentials !== "omit" &&
            (request.credentials === "include" ||
              new URL(request.url).origin === "http://127.0.0.1:4885");
          const headers = new Headers(request.headers);
          headers.set("origin", "http://127.0.0.1:4885");
          if (permitted && cookieStored) headers.set("cookie", "inert-session=owned-cookie");
          const response = await nativeFetch(request.url, {
            method: request.method,
            headers,
            body: request.body ? await request.arrayBuffer() : undefined,
          });
          if (permitted && response.headers.has("set-cookie")) cookieStored = true;
          return response;
        });
        const result = yield* Effect.gen(function* () {
          const client = yield* PrimaryEnvironmentHttpClient;
          yield* client.auth.browserSession({
            payload: { credential: "owned-pairing-credential" },
          });
          const session = yield* client.auth.session({ headers: {} });
          const ticket = yield* client.auth.webSocketTicket({ headers: {} });
          return { session, ticket };
        }).pipe(Effect.provide(layer.pipe(Layer.provide(makePrimaryEnvironmentHttpLayer()))));
        expect(result.session.authenticated).toBe(true);
        expect(result.ticket.ticket).toBe("owned-ticket");
        yield* Effect.promise(
          () =>
            new Promise((resolve, reject) => {
              let response = "";
              const socket = NodeNet.connect(4887, "127.0.0.1", () =>
                socket.write(
                  "GET /ws?wsTicket=owned-ticket HTTP/1.1\r\nHost: 127.0.0.1:4887\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: b3duZWQtbG9vcGJhY2stMQ==\r\nOrigin: http://127.0.0.1:4885\r\n\r\n",
                ),
              );
              socket.once("error", reject);
              socket.on("data", (bytes) => (response += bytes.toString()));
              socket.once("end", () => {
                try {
                  expect(response.startsWith("HTTP/1.1 101")).toBe(true);
                  resolve();
                } catch (error) {
                  reject(error);
                } finally {
                  socket.destroy();
                }
              });
            }),
        );
        expect(upgradeObserved).toBe(true);
        expect(observed.map((value) => value.cookie)).toEqual([false, true, true]);
        expect(observed.every((value) => value.origin)).toBe(true);
      } finally {
        vi.unstubAllGlobals();
        if (prepared) yield* Effect.promise(() => prepared.close());
        yield* Effect.promise(() => new Promise((resolve) => backend.close(() => resolve())));
        NodeFS.rmSync(root, { recursive: true, force: true });
        NodeFS.rmSync(out, { recursive: true, force: true });
      }
    }),
);

it.each(["owned", "missing-hint", "primary-backend-hint", "hosted-backend-hint"])(
  "exact build recipe refuses stale cookie proxy metadata before resources: %s",
  (mode) => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-recipe-inert-")),
    );
    NodeFS.chmodSync(root, 0o700);
    const repository = NodePath.resolve(import.meta.dirname, "..");
    const sdkSourceSha256 = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(NodePath.join(repository, "apps/web/src/hostedPairing.ts")))
      .digest("hex");
    try {
      for (const kind of ["primary", "hosted"]) {
        const directory = NodePath.join(root, kind);
        NodeFS.mkdirSync(directory, { mode: 0o700 });
        const recipe = {
          schema: 1,
          mode: kind,
          source: "a".repeat(40),
          sdkSourceSha256,
          backendHttp: kind === "primary" ? "http://127.0.0.1:4887" : "",
          backendWs: kind === "primary" ? "ws://127.0.0.1:4887" : "",
          devServerUrl: kind === "primary" ? "http://127.0.0.1:4885" : "",
          hostedOrigin: "http://127.0.0.1:4893",
          probeEntry: kind === "hosted" ? "qualified-hosted-mode.js" : null,
        };
        if (mode === "missing-hint" && kind === "primary") delete recipe.devServerUrl;
        if (
          (mode === "primary-backend-hint" && kind === "primary") ||
          (mode === "hosted-backend-hint" && kind === "hosted")
        )
          recipe.devServerUrl = "http://127.0.0.1:4887";
        NodeFS.writeFileSync(
          NodePath.join(directory, "qualified-browser-build.json"),
          JSON.stringify(recipe),
          { mode: 0o600 },
        );
        if (kind === "hosted")
          NodeFS.writeFileSync(
            NodePath.join(directory, "qualified-hosted-mode.js"),
            "inert current-source probe",
            { mode: 0o600 },
          );
      }
      const read = () =>
        readBrowserFollowupBuildRecipe({
          primaryAssets: NodePath.join(root, "primary"),
          hostedAssets: NodePath.join(root, "hosted"),
          source: "a".repeat(40),
          repository,
        });
      if (mode === "owned") expect(read).not.toThrow();
      else expect(read).toThrow();
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
