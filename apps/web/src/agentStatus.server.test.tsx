// @vitest-environment happy-dom
// The left panel's agent status on the production server wire path (#187): a real `bibcode
// serve` publishes it, this client reads it over the authenticated WebSocket RPC and decodes it
// with the shared contracts, and the real row and card components render it. Covers a chat
// agent's question and a terminal agent BiBCode cannot observe, through a reconnect and a
// server restart. Opt-in, because it needs a freshly built server binary:
//
//   cargo build -p bibcode-server
//   BIBCODE_AGENT_STATUS_SERVER_BIN=$PWD/target/debug/bibcode \
//     vp test run --project unit src/agentStatus.server.test.tsx      (from apps/web)
//
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off - The harness probes a real loopback server process.
// @effect-diagnostics globalTimers:off - The process and WebSocket harness owns bounded watchdogs.
// @effect-diagnostics globalDate:off - Commands are stamped outside an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentId,
  OrchestrationShellSnapshot,
  TerminalSummary,
} from "@bibcode/contracts";
import * as Schema from "effect/Schema";
import { act, type ComponentPropsWithoutRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./sidebarWorkspaceMetaStore", () => ({
  selectIsUnread: () => false,
  useSidebarWorkspaceMetaStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ unreadThreadKeys: [] }),
}));
vi.mock("./components/ui/sidebar", () => ({
  SidebarMenuItem: ({ children, ...props }: ComponentPropsWithoutRef<"li">) => (
    <li {...props}>{children}</li>
  ),
  SidebarMenuButton: ({
    isActive: _isActive,
    size: _size,
    children,
    ...props
  }: ComponentPropsWithoutRef<"button"> & { isActive?: boolean; size?: string }) => (
    <button {...props}>{children}</button>
  ),
  SidebarMenuAction: ({ children, ...props }: ComponentPropsWithoutRef<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("./components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipPopup: () => null,
  TooltipTrigger: ({ render }: { render?: React.ReactNode }) => <>{render}</>,
}));

import { AgentsRow } from "./components/agents/AgentsRow";
import {
  resolveWorkspaceCardStatus,
  type WorkspaceCardStatus,
  WORKSPACE_CARD_STATUS,
} from "./components/Sidebar.logic";
import { buildAgentRows, type AgentRow } from "./components/sidebar/agentsSection.logic";
import { WorkspaceCardStatusGlyph } from "./components/sidebar/WorkspaceCard";
import { agentEvidenceAt } from "./hooks/useAgentFreshness";

const serverBinary = process.env["BIBCODE_AGENT_STATUS_SERVER_BIN"];
const ENVIRONMENT = EnvironmentId.make("environment-wire");
const PROJECT_ID = "agent-status-project";
const THREAD_ID = "agent-status-thread";
const MODEL = { instanceId: "codex", model: "gpt-5.4" } as const;

/** A Codex app server that asks one question when told to, then waits for the answer. */
const FAKE_CODEX = String.raw`#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 99.0.0\n");
  process.exit(0);
}
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: codex [--remote unix://PATH]\n");
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let turn = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const id = message.id;
  switch (message.method) {
    case "initialize":
      send({ id, result: { userAgent: "agent-status-fixture", codexHome: "/tmp/agent-status-codex",
        platformFamily: "unix", platformOs: process.platform } });
      break;
    case "account/read":
      send({ id, result: { account: { type: "chatgpt", email: "fixture@example.test", planType: "fixture" },
        requiresOpenaiAuth: false } });
      break;
    case "model/list":
      send({ id, result: { data: message.params?.cursor ? [] : [{ model: "gpt-5.4", displayName: "gpt-5.4",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium" }],
        nextCursor: null } });
      break;
    case "thread/start":
    case "thread/resume":
      send({ id, result: { cwd: message.params?.cwd ?? process.cwd(), model: "gpt-5.4",
        thread: { id: "agent-status-provider-thread" } } });
      break;
    case "turn/start": {
      turn += 1;
      const turnId = "agent-status-turn-" + turn;
      send({ id, result: { turn: { id: turnId } } });
      send({ method: "turn/started", params: { threadId: "agent-status-provider-thread", turn: { id: turnId } } });
      send({ id: "question-" + turn, method: "item/tool/requestUserInput", params: {
        threadId: "agent-status-provider-thread", turnId, itemId: "question-item-" + turn,
        questions: [{ id: "choice", header: "Pick", question: "Which way?",
          options: [{ label: "Left", description: "Go left" }, { label: "Right", description: "Go right" }] }],
      } });
      break;
    }
    case "turn/interrupt":
      send({ id, result: null });
      break;
    default:
      if (id !== undefined && message.method !== undefined) send({ id, result: {} });
  }
});
`;

interface RunningServer {
  readonly process: NodeChildProcess.ChildProcess;
  readonly httpBaseUrl: string;
  readonly token: string;
  /** The bootstrap token is exchanged once; later connections reuse the access token. */
  accessToken?: string;
}

let baseDir = "";
let fixtureDir = "";
let server: RunningServer | null = null;

async function startServer(): Promise<RunningServer> {
  // The test runner's own BIBCODE_* variables (some set to "undefined") must not configure it.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("BIBCODE_"),
    ),
  );
  const child = NodeChildProcess.spawn(
    serverBinary!,
    ["serve", "--host", "127.0.0.1", "--port", "0", "--base-dir", baseDir, "--no-browser"],
    { env },
  );
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const startup = await new Promise<{ httpBaseUrl: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not report readiness: ${stderr.join("")}`)),
      60_000,
    );
    NodeReadline.createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const parsed = JSON.parse(line) as { httpBaseUrl?: string; token?: string };
        if (parsed.httpBaseUrl && parsed.token) {
          clearTimeout(timer);
          resolve({ httpBaseUrl: parsed.httpBaseUrl, token: parsed.token });
        }
      } catch {
        // Ignore non-JSON log lines.
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${String(code)}): ${stderr.join("")}`));
    });
  });
  return { process: child, ...startup };
}

