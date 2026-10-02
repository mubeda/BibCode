// @effect-diagnostics nodeBuiltinImport:off - These fixtures own real loopback HTTP connections.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";
import {
  beginHeldWorkspaceUpload,
  HeldWorkspaceUploadError,
  type HeldWorkspaceUpload,
} from "./held-workspace-upload.ts";

const capability = "fixture-only-capability";
const relativePath = "protection-witness.txt";
const relativeUrl = `/api/transfers/${capability}`;

async function fixture(
  onHeaders: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
  run: (server: {
    readonly endpoint: string;
    readonly headers: Promise<{
      request: NodeHttp.IncomingMessage;
      response: NodeHttp.ServerResponse;
    }>;
    readonly prefix: Promise<Buffer>;
    readonly body: Promise<Buffer>;
    readonly disconnected: Promise<void>;
    readonly setUpload: (upload: HeldWorkspaceUpload) => void;
  }) => Promise<void>,
  reply = true,
): Promise<void> {
  const headers = Promise.withResolvers<{
    request: NodeHttp.IncomingMessage;
    response: NodeHttp.ServerResponse;
  }>();
  const prefix = Promise.withResolvers<Buffer>();
  const body = Promise.withResolvers<Buffer>();
  const disconnected = Promise.withResolvers<void>();
  const sockets = new Set<NodeNet.Socket>();
  const socketJoins: Array<Promise<void>> = [];
  let upload: HeldWorkspaceUpload | undefined;
  const server = NodeHttp.createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    const closed = Promise.withResolvers<void>();
    socketJoins.push(closed.promise);
    socket.once("close", () => {
      sockets.delete(socket);
      disconnected.resolve();
      closed.resolve();
    });
  });
  server.on("checkContinue", (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      prefix.resolve(Buffer.concat(chunks));
    });
    request.on("error", () => undefined);
    request.on("end", () => {
      body.resolve(Buffer.concat(chunks));
      if (reply && !response.headersSent) {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ relativePath }));
      }
    });
    headers.resolve({ request, response });
    onHeaders(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Loopback fixture unavailable");
  try {
    await run({
      endpoint: `http://127.0.0.1:${address.port}`,
      headers: headers.promise,
      prefix: prefix.promise,
      body: body.promise,
      disconnected: disconnected.promise,
      setUpload: (value) => {
        upload = value;
      },
    });
  } finally {
    try {
      await upload?.abort();
    } finally {
      for (const socket of sockets) socket.destroy();
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        await Promise.all(socketJoins);
      }
    }
  }
}

