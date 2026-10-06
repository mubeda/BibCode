// @effect-diagnostics nodeBuiltinImport:off - Disposable CI installation parent and exact loopback listener ownership.
// @effect-diagnostics globalDate:off - One bounded exact-port acquisition deadline.
// @effect-diagnostics globalTimers:off - The fixture joins bounded polling and socket closure.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

export async function withNativeFollowupInstallFailure<A>(
  input: { laneRoot: string; app: string; platform: string; unsafe: () => void },
  run: () => Promise<A>,
): Promise<A> {
  const parent = NodePath.join(input.laneRoot, "installed"),
    expected = NodePath.join(parent, "BiBCode.AppImage"),
    stat = NodeFS.lstatSync(parent);
  if (
    input.platform !== "linux" ||
    input.app !== expected ||
    NodeFS.realpathSync(parent) !== parent ||
    NodeFS.realpathSync(input.app) !== input.app ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Native follow-up installer fixture refused.");
  const before = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(input.app))
    .digest("hex");
  let failed = false,
    original: unknown,
    result: A | undefined;
  try {
    NodeFS.chmodSync(parent, stat.mode & 0o555);
    result = await run();
  } catch (error) {
    failed = true;
    original = error;
  }
  try {
    const now = NodeFS.lstatSync(parent);
    if (now.dev !== stat.dev || now.ino !== stat.ino || !now.isDirectory() || now.isSymbolicLink())
      throw new Error("Native follow-up installation identity changed.");
    NodeFS.chmodSync(parent, stat.mode & 0o777);
    if (
      NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(input.app)).digest("hex") !==
      before
    )
      throw new Error("Native follow-up application changed.");
  } catch (error) {
    input.unsafe();
    if (!failed) {
      failed = true;
      original = error;
    }
  }
  if (failed) throw original;
  return result as A;
}
export interface NativeFollowupPortHold {
  verify: () => Promise<void>;
  close: () => Promise<void>;
}
export async function acquireNativeFollowupPortHold(input: {
  port: number;
  deadlineMs: number;
  probe: () => Promise<NativeFollowupPortHold | null>;
  pause: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<NativeFollowupPortHold> {
  if (
    !Number.isInteger(input.port) ||
    input.port < 1024 ||
    input.port > 65535 ||
    [3773, 5733, 13773, 18431, 18432].includes(input.port) ||
    input.deadlineMs < 1 ||
    input.deadlineMs > 90000
  )
    throw new Error("Native follow-up port admission refused.");
  const deadline = Date.now() + input.deadlineMs;
  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw new Error("Native follow-up port admission cancelled.");
    const hold = await input.probe();
    if (hold) {
      if (input.signal?.aborted) {
        await hold.close();
        throw new Error("Native follow-up port admission cancelled.");
      }
      return hold;
    }
    await input.pause();
  }
  throw new Error("Native follow-up original port did not become available.");
}
/** Binds only the exact former private backend port. No server protocol is impersonated. */
export async function createNativeFollowupPortHold(
  port: number,
  signal: AbortSignal,
): Promise<NativeFollowupPortHold> {
  return acquireNativeFollowupPortHold({
    port,
    signal,
    deadlineMs: 90000,
    pause: () => new Promise((resolve) => setTimeout(resolve, 10)),
    probe: () =>
      new Promise((resolve, reject) => {
        const server = NodeNet.createServer((socket) => socket.destroy());
        server.once("error", (error: NodeJS.ErrnoException) => {
          server.close();
          if (error.code === "EADDRINUSE") resolve(null);
          else reject(new Error("Native follow-up port hold failed."));
        });
        server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
          let closed = false;
          resolve({
            verify: async () => {
              const address = server.address();
              if (
                closed ||
                !server.listening ||
                !address ||
                typeof address === "string" ||
                address.address !== "127.0.0.1" ||
                address.port !== port
              )
                throw new Error("Native follow-up port hold changed.");
            },
            close: () =>
              new Promise<void>((done, refuse) => {
                if (closed) return done();
                server.close((error) => {
                  closed = true;
                  if (error) refuse(new Error("Native follow-up port hold cleanup failed."));
                  else done();
                });
              }),
          });
        });
      }),
  });
}
