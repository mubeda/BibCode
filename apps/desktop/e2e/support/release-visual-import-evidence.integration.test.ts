// @effect-diagnostics nodeBuiltinImport:off - Hermetic fake-port integration for the actual CI evidence caller.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeNet from "node:net";
import { it as test } from "vite-plus/test";
import type { startThrottleProxy as StartThrottleProxy } from "../../../../scripts/throttle-proxy.ts";
import * as actualProxy from "../../../../scripts/throttle-proxy.ts";
import * as actualOwner from "./release-visual-import-evidence.ts";

const repository = NodeURL.fileURLToPath(new NodeURL.URL("../../../../", import.meta.url));
const file = (name: string) => NodePath.join(repository, name);
const read = (name: string) => NodeFS.readFileSync(file(name), "utf8");
const support = "apps/desktop/e2e/support/";

const sourceNames = [
  "scripts/throttle-proxy.ts",
  support + "release-visual-import-evidence.ts",
  support + "ci-import-private-evidence.ts",
  support + "release-visual-browser-followups-transport.ts",
  support + "release-visual-browser-followups-caller.ts",
  support + "release-visual-browser-followups-caller-resources.ts",
  "apps/desktop/e2e/qualify-delivery-retry.ts",
];
const hash = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const sourceHashes = sourceNames.map((name) => [name, hash(NodeFS.readFileSync(file(name)))]);
function extract(source: string, start: string, end: string): string {
  const begin = source.indexOf(start),
    finish = source.indexOf(end, begin + start.length);
  NodeAssert.ok(begin >= 0 && finish > begin);
  return source.slice(begin, finish);
}
const cleanupSource = extract(
  read(support + "release-visual-browser-followups-caller-resources.ts"),
  "export function joinBrowserFollowupCleanup(",
  "export function pinBrowserFollowupAssets(",
);
const joinCleanup = NodeVM.runInNewContext(
  NodeModule.stripTypeScriptTypes(cleanupSource.replace(/^export /gm, "")) +
    "\njoinBrowserFollowupCleanup",
);
const callerSource = read(support + "release-visual-browser-followups-caller.ts");
const prepareSource = extract(
  callerSource,
  "export async function prepareBrowserFollowupCaller(",
  "\nexport ",
);
const deliverySource = read("apps/desktop/e2e/qualify-delivery-retry.ts");
const importSource = extract(
  deliverySource,
  "async function importProject(",
  "async function selectClaudeModel(",
);
const clickSource = extract(deliverySource, "const click = async", "const row =");
function frame(value: unknown, masked = false): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(bytes.length < 126 ? 2 : 4);
  prefix[0] = 129;
  prefix[1] = (masked ? 128 : 0) | (bytes.length < 126 ? bytes.length : 126);
  if (prefix.length === 4) prefix.writeUInt16BE(bytes.length, 2);
  if (!masked) return Buffer.concat([prefix, bytes]);
  const mask = Buffer.from([7, 11, 19, 23]),
    body = Buffer.from(bytes);
  for (let i = 0; i < body.length; i++) body[i] = (body[i] ?? 0) ^ (mask[i % 4] ?? 0);
  return Buffer.concat([prefix, mask, body]);
}
const recipient = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicExponent: 65537,
});
const publicDer = recipient.publicKey.export({ type: "spki", format: "der" });
const environment = {
  CI: "true",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_JOB: "visual_core",
  GITHUB_SHA: "1".repeat(40),
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  BIBCODE_DELIVERY_UI_SELECTION: "release-visual-browser-followups",
  BIBCODE_IMPORT_EVIDENCE_SELECTED: "true",
  BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI: publicDer.toString("base64"),
  BIBCODE_IMPORT_EVIDENCE_PUBLIC_SHA256: hash(publicDer),
};
const results: unknown[] = [];
for (const outcome of [
  "success",
  "failure",
  "publication-refused-error",
  "publication-refused-undefined",
]) {
  test(`actual import bootstrap/proxy/owner/crypto preserves the complete caller: ${outcome}`, async () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeFS.realpathSync.native(NodeOS.tmpdir()), "bibcode-import-integrated-"),
    );
    NodeFS.chmodSync(root, 0o700);
    const evidenceRoot = NodePath.join(root, "evidence");
    NodeFS.mkdirSync(evidenceRoot, { mode: 0o700 });
    if (outcome.startsWith("publication-refused")) NodeFS.chmodSync(evidenceRoot, 0o755);
    const inputPaths = ["primary.html", "hosted.html", "binary.inert", "recipe.json"].map((name) =>
      NodePath.join(root, name),
    );
    for (const path of inputPaths)
      NodeFS.writeFileSync(path, "immutable inert owned input " + NodePath.basename(path), {
        mode: 0o600,
      });
    const immutable = inputPaths.map((path) => hash(NodeFS.readFileSync(path)));
    const verifyInputs = async () =>
      NodeAssert.deepEqual(
        inputPaths.map((path) => hash(NodeFS.readFileSync(path))),
        immutable,
      );
    const evidence = actualOwner.createImportEvidenceOwner({
      env: environment,
      evidenceRoot,
      platform: "linux",
    });
    const project = "/fixture/owned";
    const failure = {
      _tag: "Exit",
      requestId: "2",
      exit: {
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: { detail: "inert owned import refusal" } }],
      },
    };
    const reply =
      outcome === "success"
        ? { _tag: "Exit", requestId: "2", exit: { _tag: "Success", value: { sequence: 1 } } }
        : failure;
    const requestWire = Buffer.concat([
      Buffer.from(
        "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: inert-http-secret\r\n\r\n",
      ),
      frame(
        {
          _tag: "Request",
          id: "0",
          tag: "auth.authenticate",
          payload: { token: "inert-auth-frame-secret" },
          headers: [],
        },
        true,
      ),
      frame(
        { _tag: "Request", id: "1", tag: "subscribeServerConfig", payload: {}, headers: [] },
        true,
      ),
      frame(
        {
          _tag: "Request",
          id: "2",
          tag: "orchestration.dispatchCommand",
          payload: { type: "project.create", workspaceRoot: project },
          headers: [["Authorization", "inert-request-header"]],
        },
        true,
      ),
    ]);
    const replyWire = Buffer.concat([
      Buffer.from(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      ),
      frame({
        _tag: "Exit",
        requestId: "0",
        exit: { _tag: "Success", value: { token: "inert-auth-reply-secret" } },
      }),
      frame({ ...reply, headers: [["inert-reply-header", "omit"]] }),
    ]);
    const peerBytes: Buffer[] = [],
      forwarded: Buffer[] = [],
      peerSockets = new Set<NodeNet.Socket>();
    const peer = NodeNet.createServer((socket) => {
      peerSockets.add(socket);
      socket.on("close", () => peerSockets.delete(socket));
      socket.on("data", (bytes) => {
        peerBytes.push(Buffer.from(bytes));
        if (Buffer.concat(peerBytes).length === requestWire.length) socket.write(replyWire);
      });
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const address = peer.address();
    NodeAssert.ok(address !== null && typeof address === "object");
    let proxyPort = 0,
      client: NodeNet.Socket | undefined,
      submitted = 0,
      composer = false;
    const closed: string[] = [],
      callbacks: unknown[] = [],
      phases: string[] = [];
    let prepared: { verify: () => Promise<void>; close: () => Promise<void> } | undefined;
    const prepare = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(prepareSource.replace(/^export /gm, "")) +
        "\nprepareBrowserFollowupCaller",
      {
        Buffer,
        refused: () => Error("Owned browser follow-up caller refused."),
        readBrowserFollowupBuildRecipe: () => {},
        pinBrowserFollowupExecutable: () => ({ verify() {} }),
        pinBrowserFollowupAssets: (path: string) => ({ path }),
        startBrowserFollowupAssets: async ({ port }: { port: number }) => ({
          verify() {},
          close: async () => {
            closed.push(port === 4885 ? "primary" : "hosted");
          },
        }),
        joinBrowserFollowupCleanup: joinCleanup,
        prepareBrowserFollowupPng: () => ({ verify() {} }),
        startThrottleProxy: async (options: Parameters<typeof StartThrottleProxy>[0]) => {
          const original = options.observeTraffic;
          const proxy = await actualProxy.startThrottleProxy({
            ...options,
            listenPort: 0,
            targetPort: address.port,
            observeTraffic: (connection: string, direction: "request" | "reply", bytes: Buffer) => {
              const value = original?.(connection, direction, bytes);
              callbacks.push(value);
              return value;
            },
          });
          proxyPort = proxy.port;
          return {
            ...proxy,
            close: async () => {
              await proxy.close();
              closed.push("proxy");
            },
          };
        },
      },
    );
    try {
      prepared = await prepare({
        CI: "true",
        root,
        primaryAssets: inputPaths[0],
        hostedAssets: inputPaths[1],
        binary: inputPaths[2],
        source: environment.GITHUB_SHA,
        repository,
        admitOwner: async () => {},
        verifyInputs,
        observeUnsafeCleanup: () => NodeAssert.fail("cleanup must stay safe"),
        importEvidence: evidence,
      });
      NodeAssert.ok(prepared);
      await prepared.verify();
      const waitFailure =
        outcome === "publication-refused-undefined"
          ? undefined
          : Error("original inert composer deadline");
      const exchange = async () => {
        submitted++;
        client = NodeNet.connect(proxyPort, "127.0.0.1");
        await new Promise<void>((resolve, reject) => {
          client!.once("connect", resolve);
          client!.once("error", reject);
        });
        const completed = new Promise<void>((resolve, reject) => {
          client!.on("data", (bytes) => {
            forwarded.push(Buffer.from(bytes));
            if (Buffer.concat(forwarded).length === replyWire.length) resolve();
          });
          client!.once("error", reject);
        });
        client.write(requestWire);
        await completed;
        composer = outcome === "success";
      };
      let filled = "";
      const bindings: Record<string, unknown> = {};
      for (const match of importSource.matchAll(/([A-Za-z_$][\w$]*)\??\.pinProject\(/g))
        bindings[match[1]!] = evidence;
      if (Object.keys(bindings).length === 0) evidence.pinProject(project);
      const run = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(clickSource + importSource) + "\nimportProject",
        {
          ...bindings,
          Buffer,
          importModelBinding: undefined,
          importEvidence: evidence,
          importEvidenceOwner: evidence,
          step: (value: string) => phases.push(value),
          composer: "owned-composer",
          selectClaudeModel: async () => {},
          owner: {
            until: async (check: () => Promise<boolean>) => NodeAssert.equal(await check(), true),
          },
          b: () => ({
            $: (selector: string) => ({
              isDisplayed: async () => true,
              isExisting: async () => true,
              setValue: async (value: string) => {
                filled = value;
              },
              waitForEnabled: async () => {},
              waitForDisplayed: async () => {
                if (selector === "owned-composer" && !composer) throw waitFailure;
              },
              click: async () => {
                if (selector === "button=Open project") {
                  NodeAssert.equal(filled, project);
                  await exchange();
                }
              },
            }),
          }),
        },
      );
      if (outcome === "success") await NodeAssert.doesNotReject(run(project));
      else {
        let rejected = false,
          original: unknown;
        try {
          await run(project);
        } catch (error) {
          rejected = true;
          original = error;
        }
        NodeAssert.equal(rejected, true);
        NodeAssert.equal(original, waitFailure);
      }
      NodeAssert.equal(submitted, 1);
      NodeAssert.equal(phases.includes("import-wait-composer"), true);
      NodeAssert.deepEqual(Buffer.concat(peerBytes), requestWire);
      NodeAssert.deepEqual(Buffer.concat(forwarded), replyWire);
      NodeAssert.equal(callbacks.length > 0, true);
      NodeAssert.equal(
        callbacks.every((value) => value === undefined),
        true,
      );
      const expectedStatus =
        outcome === "success"
          ? "success"
          : outcome === "failure"
            ? "failure-encrypted"
            : "failure-omitted";
      NodeAssert.equal(evidence.status(), expectedStatus);
      const ready = NodePath.join(evidenceRoot, "import-private", "ready");
      let packets = 0;
      if (outcome === "failure") {
        const names = [
          "context.json",
          "reply.aesgcm.bin",
          "key.rsa-oaep-sha256.bin",
          "nonce.bin",
          "tag.bin",
        ];
        NodeAssert.deepEqual(NodeFS.readdirSync(ready).sort(), names.slice().sort());
        packets = 1;
        for (const directory of [evidenceRoot, NodePath.dirname(ready), ready])
          NodeAssert.equal(NodeFS.statSync(directory).mode & 0o777, 0o700);
        for (const name of names)
          NodeAssert.equal(NodeFS.statSync(NodePath.join(ready, name)).mode & 0o777, 0o600);
        const part = (name: string) => NodeFS.readFileSync(NodePath.join(ready, name));
        const key = NodeCrypto.privateDecrypt(
          {
            key: recipient.privateKey,
            padding: NodeCrypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
          },
          part("key.rsa-oaep-sha256.bin"),
        );
        let plaintext: Buffer | undefined;
        try {
          const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, part("nonce.bin"));
          decipher.setAAD(part("context.json"));
          decipher.setAuthTag(part("tag.bin"));
          plaintext = Buffer.concat([decipher.update(part("reply.aesgcm.bin")), decipher.final()]);
          NodeAssert.deepEqual(plaintext, Buffer.from(JSON.stringify(failure)));
          for (const secret of [
            "inert-http-secret",
            "inert-auth-frame-secret",
            "inert-request-header",
            "inert-auth-reply-secret",
            "inert-reply-header",
          ])
            NodeAssert.equal(plaintext.includes(Buffer.from(secret)), false);
        } finally {
          plaintext?.fill(0);
          key.fill(0);
        }
      } else NodeAssert.equal(NodeFS.existsSync(ready), false);
      const firstClose = prepared.close();
      NodeAssert.equal(prepared.close(), firstClose);
      await firstClose;
      NodeAssert.deepEqual(closed, ["proxy", "hosted", "primary"]);
      evidence.close();
      NodeAssert.equal(evidence.status(), expectedStatus);
      await verifyInputs();
      for (const [name, initial] of sourceHashes)
        NodeAssert.equal(hash(NodeFS.readFileSync(file(name!))), initial);
      results.push({
        outcome,
        packets,
        status: expectedStatus,
        originalRejectionPreserved: outcome !== "success",
        bytesUnchanged: true,
        callbacksUndefined: true,
        cleanupJoined: true,
        inputsUnchanged: true,
      });
    } finally {
      if (prepared) await prepared.close();
      client?.destroy();
      evidence.close();
      for (const socket of peerSockets) socket.destroy();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
      NodeFS.chmodSync(evidenceRoot, 0o700);
      NodeFS.rmSync(root, { recursive: true, force: true });
      if (process.env.BIBCODE_HERMETIC_PROOF)
        NodeFS.writeFileSync(
          process.env.BIBCODE_HERMETIC_PROOF,
          JSON.stringify({ results, sourceHashes }),
          { mode: 0o600 },
        );
    }
  });
}
