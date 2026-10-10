// @effect-diagnostics globalFetch:off - Inert loopback composition only; no browser or product starts.
// @effect-diagnostics globalTimers:off - Bounded inert fake-owner readiness only.
// @effect-diagnostics nodeBuiltinImport:off - Execute only actual controller subspans on inert ownership ports.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { prepareBrowserFollowupCaller } from "./release-visual-browser-followups-caller.ts";
import { fixtureAccessToken } from "./remote-ui-rpc.ts";
import { it, expect } from "vite-plus/test";
const source = NodeFS.readFileSync(
  new URL("../qualify-delivery-retry.ts", import.meta.url),
  "utf8",
);
const code = (text: string, context: NodeVM.Context) =>
  NodeVM.runInNewContext(NodeModule.stripTypeScriptTypes(text), context);
it.each(["owned", "missing", "credential", "physical", "caller"])(
  "actual browser branch joins fixed public API and physical worktree before an assertion: %s",
  async (mode) => {
    const begin = source.indexOf(
        '      } else if (config.selection === "release-visual-browser-followups") {',
      ),
      end = source.indexOf(
        '      } else if (config.selection === "release-visual-settings-followups") {',
        begin,
      );
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const events: string[] = [],
      assertions: object[] = [],
      fault = new Error("inert exact caller failure"),
      workspace = {
        threadId: "inert-thread",
        path: "/inert/worktree",
        branch: "inert-branch",
        commonDirectory: "/inert/common",
      };
    let safe = true;
    const run = code(
      "async function run(){" + source.slice(source.indexOf("\n", begin) + 1, end) + "}\nrun",
      {
        browserFollowup: mode === "missing" ? null : {},
        type: async (value: string) => events.push(value),
        owner: {
          json: async (_binary: string, args: string[]) => {
            expect(args).toEqual([
              "pairing",
              "issue",
              "--base-dir",
              "/inert/state",
              "--json",
              "--dev-url",
              "http://127.0.0.1:4885",
            ]);
            return { credential: mode === "credential" ? "bad" : "inert-credential" };
          },
        },
        config: { binary: "/inert/binary", fixture: "/inert/fixture", evidence: "/inert/evidence" },
        context: {
          stateRoot: "/inert/state",
          projectPath: "/inert/project",
          fixtureUserHomePath: "/inert/home",
        },
        childEnv: { CI: "true" },
        primaryProfile: { directory: "dev", args: ["--dev-url", "http://127.0.0.1:4885"] },
        fixtureAccessToken: async (origin: string) => {
          expect(origin).toBe("http://127.0.0.1:4887");
          return "inert-access";
        },
        browser: {},
        theme: "light",
        workspace,
        readOwnedGitProjectDescriptor: async () => ({}),
        readOwnedGitProjectSnapshot: async () => ({}),
        visualInput: {},
        readOwnedDeliveryWorktree: () =>
          mode === "physical"
            ? { ...workspace, path: "/foreign" }
            : {
                path: workspace.path,
                branch: workspace.branch,
                commonDirectory: workspace.commonDirectory,
              },
        check: (value: boolean) => {
          if (!value) throw new Error("inert physical refusal");
        },
        NodePath,
        runRoot: "/inert/run",
        runOwnedGitProjectCommand: () => ({ stdout: "inert original Git patch" }),
        capturedVisuals: new Set(),
        captures: [],
        assertions,
        write: () => {},
        step: () => {},
        runBrowserFollowupCaller: async (input: {
          verifyPhysical: () => Promise<void>;
          patch: () => string;
          observeUnsafeCleanup: () => void;
          readSnapshot: () => Promise<unknown>;
          accessToken: string;
        }) => {
          events.push("caller");
          await input.verifyPhysical();
          expect(input.patch()).toBe("inert original Git patch");
          expect(input.accessToken).toBe("inert-access");
          if (mode === "caller") {
            input.observeUnsafeCleanup();
            throw fault;
          }
        },
        get browserFollowupFixtureSafeToDelete() {
          return safe;
        },
        set browserFollowupFixtureSafeToDelete(value: boolean) {
          safe = value;
        },
      },
    ) as () => Promise<void>;
    if (mode === "owned") {
      await run();
      expect(assertions).toEqual([
        {
          theme: "light",
          rows: 6,
          baseOriginals: 6,
          supplements: 1,
          producerSourceJoined: true,
          bootstrapReplayJoined: true,
          completeGroup: false,
        },
      ]);
    } else {
      await expect(run()).rejects.toSatisfy(
        (error: unknown) => mode !== "caller" || error === fault,
      );
      expect(assertions).toHaveLength(0);
    }
    expect(safe).toBe(mode !== "caller");
  },
);
it.each([
  [14, 2, true],
  [12, 2, false],
  [15, 2, false],
  [14, 1, false],
  [14, 3, false],
] as const)(
  "actual final controller requires fourteen originals and both themes: %s/%s",
  (images, themes, accepted) => {
    const start = source.indexOf("    check(\n      captures.length ==="),
      end = source.indexOf("    success = true;", start);
    let admitted: boolean | undefined;
    code(source.slice(start, end), {
      captures: Array.from({ length: images }, () => ({})),
      assertions: Array.from({ length: themes }, () => ({})),
      deliveryThemes: ["light", "dark"],
      config: { selection: "release-visual-browser-followups" },
      check: (value: boolean) => (admitted = value),
      write: () => {},
    });
    expect(admitted).toBe(accepted);
  },
);
it.each(["safe", "unsafe", "failure"])(
  "actual final owner joins browser resources and refuses unsafe publication: %s",
  async (mode) => {
    const start = source.lastIndexOf("  } finally {"),
      end = source.indexOf("  return success ? 0 : 1;", start),
      events: string[] = [],
      writes: Record<string, unknown>[] = [];
    let safe = mode !== "unsafe";
    const run = code(
      "async function run(){" + source.slice(start + "  } finally {".length, end) + "\nrun",
      {
        owner: {
          processes: [],
          failures: [],
          childrenClosed: () => true,
          close: async (resources: { proxies: Array<() => Promise<void>> }) => {
            events.push("owner");
            for (const close of resources.proxies ?? [])
              try {
                await close();
              } catch {}
          },
        },
        browser: undefined,
        success: true,
        phase: "theme-cleanup",
        theme: "light",
        config: { source: "a".repeat(40), selection: "release-visual-browser-followups" },
        captures: [],
        assertions: [],
        networkProofs: [],
        settingsFollowupUsageFixtures: [],
        pullRequestsHostingOwners: [],
        importEvidenceOwner: null,
        browserFollowupResources: [
          {
            close: async () => {
              events.push("resources");
              if (mode === "failure") {
                safe = false;
                throw new Error("inert joined cleanup failure");
              }
            },
          },
        ],
        write: (_name: string, value: Record<string, unknown>) => writes.push(value),
        get browserFollowupFixtureSafeToDelete() {
          return safe;
        },
        set browserFollowupFixtureSafeToDelete(value: boolean) {
          safe = value;
        },
      },
    ) as () => Promise<void>;
    await run();
    expect(events).toEqual(["owner", "resources"]);
    expect(writes.at(-1)?.browserFollowupFixtureSafeToDelete).toBe(mode === "safe");
    expect(writes.at(-1)?.success).toBe(mode === "safe");
  },
);