describe("held workspace upload fixture", () => {
  it("admits only after real 100 Continue, holds one byte, and finishes exactly once", async () => {
    await fixture(
      () => undefined,
      async (server) => {
        let admitted = false;
        const starting = beginHeldWorkspaceUpload({
          endpoint: server.endpoint,
          relativeUrl,
          relativePath,
        });
        void starting.then(
          () => {
            admitted = true;
          },
          () => undefined,
        );
        const { request, response } = await Promise.race([
          server.headers,
          starting.then(() => server.headers),
        ]);
        expect(admitted).toBe(false);
        expect(request.method).toBe("POST");
        expect(request.url).toBe(relativeUrl);
        expect(request.headers).toMatchObject({ expect: "100-continue", "content-length": "2" });
        expect(request.headers.authorization).toBeUndefined();
        response.writeContinue();
        const upload = await starting;
        server.setUpload(upload);
        expect(await server.prefix).toEqual(Buffer.from("o"));
        expect(request.complete).toBe(false);
        const first = upload.finish();
        expect(upload.finish()).toBe(first);
        expect(await first).toEqual({ status: 201, bytesSent: 2, requestClosed: true });
        expect(await server.body).toEqual(Buffer.from("ok"));
        await server.disconnected;
      },
    );
  });

  it("refuses a final response before admission without exposing its body or signed URL", async () => {
    await fixture(
      (_request, response) => {
        response.writeHead(403);
        response.end(`private ${relativeUrl}`);
      },
      async (server) => {
        const error = await beginHeldWorkspaceUpload({
          endpoint: server.endpoint,
          relativeUrl,
          relativePath,
        }).catch((error: unknown) => error);
        expect(error).toMatchObject({ reason: "admission-refused" });
        expect(String(error)).not.toContain(capability);
        expect(JSON.stringify(error)).not.toContain(capability);
        await server.disconnected;
      },
    );
  });

  it("times out admission and joins its actual connection", async () => {
    await fixture(
      () => undefined,
      async (server) => {
        await expect(
          beginHeldWorkspaceUpload({
            endpoint: server.endpoint,
            relativeUrl,
            relativePath,
            limits: { admissionMs: 50 },
          }),
        ).rejects.toMatchObject({ reason: "admission-timeout" });
        await server.disconnected;
      },
    );
  });

  it("completes a timed-out hold but preserves the qualification failure", async () => {
    await fixture(
      (_request, response) => response.writeContinue(),
      async (server) => {
        const upload = await beginHeldWorkspaceUpload({
          endpoint: server.endpoint,
          relativeUrl,
          relativePath,
          limits: { holdMs: 50 },
        });
        server.setUpload(upload);
        await expect(upload.completion).rejects.toMatchObject({ reason: "hold-timeout" });
        expect(await server.body).toEqual(Buffer.from("ok"));
        await expect(upload.finish()).rejects.toMatchObject({ reason: "hold-timeout" });
        await server.disconnected;
      },
    );
  });

  it("bounds and joins a completed body whose server never returns a response", async () => {
    await fixture(
      (_request, response) => response.writeContinue(),
      async (server) => {
        const upload = await beginHeldWorkspaceUpload({
          endpoint: server.endpoint,
          relativeUrl,
          relativePath,
          limits: { completionMs: 50 },
        });
        server.setUpload(upload);
        await expect(upload.finish()).rejects.toMatchObject({ reason: "completion-timeout" });
        expect(await server.body).toEqual(Buffer.from("ok"));
        await server.disconnected;
      },
      false,
    );
  });

  it("aborts and joins a held request without claiming a complete body", async () => {
    await fixture(
      (_request, response) => response.writeContinue(),
      async (server) => {
        const upload = await beginHeldWorkspaceUpload({
          endpoint: server.endpoint,
          relativeUrl,
          relativePath,
        });
        server.setUpload(upload);
        await server.prefix;
        await upload.abort();
        await expect(upload.completion).rejects.toMatchObject({ reason: "aborted" });
        await server.disconnected;
      },
    );
  });

  it("rejects a mismatched successful receipt", async () => {
    await fixture(
      (request, response) => {
        response.writeContinue();
        request.once("end", () => {
          response.writeHead(201);
          response.end(JSON.stringify({ relativePath: "other.txt" }));
        });
      },
      async (server) => {
        const upload = await beginHeldWorkspaceUpload({
          endpoint: server.endpoint,
          relativeUrl,
          relativePath,
        });
        server.setUpload(upload);
        await expect(upload.finish()).rejects.toMatchObject({ reason: "invalid-response" });
        await server.disconnected;
      },
      false,
    );
  });

  it.each(["admission-close", "oversized-receipt", "truncated-receipt"] as const)(
    "joins %s without disclosing a signed capability",
    async (kind) => {
      await fixture(
        (request, response) => {
          response.on("error", () => undefined);
          if (kind === "admission-close") {
            request.socket.destroy();
            return;
          }
          response.writeContinue();
          request.once("end", () => {
            if (kind === "oversized-receipt") {
              response.writeHead(201);
              response.end(JSON.stringify({ relativePath, extra: capability.repeat(200) }));
            } else {
              response.writeHead(201, { "content-length": "100" });
              response.write('{"relativePath":');
              response.socket?.end();
            }
          });
        },
        async (server) => {
          let error: unknown;
          try {
            const upload = await beginHeldWorkspaceUpload({
              endpoint: server.endpoint,
              relativeUrl,
              relativePath,
            });
            server.setUpload(upload);
            await upload.finish();
          } catch (cause) {
            error = cause;
          }
          expect(error).toMatchObject({
            reason: kind === "oversized-receipt" ? "invalid-response" : "transport",
          });
          expect(String(error)).not.toContain(capability);
          expect(JSON.stringify(error)).not.toContain(capability);
          await server.disconnected;
        },
        false,
      );
    },
  );

  it.each([".", ".."])(
    "refuses normalized dot-segment %s before any HTTP dispatch",
    async (leaf) => {
      let requests = 0;
      await fixture(
        (_request, response) => {
          requests += 1;
          response.writeHead(403);
          response.end();
        },
        async (server) => {
          const outcome = await beginHeldWorkspaceUpload({
            endpoint: server.endpoint,
            relativeUrl: `/api/transfers/${leaf}`,
            relativePath,
          }).catch((error: unknown) => error);
          expect({
            reason: outcome instanceof HeldWorkspaceUploadError ? outcome.reason : "unexpected",
            requests,
          }).toEqual({ reason: "invalid-target", requests: 0 });
        },
      );
    },
  );

  it.each([
    "https://elsewhere.invalid/api/transfers/cap",
    "/api/transfers/cap?overwrite=1",
    "/api/assets/cap/file",
    "//elsewhere.invalid/api/transfers/cap",
  ])("refuses an unowned or widened target %s", async (url) => {
    await expect(
      beginHeldWorkspaceUpload({
        endpoint: "http://127.0.0.1:14950",
        relativeUrl: url,
        relativePath,
      }),
    ).rejects.toMatchObject({ reason: "invalid-target" });
  });
});
