// @effect-diagnostics nodeBuiltinImport:off - This distribution test launches a real local process and HTTP fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, expect, it } from "vite-plus/test";

import { smokeServerDistribution } from "./smoke-server-distribution.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("proves packaged web, descriptor, pairing exchange, and clean shutdown", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-server-smoke-"));
  temporaryRoots.push(root);
  const binary = NodePath.join(root, "bibcode");
  const web = NodePath.join(root, "web");
  NodeFS.mkdirSync(web);
  NodeFS.writeFileSync(NodePath.join(web, "index.html"), "<main>Packaged BiBCode</main>");
  NodeFS.writeFileSync(
    binary,
    `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("bibcode 0.4.3\\n");
  process.exit(0);
}
if (args[0] === "pairing") {
  process.stdout.write(JSON.stringify({ credential: "pairing-secret" }) + "\\n");
  process.exit(0);
}
const server = http.createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<main>Packaged BiBCode</main>");
    return;
  }
  if (request.url === "/.well-known/bibcode/environment") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ environmentId: "fixture-environment" }));
    return;
  }
  if (request.url === "/oauth/token" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (!body.includes("pairing-secret")) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "access-token", token_type: "DPoP" }));
    });
    return;
  }
  response.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ httpBaseUrl: "http://127.0.0.1:" + address.port }) + "\\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
    { mode: 0o755 },
  );

  const result = await smokeServerDistribution({
    binary,
    expectedVersion: "0.4.3",
    timeoutMs: 10_000,
  });

  expect(result).toEqual({
    version: "0.4.3",
    environmentId: "fixture-environment",
    tokenType: "DPoP",
    webContainsBiBCode: true,
    exitCode: 0,
  });
});