it.each(["browser", "ordinary"])(
  "the actual common startup composes source-bound assets, raw-port admission, readiness and pairing before scene dispatch: %s",
  async (mode) => {
    const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-common-inert-")),
      ),
      repository = NodePath.resolve(import.meta.dirname, "../../../../"),
      sdk = NodePath.join(repository, "apps/web/src/hostedPairing.ts"),
      sdkSourceSha256 = NodeCrypto.createHash("sha256")
        .update(NodeFS.readFileSync(sdk))
        .digest("hex"),
      origin = "http://127.0.0.1:4885",
      events: string[] = [],
      requests: string[] = [],
      resources: Array<{ close: () => Promise<void> }> = [],
      backend = NodeHttp.createServer((request, response) => {
        requests.push(request.url ?? "");
        if (request.url === "/" || request.url === "/pair") {
          response.end("<html>inert original primary</html>");
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            request.url === "/oauth/token"
              ? { access_token: "inert-access" }
              : {
                  environmentId: "local",
                  label: "Local",
                  platform: "linux",
                  serverVersion: "0.8.0",
                  storageInstanceId: "inert-store",
                  bootId: "inert-boot",
                  capabilities: {},
                },
          ),
        );
      });
    let serverStarted = false;
    NodeFS.chmodSync(root, 0o700);
    const assets = NodePath.join(root, "web"),
      hosted = NodePath.join(root, "hosted-web"),
      binary = NodePath.join(root, "binary");
    NodeFS.writeFileSync(binary, "inert executable", { mode: 0o500 });
    for (const [mode, path] of [
      ["primary", assets],
      ["hosted", hosted],
    ] as const) {
      NodeFS.mkdirSync(path, { mode: 0o700 });
      NodeFS.writeFileSync(
        NodePath.join(path, "index.html"),
        "<html>inert original primary</html>",
        { mode: 0o600 },
      );
      NodeFS.writeFileSync(
        NodePath.join(path, "qualified-browser-build.json"),
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
    }
    NodeFS.writeFileSync(
      NodePath.join(hosted, "qualified-hosted-mode.js"),
      "export const inert=true;",
      { mode: 0o600 },
    );
    const config = {
        selection:
          mode === "browser" ? "release-visual-browser-followups" : "release-visual-settings",
        binary,
        assets,
        fixture: root,
        evidence: root,
        source: "a".repeat(40),
        chrome: "inert-chrome",
        driver: "inert-driver",
      },
      context = { stateRoot: NodePath.join(root, "state") },
      childEnv = { CI: "true" },
      navigation: string[] = [],
      browser = {
        url: async (value: string) => {
          navigation.push(value);
          expect(await (await fetch(value)).text()).toBe("<html>inert original primary</html>");
        },
        $: () => ({
          waitForDisplayed: async () => {},
          setValue: async (value: string) => expect(value).toBe("inert-credential"),
        }),
      };
    const settingsBytes = Buffer.from('{"providers":{"inert":{"enabled":false}}}');
    NodeFS.mkdirSync(NodePath.join(context.stateRoot, "userdata"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(context.stateRoot, "userdata", "settings.json"),
      settingsBytes,
    );
    const start = source.indexOf(
        "      let browserFollowup: Awaited<ReturnType<typeof prepareBrowserFollowupCaller>>",
      ),
      end = source.indexOf("      let settingsFollowupUsage:", start),
      profileStart = source.indexOf("      const primaryProfile ="),
      profileEnd = source.indexOf("      const configured =", profileStart),
      probeStart = source.indexOf("      const primaryPort ="),
      prefixEnd = source.indexOf(
        '      if (config.selection === "release-visual-git-project") {',
        probeStart,
      );
    expect(start).toBeGreaterThan(0);
    expect(probeStart).toBeGreaterThan(end);
    expect(prefixEnd).toBeGreaterThan(probeStart);
    const run = code(
      "async function startup(){" +
        source.slice(start, end) +
        source.slice(profileStart, profileEnd) +
        source.slice(probeStart, prefixEnd) +
        "\nreturn browserFollowup;}\nstartup",
      {
        NodeFS,
        NodePath,
        NodeNet,
        prepareBrowserFollowupCaller,
        childEnv,
        config,
        context,
        runRoot: root,
        root: repository,
        origin,
        serverEnvironment: childEnv,
        browserFollowupResources: resources,
        importEvidenceOwner: null,
        process: { env: {} },
        deliveryConfiguration: () => config,
        check: (value: boolean) => expect(value).toBe(true),
        step: (value: string) => events.push(value),
        owner: {
          spawn: (_binary: string, args: string[]) => {
            expect(args[args.indexOf("--port") + 1]).toBe(mode === "browser" ? "4897" : "4885");
            expect(args[args.indexOf("--static-dir") + 1]).toBe(assets);
            if (mode === "browser")
              expect(args.slice(args.indexOf("--dev-url"), args.indexOf("--dev-url") + 2)).toEqual([
                "--dev-url",
                origin,
              ]);
            else expect(args).not.toContain("--dev-url");
            events.push("server-start");
            serverStarted = true;
            backend.listen(mode === "browser" ? 4897 : 4885, "127.0.0.1");
            return {};
          },
          until: async (check: () => Promise<boolean>) => {
            for (let attempt = 0; attempt < 100; attempt++) {
              if (await check()) return;
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
            throw new Error("Inert readiness deadline");
          },
          json: async (_binary: string, args: string[]) => {
            expect(args).toEqual([
              "pairing",
              "issue",
              "--base-dir",
              context.stateRoot,
              "--json",
              ...(mode === "browser" ? ["--dev-url", origin] : []),
            ]);
            return { credential: "inert-credential" };
          },
        },
        fetch,
        AbortSignal,
        openOwnedBrowser: async (
          _owner: unknown,
          _chrome: unknown,
          _driver: unknown,
          publicOrigin: string,
        ) => {
          expect(publicOrigin).toBe(origin);
          expect(await (await fetch(publicOrigin)).text()).toBe(
            "<html>inert original primary</html>",
          );
          return { browser };
        },
        browser: undefined,
        browserDriverReadiness: null,
        browserReadinessStage: null,
        browserSessionObservation: null,
        projectOwnedDriverReadiness: (value: unknown) => value,
        projectOwnedBrowserSessionObservation: (value: unknown) => value,
        network: {},
        networkProofs: [],
        verifyOwnedBrowserOnline: async () => ({ inert: true }),
        click: async (selector: string) => expect(selector).toBe("button=Continue"),
        setTheme: async () => {},
        get browserFollowupFixtureSafeToDelete() {
          return true;
        },
        set browserFollowupFixtureSafeToDelete(_value: boolean) {},
      },
    ) as () => Promise<Awaited<ReturnType<typeof prepareBrowserFollowupCaller>>>;
    try {
      const prepared = await run();
      const directory = mode === "browser" ? "dev" : "userdata";
      expect(
        NodeFS.readFileSync(NodePath.join(context.stateRoot, directory, "settings.json")),
      ).toEqual(settingsBytes);
      expect(
        NodeFS.existsSync(
          NodePath.join(context.stateRoot, mode === "browser" ? "userdata" : "dev"),
        ),
      ).toBe(false);
      if (mode === "browser") {
        await prepared.verify();
        expect(resources).toHaveLength(1);
      } else {
        expect(prepared).toBe(null);
        expect(resources).toHaveLength(0);
      }
      expect(navigation).toEqual([origin + "/pair"]);
      expect(await fixtureAccessToken(origin, "inert-credential")).toBe("inert-access");
      if (mode === "browser")
        expect(await fixtureAccessToken("http://127.0.0.1:4887", "inert-credential")).toBe(
          "inert-access",
        );
      expect(
        (await (await fetch(origin + "/.well-known/bibcode/environment")).json()).serverVersion,
      ).toBe("0.8.0");
      expect(requests).toContain("/.well-known/bibcode/environment");
      expect(requests.filter((value) => value === "/oauth/token")).toHaveLength(
        mode === "browser" ? 2 : 1,
      );
      if (mode === "browser")
        expect(events.indexOf("visual-browser-followups-resource-prepare")).toBeLessThan(
          events.indexOf("server-start"),
        );
      else expect(events).not.toContain("visual-browser-followups-resource-prepare");
    } finally {
      for (const resource of resources.toReversed()) await resource.close();
      if (serverStarted)
        await new Promise<void>((resolve, reject) =>
          backend.close((error) => (error ? reject(error) : resolve())),
        );
      NodeFS.rmSync(root, { recursive: true });
    }
  },
);

it.each(
  (["chat-staged-attachment", "terminal-shared-size"] as const).flatMap((row) =>
    ["success", "wait-error", "wait-undefined", "measurement", "set-size"].map(
      (mode) => [row, mode] as const,
    ),
  ),
)("actual viewport callback labels only its predicate wait: %s", async (row, mode) => {
  const first = "visual-browser-followups-" + row;
  const phases = [first];
  const original =
    mode === "wait-undefined" ? undefined : new Error("Inert exact viewport failure.");
  const start = source.indexOf(
    "viewport: async (target, width, height",
    source.indexOf("await runBrowserFollowupCaller"),
  );
  const end = source.indexOf("\n          evidence:", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const text = source
    .slice(start, end)
    .trim()
    .replace(/^viewport: /, "")
    .replace(/,$/, "");
  const reads: string[] = [];
  let measured = false;
  const viewport = code("(" + text + ")", {
    bounded: (value: unknown) => value,
    readVisualViewport: () => {},
    correctDesktopUiOuterSize: (outer: object) => outer,
    owner: {
      until: async (predicate: () => Promise<boolean>) => {
        reads.push("wait");
        expect(await predicate()).toBe(true);
        if (mode.startsWith("wait-")) throw original;
      },
    },
  }) as (
    target: object,
    width: number,
    height: number,
    wait?: {
      row: "chat-staged-attachment" | "terminal-shared-size";
      step: (phase: string) => void;
    },
  ) => Promise<void>;
  const target = {
    execute: async () => {
      reads.push(measured ? "readback" : "measure");
      measured = true;
      if (mode === "measurement") throw original;
      return { width: 1280, height: 960, devicePixelRatio: 1 };
    },
    getWindowSize: async () => ({ width: 1280, height: 960 }),
    setWindowSize: async () => {
      reads.push("set-size");
      if (mode === "set-size") throw original;
    },
  };
  if (mode === "success") {
    await viewport(target, 1280, 960, { row, step: (phase) => phases.push(phase) });
    expect(phases).toEqual([first, first + "-viewport-wait", first]);
  } else {
    let failed = false,
      caught: unknown;
    try {
      await viewport(target, 1280, 960, { row, step: (phase) => phases.push(phase) });
    } catch (error) {
      failed = true;
      caught = error;
    }
    expect(failed).toBe(true);
    expect(caught).toBe(original);
    expect(phases.at(-1)).toBe(mode.startsWith("wait-") ? first + "-viewport-wait" : first);
  }
  if (mode === "success" || mode.startsWith("wait-"))
    expect(reads).toEqual(["measure", "set-size", "wait", "readback"]);
});