async function stopServer(running: RunningServer): Promise<void> {
  if (running.process.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => running.process.once("exit", () => resolve()));
  running.process.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
  if (running.process.exitCode === null) running.process.kill("SIGKILL");
}

/** One authenticated RPC WebSocket to the server, speaking its request/stream framing. */
class RpcClient {
  private sequence = 0;
  private readonly handlers = new Map<string, (message: Record<string, unknown>) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      const handler =
        typeof message["requestId"] === "string"
          ? this.handlers.get(message["requestId"])
          : undefined;
      handler?.(message);
    });
  }

  static async connect(running: RunningServer): Promise<RpcClient> {
    if (running.accessToken === undefined) {
      const tokenResponse = await fetch(`${running.httpBaseUrl}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: running.token,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await tokenResponse.json()) as { access_token?: string };
      if (body.access_token === undefined) {
        throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
      }
      running.accessToken = body.access_token;
    }
    const ticketResponse = await fetch(`${running.httpBaseUrl}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${running.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const { ticket } = (await ticketResponse.json()) as { ticket?: string };
    if (ticket === undefined) throw new Error("the server issued no WebSocket ticket");
    const url = new URL("/ws", running.httpBaseUrl.replace(/^http/, "ws"));
    url.searchParams.set("wsTicket", ticket!);
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("RPC socket failed")), {
        once: true,
      });
    });
    return new RpcClient(socket);
  }

  request(tag: string, payload: unknown): Promise<unknown> {
    const requestId = String(this.sequence++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${tag} timed out`)), 30_000);
      this.handlers.set(requestId, (message) => {
        if (message["_tag"] !== "Exit") return;
        clearTimeout(timer);
        this.handlers.delete(requestId);
        const exit = message["exit"] as { _tag?: string; value?: unknown; cause?: unknown };
        if (exit._tag === "Success") resolve(exit.value);
        else reject(new Error(`${tag} failed: ${JSON.stringify(exit.cause)}`));
      });
      this.socket.send(
        JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }),
      );
    });
  }

  /** Reads a stream until `accept` takes one of its items. */
  waitForStreamItem<T>(
    tag: string,
    payload: unknown,
    accept: (item: unknown) => T | undefined,
  ): Promise<T> {
    const requestId = String(this.sequence++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(requestId);
        reject(new Error(`${tag} never reported the expected state`));
      }, 45_000);
      this.handlers.set(requestId, (message) => {
        if (message["_tag"] === "Exit") {
          clearTimeout(timer);
          this.handlers.delete(requestId);
          reject(new Error(`${tag} ended: ${JSON.stringify(message["exit"])}`));
          return;
        }
        if (message["_tag"] !== "Chunk") return;
        for (const item of (message["values"] as unknown[]) ?? []) {
          let accepted: T | undefined;
          try {
            accepted = accept(item);
          } catch (error) {
            clearTimeout(timer);
            this.handlers.delete(requestId);
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (accepted !== undefined) {
            clearTimeout(timer);
            this.handlers.delete(requestId);
            this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId }));
            resolve(accepted);
            return;
          }
        }
        this.socket.send(JSON.stringify({ _tag: "Ack", requestId }));
      });
      this.socket.send(
        JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }),
      );
    });
  }

  close(): void {
    this.socket.close();
  }
}

// The RPC client decodes stream values through the JSON codec, as here.
const decodeShellSnapshot = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationShellSnapshot),
);
const decodeTerminalSummary = Schema.decodeUnknownSync(Schema.toCodecJson(TerminalSummary));

/** The decoded shell of our thread from the next snapshot that satisfies `ready`. */
function shellWhere(
  client: RpcClient,
  ready: (thread: EnvironmentThreadShell) => boolean,
): Promise<EnvironmentThreadShell> {
  return client.waitForStreamItem("orchestration.subscribeShell", {}, (item) => {
    const envelope = item as { kind?: string; snapshot?: unknown };
    if (envelope.kind !== "snapshot") return undefined;
    const snapshot = decodeShellSnapshot(envelope.snapshot);
    const thread = snapshot.threads.find((candidate) => candidate.id === THREAD_ID);
    if (thread === undefined) return undefined;
    const shell = { ...thread, environmentId: ENVIRONMENT } as EnvironmentThreadShell;
    return ready(shell) ? shell : undefined;
  });
}

/** Our thread's AI Terminals from the next metadata item that satisfies `ready`. */
function terminalsWhere(
  client: RpcClient,
  ready: (terminals: ReadonlyArray<TerminalSummary>) => boolean,
): Promise<ReadonlyArray<TerminalSummary>> {
  const known = new Map<string, TerminalSummary>();
  return client.waitForStreamItem("subscribeTerminalMetadata", {}, (item) => {
    const event = item as { type?: string; terminals?: unknown[]; terminal?: unknown };
    if (event.type === "snapshot") {
      known.clear();
      for (const terminal of event.terminals ?? []) {
        const decoded = decodeTerminalSummary(terminal);
        known.set(decoded.terminalId, decoded);
      }
    } else if (event.type === "upsert") {
      const decoded = decodeTerminalSummary(event.terminal);
      known.set(decoded.terminalId, decoded);
    }
    const ours = [...known.values()].filter((terminal) => terminal.threadId === THREAD_ID);
    return ready(ours) ? ours : undefined;
  });
}

function agentRows(
  shell: EnvironmentThreadShell,
  terminals: ReadonlyArray<TerminalSummary>,
): ReadonlyArray<AgentRow> {
  return buildAgentRows({
    shells: [shell],
    projectTitleById: new Map([[shell.projectId, "Agent status project"]]),
    environmentLabelById: new Map([[ENVIRONMENT, "Wire"]]),
    availabilityByEnvironmentId: new Map([[ENVIRONMENT, "live"]]),
    terminals: [{ environmentId: ENVIRONMENT, rows: terminals }],
    freshness: { now: Date.now(), evidenceAt: agentEvidenceAt },
  });
}

function cardStatus(
  shell: EnvironmentThreadShell,
  terminals: ReadonlyArray<TerminalSummary>,
): WorkspaceCardStatus {
  return resolveWorkspaceCardStatus(shell, null, {
    now: Date.now(),
    environmentLive: true,
    evidenceAt: agentEvidenceAt(THREAD_ID, shell.lastActivityAt, shell.lastActivityAgeMs, true),
    terminals: terminals.map((terminal) => ({
      terminal,
      evidenceAt: agentEvidenceAt(
        terminal.terminalId,
        terminal.agentStatus?.observedAt,
        terminal.agentStatus?.ageMs,
        true,
      ),
    })),
  });
}

let root: Root | null = null;

/** A row's accessible name or description: the text of the lines it references. */
function referencedText(element: Element, attribute: "aria-labelledby" | "aria-describedby") {
  return (element.getAttribute(attribute) ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(", ");
}

/** Mounts the real rows and card glyph and returns what they render. */
async function render(
  rows: ReadonlyArray<AgentRow>,
  status: WorkspaceCardStatus,
): Promise<{ readonly rows: ReadonlyArray<string>; readonly card: string | null }> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root?.unmount();
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <>
        <ul>
          {rows.map((row) => (
            <AgentsRow key={row.key} row={row} selected={false} onSelect={() => {}} />
          ))}
        </ul>
        <WorkspaceCardStatusGlyph status={status} />
      </>,
    );
  });
  return {
    rows: [...container.querySelectorAll("ul button[aria-labelledby]")].map(
      (button) =>
        `${referencedText(button, "aria-labelledby")}: ${referencedText(button, "aria-describedby")}`,
    ),
    card: container.querySelector("[data-status]")?.getAttribute("aria-label") ?? null,
  };
}

describe.skipIf(serverBinary === undefined)("agent status over the production wire (#187)", () => {
  beforeAll(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-agent-status-"));
    fixtureDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-agent-status-fx-"));
    const codex = NodePath.join(fixtureDir, "codex");
    NodeFS.writeFileSync(codex, FAKE_CODEX);
    NodeFS.chmodSync(codex, 0o755);
    const userData = NodePath.join(baseDir, "userdata");
    NodeFS.mkdirSync(userData, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(userData, "settings.json"),
      JSON.stringify({ providers: { codex: { enabled: true, binaryPath: codex } } }),
    );
    server = await startServer();
  }, 90_000);

  afterAll(async () => {
    root?.unmount();
    if (server !== null) await stopServer(server);
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
    NodeFS.rmSync(fixtureDir, { recursive: true, force: true });
  }, 30_000);

  it("shows a question and an unobserved terminal, keeps them across a reconnect, and settles them after a restart", async () => {
    const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-agent-ws-"));
    const now = Date.now();
    const at = (offset: number) => new Date(now + offset).toISOString();
    let client = await RpcClient.connect(server!);
    await client.request("orchestration.dispatchCommand", {
      type: "project.create",
      commandId: "agent-status-project-create",
      projectId: PROJECT_ID,
      title: "Agent status project",
      workspaceRoot: workspace,
      defaultModelSelection: MODEL,
      createdAt: at(-3_000),
    });
    await client.request("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: "agent-status-thread-create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Agent status thread",
      modelSelection: MODEL,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdAt: at(-2_000),
    });

    // An AI Terminal of a provider BiBCode has no observer for: running, status unavailable.
    await client.request("terminal.open", {
      threadId: THREAD_ID,
      terminalId: "agent-status-cursor",
      cwd: workspace,
      centerPanel: true,
      command: {
        executable: "/bin/sleep",
        args: ["600"],
        label: "Cursor Terminal",
        activity: { driverKind: "cursor", providerInstanceId: "cursor" },
      },
    });
    const unavailable = await terminalsWhere(client, (terminals) =>
      terminals.some((terminal) => terminal.agentStatus?.state === "unavailable"),
    );

    // The chat agent asks a question.
    await client.request("orchestration.dispatchCommand", {
      type: "thread.turn.start",
      commandId: "agent-status-turn-start",
      threadId: THREAD_ID,
      message: { messageId: "agent-status-message", role: "user", text: "ask", attachments: [] },
      modelSelection: MODEL,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at(0),
    });
    const asking = await shellWhere(client, (thread) => thread.hasPendingUserInput);
    expect(asking.session?.status).toBe("running");
    expect(asking.lastActivityAt).toBeDefined();

    const live = await render(agentRows(asking, unavailable), cardStatus(asking, unavailable));
    expect(live.rows).toEqual([
      "main, Agent status thread: Awaiting Input, Codex, Wire, Agent status project",
      "main, Agent status thread, Cursor Terminal: Status unavailable, Cursor, Wire, Agent status project",
    ]);
    expect(live.card).toBe(WORKSPACE_CARD_STATUS.input.label);

    // Reconnect: a fresh connection hydrates the same state from its first snapshots.
    client.close();
    client = await RpcClient.connect(server!);
    const rehydrated = await shellWhere(client, () => true);
    const rehydratedTerminals = await terminalsWhere(client, (terminals) => terminals.length > 0);
    expect(rehydrated.hasPendingUserInput).toBe(true);
    const reconnected = await render(
      agentRows(rehydrated, rehydratedTerminals),
      cardStatus(rehydrated, rehydratedTerminals),
    );
    expect(reconnected).toEqual(live);
    client.close();

    // Restart: the abandoned turn's question expires, and the terminal is gone with its PTY.
    await stopServer(server!);
    server = await startServer();
    client = await RpcClient.connect(server);
    const restarted = await shellWhere(
      client,
      (thread) => !thread.hasPendingUserInput && thread.session?.status !== "running",
    );
    const afterRestart = await render(agentRows(restarted, []), cardStatus(restarted, []));
    expect(afterRestart.rows).toEqual([
      "main, Agent status thread: Failed, Codex, Wire, Agent status project",
    ]);
    expect(afterRestart.card).toBe(WORKSPACE_CARD_STATUS.failed.label);
    client.close();
    NodeFS.rmSync(workspace, { recursive: true, force: true });
  }, 180_000);
});
