// Inert loopback/TempFS only. No product process or browser is started.
// @effect-diagnostics nodeBuiltinImport:off - Disposable fixed-input files are owned by these inert tests.
// @effect-diagnostics globalFetch:off - Only the inert loopback asset owner is queried.
import { it as test } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import {
  pinBrowserFollowupAssets,
  pinBrowserFollowupExecutable,
  startBrowserFollowupAssets,
  ownBrowserFollowupLink,
  joinBrowserFollowupCleanup,
} from "./release-visual-browser-followups-caller-resources.ts";
const temporary = () =>
  NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-integration-inert-")),
  );
test("original immutable SPA assets are returned without transformation", async () => {
  const root = temporary();
  NodeFS.writeFileSync(NodePath.join(root, "index.html"), "<html>inert original</html>", {
    mode: 0o600,
  });
  NodeFS.writeFileSync(
    NodePath.join(root, "qualified-hosted-mode.js"),
    "export const inert = true;",
    {
      mode: 0o600,
    },
  );
  const pin = pinBrowserFollowupAssets(root);
  const server = await startBrowserFollowupAssets({ CI: "true", port: 4893, pin });
  try {
    NodeAssert.equal(
      await (await fetch("http://127.0.0.1:4893/pair?host=inert")).text(),
      "<html>inert original</html>",
    );
    NodeAssert.equal(
      await (await fetch("http://127.0.0.1:4893/qualified-hosted-mode.js")).text(),
      "export const inert = true;",
    );
    NodeAssert.equal((await fetch("http://127.0.0.1:4893/missing.js")).status, 404);
    NodeFS.writeFileSync(NodePath.join(root, "index.html"), "drift");
    NodeAssert.throws(pin.verify);
    NodeAssert.equal((await fetch("http://127.0.0.1:4893/pair")).status, 503);
  } finally {
    await server.close();
    NodeFS.rmSync(root, { recursive: true });
  }
});
test("asset admission rejects aliases and new inventory", () => {
  const root = temporary();
  NodeFS.writeFileSync(NodePath.join(root, "index.html"), "inert");
  const pin = pinBrowserFollowupAssets(root);
  try {
    NodeFS.writeFileSync(NodePath.join(root, "extra.js"), "inert");
    NodeAssert.throws(pin.verify);
    NodeFS.unlinkSync(NodePath.join(root, "extra.js"));
    NodeFS.symlinkSync("index.html", NodePath.join(root, "alias"));
    NodeAssert.throws(() => pinBrowserFollowupAssets(root));
  } finally {
    NodeFS.rmSync(root, { recursive: true });
  }
});
const timestamp = "2030-10-06T00:00:00.000Z";
const credential = "inert-secret-credential";
function linkPort(mode = "valid") {
  let links: object[] = [],
    calls: string[] = [],
    cancelled = false;
  const original = new Error("inert issuance fault");
  const fetcher = (async (_url: unknown, options: RequestInit = {}) => {
    const path = new URL(String(_url)).pathname;
    calls.push(path);
    const result = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/auth/clients") return result([]);
    if (path === "/api/auth/pairing-links") return result(links);
    if (path === "/api/auth/pairing-offer") {
      if (mode === "issuance-fault") throw original;
      const payload = JSON.parse(String(options.body));
      NodeAssert.equal(payload.endpoint, "http://127.0.0.1:4887");
      NodeAssert.equal(payload.reach, "this-computer");
      links = [
        {
          id: "inert-link",
          credential,
          scopes: ["orchestration:read"],
          subject: "inert-subject",
          createdAt: timestamp,
          expiresAt: timestamp,
          reach: "this-computer",
          label: "Owned hosted backend",
        },
      ];
      return result({
        id: "inert-link",
        code: "inert-code",
        reach: "this-computer",
        endpoint: payload.endpoint,
        name: payload.name,
        expiresAt: timestamp,
      });
    }
    if (path === "/api/auth/pairing-links/revoke") {
      if (mode === "revoke-fault") throw new Error("inert revoke fault");
      links = [];
      return result({});
    }
    if (path === "/api/auth/pairing-offer/cancel") {
      cancelled = true;
      links = [];
      return result({});
    }
    throw new Error("inert path refused");
  }) as typeof fetch;
  return {
    fetcher,
    calls,
    original,
    changed: () => {
      links = [];
    },
    cancelled: () => cancelled,
  };
}
test("authenticated fresh unused link is fenced and revoked without consent submission", async () => {
  const port = linkPort();
  const owned = await ownBrowserFollowupLink({
    accessToken: "inert-access",
    idempotencyKey: "inert-offer-001",
    fetcher: port.fetcher,
  });
  NodeAssert.equal(owned.token, credential);
  await owned.verify();
  port.changed();
  await NodeAssert.rejects(owned.verify);
  await owned.close();
  NodeAssert.equal(port.cancelled(), true);
  NodeAssert.equal(port.calls.includes("/oauth/token"), false);
});
test("uncertain issuance is cancelled and original failure survives", async () => {
  const port = linkPort("issuance-fault");
  await NodeAssert.rejects(
    ownBrowserFollowupLink({
      accessToken: "inert-access",
      idempotencyKey: "inert-offer-002",
      fetcher: port.fetcher,
    }),
    (error) => error === port.original,
  );
  NodeAssert.equal(port.cancelled(), true);
});
test("revoke failure still joins cancellation and permanently refuses success", async () => {
  const port = linkPort("revoke-fault");
  const owned = await ownBrowserFollowupLink({
    accessToken: "inert-access",
    idempotencyKey: "inert-offer-003",
    fetcher: port.fetcher,
  });
  const first = owned.close();
  const second = owned.close();
  NodeAssert.equal(first, second);
  await NodeAssert.rejects(first);
  await NodeAssert.rejects(second);
  NodeAssert.equal(port.cancelled(), true);
});
test("joined resource cleanup attempts every owner and preserves first exception", async () => {
  const actions: string[] = [];
  const original = new Error("inert primary");
  let unsafe = 0;
  const close = joinBrowserFollowupCleanup(
    [
      async () => {
        actions.push("one");
        throw original;
      },
      async () => {
        actions.push("two");
      },
    ],
    () => unsafe++,
  );
  const a = close(),
    b = close();
  NodeAssert.equal(a, b);
  await NodeAssert.rejects(a, (error) => error === original);
  NodeAssert.deepEqual(actions, ["two", "one"]);
  NodeAssert.equal(unsafe, 1);
  await NodeAssert.rejects(close());
});

