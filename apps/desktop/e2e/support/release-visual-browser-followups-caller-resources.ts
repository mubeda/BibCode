// @effect-diagnostics nodeBuiltinImport:off - CI-only immutable asset bytes and joined loopback resource ownership.
// @effect-diagnostics globalFetch:off - Authenticated current public contracts on one fixed owned loopback endpoint.
// @effect-diagnostics globalDate:off - The owning public grant has a real finite expiry.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import {
  AuthCreatePairingOfferInput,
  AuthPairingOfferResult,
  AuthPairingLink,
  AuthClientSession,
  AuthRevokePairingLinkInput,
  AuthCancelPairingOfferInput,
} from "../../../../packages/contracts/src/auth.ts";
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const DateTime = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/DateTime");
const refused = () => new Error("Owned browser follow-up caller resource refused.");
const hash = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
export function pinBrowserFollowupExecutable(path: string) {
  const stat = NodeFS.lstatSync(path),
    sha256 = hash(NodeFS.readFileSync(path));
  if (
    !NodePath.isAbsolute(path) ||
    NodeFS.realpathSync(path) !== path ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    !(stat.mode & 0o111)
  )
    throw refused();
  const identity = (value: NodeFS.Stats) =>
    [value.dev, value.ino, value.uid, value.mode, value.size, value.mtimeMs, value.ctimeMs].join(
      ":",
    );
  return {
    verify: () => {
      const current = NodeFS.lstatSync(path);
      if (
        current.isSymbolicLink() ||
        NodeFS.realpathSync(path) !== path ||
        identity(current) !== identity(stat) ||
        hash(NodeFS.readFileSync(path)) !== sha256
      )
        throw refused();
    },
  };
}
const decode = <A>(schema: unknown, value: unknown): A =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema))(value) as A;
/** Publish the promise before invoking a callback, so reentrant teardown joins the same result. */
export function joinBrowserFollowupCleanup(
  resources: Array<() => Promise<void>>,
  observeUnsafeCleanup: () => void,
) {
  let joined: Promise<void> | undefined;
  return () => {
    if (joined) return joined;
    let resolve!: () => void, reject!: (error: unknown) => void;
    joined = new Promise<void>((ok, bad) => {
      resolve = ok;
      reject = bad;
    });
    void (async () => {
      let failed = false,
        original: unknown;
      for (const close of resources.toReversed())
        try {
          await close();
        } catch (error) {
          if (!failed) original = error;
          failed = true;
        }
      if (failed) {
        try {
          observeUnsafeCleanup();
        } catch {
          /* Never replace cleanup refusal. */
        }
        throw original;
      }
    })().then(resolve, reject);
    return joined;
  };
}
/** A fixed full inventory pins canonical file/directory identity and original bytes; it never changes HTML. */
export function pinBrowserFollowupAssets(root: string) {
  if (
    !NodePath.isAbsolute(root) ||
    root === NodePath.parse(root).root ||
    NodeFS.realpathSync(root) !== root
  )
    throw refused();
  const inventory = () => {
    const found = new Map<
      string,
      { dev: number; ino: number; uid: number; mode: number; size: number; sha256: string | null }
    >();
    const visit = (path: string) => {
      const stat = NodeFS.lstatSync(path),
        relative = NodePath.relative(root, path);
      if (
        stat.isSymbolicLink() ||
        NodeFS.realpathSync(path) !== path ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw refused();
      found.set(relative, {
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
        mode: stat.mode,
        size: stat.isFile() ? stat.size : 0,
        sha256: stat.isFile() ? hash(NodeFS.readFileSync(path)) : null,
      });
      if (stat.isDirectory())
        for (const name of NodeFS.readdirSync(path).sort()) visit(NodePath.join(path, name));
    };
    visit(root);
    return found;
  };
  const initial = inventory();
  if (!initial.get("index.html")?.sha256 || initial.size > 8192) throw refused();
  const ancestors = new Map<string, string>();
  for (let path = NodePath.dirname(root); ; path = NodePath.dirname(path)) {
    const stat = NodeFS.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || NodeFS.realpathSync(path) !== path)
      throw refused();
    ancestors.set(path, [stat.dev, stat.ino, stat.uid, stat.mode].join(":"));
    if (path === NodePath.dirname(path)) break;
  }
  const verify = () => {
    for (const [path, identity] of ancestors) {
      const stat = NodeFS.lstatSync(path);
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        NodeFS.realpathSync(path) !== path ||
        [stat.dev, stat.ino, stat.uid, stat.mode].join(":") !== identity
      )
        throw refused();
    }
    const current = inventory();
    if (current.size !== initial.size) throw refused();
    for (const [path, value] of initial)
      if (JSON.stringify(current.get(path)) !== JSON.stringify(value)) throw refused();
  };
  return {
    root,
    verify,
    read: (relative: string) => {
      verify();
      if (!initial.get(relative)?.sha256) throw refused();
      const bytes = NodeFS.readFileSync(NodePath.join(root, relative));
      verify();
      return bytes;
    },
    has: (relative: string) => initial.get(relative)?.sha256 !== null && initial.has(relative),
  };
}
/** Only the primary UI forwards current public API bodies; hosted assets have no backend fallback. */
export async function startBrowserFollowupAssets(input: {
  CI: string | undefined;
  port: 4885 | 4893;
  pin: ReturnType<typeof pinBrowserFollowupAssets>;
  observeUnsafeCleanup?: () => void;
}) {
  if (input.CI !== "true" || ![4885, 4893].includes(input.port)) throw refused();
  input.pin.verify();
  const sockets = new Set<import("node:net").Socket>(),
    requests = new Set<NodeHttp.ClientRequest>();
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".woff2": "font/woff2",
  };
  let closed = false,
    failed = false;
  const server = NodeHttp.createServer((request, response) => {
    try {
      if (closed || failed || !request.url?.startsWith("/") || request.url.startsWith("//"))
        throw refused();
      input.pin.verify();
      const url = new URL(request.url, "http://127.0.0.1:" + input.port);
      if (
        input.port === 4885 &&
        /^\/(?:api(?:\/|$)|oauth(?:\/|$)|\.well-known(?:\/|$)|attachments(?:\/|$))/.test(
          url.pathname,
        )
      ) {
        const upstream = NodeHttp.request(
          {
            hostname: "127.0.0.1",
            port: 4887,
            path: request.url,
            method: request.method,
            headers: request.headers,
          },
          (reply) => {
            response.writeHead(reply.statusCode ?? 502, reply.headers);
            reply.pipe(response);
          },
        );
        requests.add(upstream);
        upstream.once("close", () => requests.delete(upstream));
        upstream.once("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        request.once("aborted", () => upstream.destroy());
        request.pipe(upstream);
        return;
      }
      if (!["GET", "HEAD"].includes(request.method ?? "") || /%2f|%5c|\\/i.test(url.pathname)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const decoded = decodeURIComponent(url.pathname),
        relative = decoded.replace(/^\//, "");
      if (
        relative.split("/").some((value) => value === ".." || value === ".") ||
        relative.includes("\0")
      )
        throw refused();
      const file = input.pin.has(relative)
        ? relative
        : !NodePath.extname(relative)
          ? "index.html"
          : null;
      if (file === null) {
        response.writeHead(404);
        response.end();
        return;
      }
      const bytes = input.pin.read(file);
      response.writeHead(200, {
        "content-type": mime[NodePath.extname(file)] ?? "application/octet-stream",
        "content-length": bytes.length,
        "cache-control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      failed = true;
      try {
        input.observeUnsafeCleanup?.();
      } catch {
        /* Preserve refusal. */
      }
      if (!response.headersSent) response.writeHead(503);
      response.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const close = joinBrowserFollowupCleanup(
    [
      async () => {
        closed = true;
        for (const request of requests) request.destroy();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      },
    ],
    input.observeUnsafeCleanup ?? (() => {}),
  );
  return {
    verify: () => {
      if (closed || failed) throw refused();
      input.pin.verify();
    },
    close,
  };
}
/** Uses the current authenticated pairing-offer/list/revoke/cancel contracts; there is no consent submission. */
export async function ownBrowserFollowupLink(input: {
  accessToken: string;
  idempotencyKey: string;
  fetcher?: typeof fetch;
  observeUnsafeCleanup?: () => void;
}) {
  if (!input.accessToken || !/^[-A-Za-z0-9._:]{8,128}$/.test(input.idempotencyKey)) throw refused();
  const fetcher = input.fetcher ?? fetch,
    endpoint = "http://127.0.0.1:4887";
  const request = async (path: string, body?: object) => {
    const response = await fetcher(endpoint + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + input.accessToken,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(path === "/api/auth/pairing-offer" ? { "idempotency-key": input.idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw refused();
    return response.status === 204 ? null : response.json();
  };
  const links = async () =>
    decode<AuthPairingLink[]>(
      Schema.Array(AuthPairingLink),
      await request("/api/auth/pairing-links"),
    );
  const clients = async () =>
    decode<AuthClientSession[]>(
      Schema.Array(AuthClientSession),
      await request("/api/auth/clients"),
    );
  const before = await links(),
    clientIds = (await clients()).map((value) => value.sessionId).sort();
  let issuedId: string | undefined,
    closed = false;
  const cancel = async () => {
    const body = decode<object>(AuthCancelPairingOfferInput, {
      idempotencyKey: input.idempotencyKey,
    });
    await request("/api/auth/pairing-offer/cancel", body);
  };
  const close = joinBrowserFollowupCleanup(
    [
      async () => {
        await cancel();
        const after = await links();
        if (
          after.length !== before.length ||
          !before.every((value) =>
            after.some((now) => JSON.stringify(value) === JSON.stringify(now)),
          )
        )
          throw refused();
        closed = true;
      },
      async () => {
        if (issuedId)
          await request(
            "/api/auth/pairing-links/revoke",
            decode<object>(AuthRevokePairingLinkInput, { id: issuedId }),
          );
      },
    ],
    input.observeUnsafeCleanup ?? (() => {}),
  );
  try {
    const payload = decode<object>(AuthCreatePairingOfferInput, {
      name: "Owned hosted backend",
      endpoint,
      reach: "this-computer",
      label: "Owned hosted backend",
    });
    const issued = decode<AuthPairingOfferResult>(
      AuthPairingOfferResult,
      await request("/api/auth/pairing-offer", payload),
    );
    issuedId = issued.id;
    if (
      issued.endpoint !== endpoint ||
      issued.reach !== "this-computer" ||
      DateTime.toEpochMillis(issued.expiresAt) <= Date.now() ||
      before.some((value) => value.id === issuedId)
    )
      throw refused();
    const after = await links(),
      added = after.filter((value) => !before.some((old) => old.id === value.id));
    if (
      added.length !== 1 ||
      added[0]!.id !== issuedId ||
      added[0]!.reach !== "this-computer" ||
      added[0]!.label !== "Owned hosted backend" ||
      added[0]!.credential.length < 8
    )
      throw refused();
    const owned = added[0]!,
      fingerprint = JSON.stringify(owned);
    const verify = async () => {
      if (closed || DateTime.toEpochMillis(owned.expiresAt) <= Date.now()) throw refused();
      const current = await links(),
        currentClients = (await clients()).map((value) => value.sessionId).sort();
      if (
        JSON.stringify(currentClients) !== JSON.stringify(clientIds) ||
        current.length !== before.length + 1 ||
        current.filter((value) => value.id === issuedId).length !== 1 ||
        JSON.stringify(current.find((value) => value.id === issuedId)) !== fingerprint ||
        !before.every((value) =>
          current.some((now) => JSON.stringify(value) === JSON.stringify(now)),
        )
      )
        throw refused();
    };
    await verify();
    return { token: owned.credential, verify, close };
  } catch (error) {
    try {
      await close();
    } catch {
      /* retain original admission/issuance failure */
    }
    throw error;
  }
}