test("the primary asset owner forwards exact current API request and response bytes", async () => {
  const root = temporary(),
    request = Buffer.from('{"inert":"request original"}'),
    reply = Buffer.from('{"inert":"response original"}');
  NodeFS.writeFileSync(NodePath.join(root, "index.html"), "inert static");
  let observed: Buffer | undefined;
  const backend = NodeHttp.createServer((incoming, outgoing) => {
    const bytes: Buffer[] = [];
    incoming.on("data", (piece) => bytes.push(piece));
    incoming.on("end", () => {
      observed = Buffer.concat(bytes);
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(reply);
    });
  });
  await new Promise<void>((resolve) => backend.listen(4887, "127.0.0.1", resolve));
  const assets = await startBrowserFollowupAssets({
    CI: "true",
    port: 4885,
    pin: pinBrowserFollowupAssets(root),
  });
  try {
    const response = await fetch("http://127.0.0.1:4885/api/inert", {
      method: "POST",
      body: request,
    });
    NodeAssert.deepEqual(Buffer.from(await response.arrayBuffer()), reply);
    NodeAssert.deepEqual(observed, request);
  } finally {
    await assets.close();
    await new Promise<void>((resolve, reject) =>
      backend.close((error) => (error ? reject(error) : resolve())),
    );
    NodeFS.rmSync(root, { recursive: true });
  }
});
test("the exact executable is physically pinned and byte or mode replacement refuses further capture", () => {
  const root = temporary(),
    binary = NodePath.join(root, "binary");
  NodeFS.writeFileSync(binary, "inert executable", { mode: 0o500 });
  const pin = pinBrowserFollowupExecutable(binary);
  try {
    pin.verify();
    NodeFS.chmodSync(binary, 0o700);
    NodeAssert.throws(pin.verify);
    NodeFS.writeFileSync(binary, "changed executable");
    NodeAssert.throws(pin.verify);
    const alias = NodePath.join(root, "alias");
    NodeFS.symlinkSync(binary, alias);
    NodeAssert.throws(() => pinBrowserFollowupExecutable(alias));
  } finally {
    NodeFS.rmSync(root, { recursive: true });
  }
});
