import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentTarget,
  DesktopSshServerProbe,
  DesktopWslDiscovery,
  DesktopWslServerProbe,
  RemoteSetupConsent,
  RemoteSetupConsentDecision,
  RemoteSetupProgress,
} from "@bibcode/contracts";
import { ArrowLeftRightIcon, MonitorCogIcon, NetworkIcon, RefreshCwIcon } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { parseDirectEnvironmentEndpoint } from "./environmentWorkspaceModel";

export interface SshEnvironmentTargetInput {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}

export interface DirectEnvironmentInput {
  readonly endpoint: string;
  readonly pairingCode: string;
}

export type PreparedEnvironmentSetup =
  | { readonly transport: "wsl"; readonly probe: DesktopWslServerProbe }
  | { readonly transport: "ssh"; readonly probe: DesktopSshServerProbe };

export interface AddEnvironmentWorkspaceProps {
  readonly wslDiscovery: DesktopWslDiscovery | null;
  readonly addedWslDistroNames: readonly string[];
  readonly sshHosts?: readonly DesktopDiscoveredSshHost[];
  readonly onRefreshWsl: () => void;
  readonly onRefreshSsh?: () => void;
  readonly onPrepareWsl: (
    distro: string,
    discoveryGeneration: number,
  ) => Promise<DesktopWslServerProbe>;
  readonly onPrepareSsh: (target: DesktopSshEnvironmentTarget) => Promise<DesktopSshServerProbe>;
  readonly onInstallSetup: (
    setup: PreparedEnvironmentSetup,
    decision: RemoteSetupConsentDecision,
  ) => Promise<void>;
  readonly onConnectSsh: (target: DesktopSshEnvironmentTarget) => Promise<void>;
  readonly onConnectDirect: (input: DirectEnvironmentInput) => Promise<void>;
  readonly setupProgress?: RemoteSetupProgress | null;
}

const SSH_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:]+\])$/iu;
const SSH_USERNAME_PATTERN = /^[a-z0-9._-]+$/iu;
const EMPTY_SSH_HOSTS: readonly DesktopDiscoveredSshHost[] = [];

export function parseSshEnvironmentTarget({
  host,
  username,
  port,
}: SshEnvironmentTargetInput): DesktopSshEnvironmentTarget {
  let address = host.trim();
  let resolvedUsername = username.trim();
  let resolvedPort = port.trim();

  const atIndex = address.lastIndexOf("@");
  if (atIndex >= 0) {
    if (resolvedUsername !== "") {
      throw new Error("Enter the SSH username either with the host or in the username field.");
    }
    resolvedUsername = address.slice(0, atIndex);
    address = address.slice(atIndex + 1);
  }

  if (!address.startsWith("[")) {
    const colonIndex = address.lastIndexOf(":");
    if (colonIndex >= 0) {
      if (resolvedPort !== "") {
        throw new Error("Enter the SSH port either with the host or in the port field.");
      }
      resolvedPort = address.slice(colonIndex + 1);
      address = address.slice(0, colonIndex);
    }
  } else {
    const bracketEnd = address.indexOf("]");
    if (bracketEnd >= 0 && address.length > bracketEnd + 1) {
      if (address[bracketEnd + 1] !== ":" || resolvedPort !== "") {
        throw new Error("Enter a valid SSH host and port.");
      }
      resolvedPort = address.slice(bracketEnd + 2);
      address = address.slice(0, bracketEnd + 1);
    }
  }

  if (!SSH_HOST_PATTERN.test(address) || address.includes("..")) {
    throw new Error("Enter a valid SSH host or configured alias.");
  }
  if (resolvedUsername !== "" && !SSH_USERNAME_PATTERN.test(resolvedUsername)) {
    throw new Error("Enter a valid SSH username.");
  }

  let parsedPort: number | null = null;
  if (resolvedPort !== "") {
    if (!/^\d+$/u.test(resolvedPort)) {
      throw new Error("Enter a valid SSH port.");
    }
    parsedPort = Number(resolvedPort);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
      throw new Error("Enter a valid SSH port between 1 and 65535.");
    }
  }

  const hostname = address.startsWith("[") ? address.slice(1, -1) : address;
  return {
    alias: hostname,
    hostname,
    username: resolvedUsername === "" ? null : resolvedUsername,
    port: parsedPort,
  };
}

function SetupConsentReview({ consent }: { readonly consent: RemoteSetupConsent }) {
  return (
    <div className="space-y-3 rounded-xl border border-warning/35 bg-warning/8 p-4">
      <div>
        <p className="text-sm font-semibold">Review remote server installation</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          BiBCode will install server {consent.targetVersion} on {consent.targetLabel}. Nothing is
          installed until you confirm below.
        </p>
      </div>
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Artifact source</dt>
          <dd className="break-all font-mono">{consent.artifactSource}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Install destination</dt>
          <dd className="break-all font-mono">{consent.installDestination}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Data root</dt>
          <dd className="break-all font-mono">{consent.dataRoot}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Service mode</dt>
          <dd>{consent.serviceMode}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        The signed manifest is verified before installation. The artifact signature and checksum are
        verified before the binary is executed.
      </p>
      {consent.requiredCommands.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium">Commands BiBCode will run</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-muted-foreground">
            {consent.requiredCommands.map((command) => (
              <li key={command}>{command}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function WorkspaceSection({
  icon,
  title,
  description,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground">
          {icon}
        </span>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function AddEnvironmentWorkspace({
  wslDiscovery,
  addedWslDistroNames,
  sshHosts = EMPTY_SSH_HOSTS,
  onRefreshWsl,
  onRefreshSsh,
  onPrepareWsl,
  onPrepareSsh,
  onInstallSetup,
  onConnectSsh,
  onConnectDirect,
  setupProgress = null,
}: AddEnvironmentWorkspaceProps) {
  const addedWslDistros = useMemo(
    () => new Set(addedWslDistroNames.map((name) => name.toLocaleLowerCase())),
    [addedWslDistroNames],
  );
  const [sshInput, setSshInput] = useState<SshEnvironmentTargetInput>({
    host: "",
    username: "",
    port: "",
  });
  const [directInput, setDirectInput] = useState({ endpoint: "", pairingCode: "" });
  const [preparedSetup, setPreparedSetup] = useState<PreparedEnvironmentSetup | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<void>) => {
    setPendingAction(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The environment operation failed.");
    } finally {
      setPendingAction(null);
    }
  };

  const prepareWsl = (distro: string) => {
    if (wslDiscovery === null) return;
    void run(`wsl:${distro}`, async () => {
      const probe = await onPrepareWsl(distro, wslDiscovery.generation);
      if (probe.compatibility === "compatible") {
        onRefreshWsl();
        return;
      }
      setPreparedSetup({ transport: "wsl", probe });
    });
  };

  const prepareSshTarget = (target: DesktopSshEnvironmentTarget) => {
    void run("ssh", async () => {
      const probe = await onPrepareSsh(target);
      if (probe.compatibility === "compatible") {
        await onConnectSsh(target);
        return;
      }
      setPreparedSetup({ transport: "ssh", probe });
    });
  };

  const prepareSsh = (event: FormEvent) => {
    event.preventDefault();
    try {
      prepareSshTarget(parseSshEnvironmentTarget(sshInput));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The SSH target is invalid.");
    }
  };

  const installPreparedSetup = () => {
    const consent = preparedSetup?.probe.consent;
    if (preparedSetup === null || consent === null || consent === undefined) return;
    void run("install", async () => {
      await onInstallSetup(preparedSetup, {
        requestId: consent.requestId,
        probeGeneration: consent.probeGeneration,
        accepted: true,
      });
      setPreparedSetup(null);
    });
  };

  const connectDirect = (event: FormEvent) => {
    event.preventDefault();
    void run("direct", async () => {
      const endpoint = parseDirectEnvironmentEndpoint(directInput.endpoint);
      if (directInput.pairingCode.trim() === "") {
        throw new Error("Enter the one-use pairing code from the remote environment.");
      }
      await onConnectDirect({
        endpoint: endpoint.toString(),
        pairingCode: directInput.pairingCode.trim(),
      });
    });
  };

  const consent = preparedSetup?.probe.consent ?? null;

  return (
    <main
      aria-label="Add environment workspace"
      className="h-full min-h-0 overflow-y-auto bg-background px-4 py-6 text-foreground sm:px-6"
    >
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <header>
          <h1 className="text-lg font-semibold">Add environment</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Connect a machine that will own its own projects, worktrees, and threads. Every paired
            client currently receives full administrator access.
          </p>
        </header>

        {error ? (
          <div
            role="alert"
            className="rounded-xl border border-destructive/35 bg-destructive/8 p-3 text-sm"
          >
            {error}
          </div>
        ) : null}

        {setupProgress !== null ? (
          <div role="status" className="rounded-xl border border-border/70 bg-muted/35 p-3">
            <p className="text-sm font-medium">
              {setupProgress.stage.replace(/([A-Z])/gu, " $1").toLocaleLowerCase()} ·{" "}
              {setupProgress.status}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {setupProgress.message ??
                (setupProgress.totalBytes === null
                  ? `${setupProgress.completedBytes} bytes processed`
                  : `${setupProgress.completedBytes} of ${setupProgress.totalBytes} bytes`)}
            </p>
          </div>
        ) : null}

        <WorkspaceSection
          icon={<MonitorCogIcon className="size-4" aria-hidden />}
          title="Windows Subsystem for Linux"
          description="Running WSL distributions are discovered automatically on Windows and remain available as environments."
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Stopped distributions are never started automatically.
            </p>
            <Button size="sm" variant="outline" onClick={onRefreshWsl}>
              <RefreshCwIcon className="size-3.5" aria-hidden />
              Refresh
            </Button>
          </div>
          {wslDiscovery === null ? (
            <p className="rounded-lg border border-border/70 p-3 text-xs text-muted-foreground">
              WSL discovery is available only in the Windows desktop app.
            </p>
          ) : wslDiscovery.distros.length === 0 ? (
            <p className="rounded-lg border border-border/70 p-3 text-xs text-muted-foreground">
              No WSL distributions were discovered.
            </p>
          ) : (
            <div className="space-y-2">
              {wslDiscovery.distros.map((distro) => {
                const isAdded = addedWslDistros.has(distro.name.toLocaleLowerCase());
                const isRunning = distro.state === "running";
                return (
                  <div
                    key={distro.name}
                    data-wsl-distro={distro.name}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{distro.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {distro.isDefault ? "Default · " : ""}
                        {isRunning ? "Running" : "Stopped"} · WSL {distro.version}
                      </p>
                    </div>
                    {isAdded ? (
                      <span className="text-xs font-medium text-muted-foreground">
                        Added environment
                      </span>
                    ) : isRunning ? (
                      <Button
                        size="sm"
                        disabled={pendingAction !== null}
                        onClick={() => prepareWsl(distro.name)}
                      >
                        {pendingAction === `wsl:${distro.name}` ? "Checking…" : "Review setup"}
                      </Button>
                    ) : (
                      <span className="max-w-64 text-right text-xs text-muted-foreground">
                        Open WSL management to start it intentionally
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </WorkspaceSection>

        <WorkspaceSection
          icon={<NetworkIcon className="size-4" aria-hidden />}
          title="SSH"
          description="Use the desktop SSH tunnel. The BiBCode server remains bound to loopback on the remote machine."
        >
          {sshHosts.length > 0 ? (
            <div className="mb-4 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium">Discovered OpenSSH hosts</p>
                {onRefreshSsh ? (
                  <Button size="sm" variant="outline" onClick={onRefreshSsh}>
                    <RefreshCwIcon className="size-3.5" aria-hidden />
                    Refresh
                  </Button>
                ) : null}
              </div>
              {sshHosts.map((target) => (
                <div
                  key={`${target.source}:${target.alias}:${target.hostname}:${target.port ?? "default"}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                >
                  <div>
                    <p className="text-sm font-medium">{target.alias}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {target.username ? `${target.username}@` : ""}
                      {target.hostname}
                      {target.port === null ? "" : `:${target.port}`} · {target.source}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pendingAction !== null}
                    onClick={() => prepareSshTarget(target)}
                  >
                    Review setup
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <form className="grid gap-3 sm:grid-cols-6" onSubmit={prepareSsh}>
            <label className="sm:col-span-3 text-xs font-medium text-muted-foreground">
              SSH host or alias
              <Input
                className="mt-1"
                value={sshInput.host}
                placeholder="dev@build.example.com:22"
                onChange={(event) => setSshInput({ ...sshInput, host: event.target.value })}
              />
            </label>
            <label className="sm:col-span-2 text-xs font-medium text-muted-foreground">
              Username (optional)
              <Input
                className="mt-1"
                value={sshInput.username}
                onChange={(event) => setSshInput({ ...sshInput, username: event.target.value })}
              />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              Port
              <Input
                className="mt-1"
                inputMode="numeric"
                value={sshInput.port}
                onChange={(event) => setSshInput({ ...sshInput, port: event.target.value })}
              />
            </label>
            <div className="sm:col-span-6 flex justify-end">
              <Button
                type="submit"
                disabled={pendingAction !== null || sshInput.host.trim() === ""}
              >
                {pendingAction === "ssh" ? "Checking…" : "Review SSH setup"}
              </Button>
            </div>
          </form>
        </WorkspaceSection>

        <WorkspaceSection
          icon={<ArrowLeftRightIcon className="size-4" aria-hidden />}
          title="Direct HTTPS or secure WebSocket"
          description="Connect only with an explicit secure endpoint. Plaintext HTTP and WebSocket connections are not offered."
        >
          <form className="space-y-3" onSubmit={connectDirect}>
            <label className="block text-xs font-medium text-muted-foreground">
              https:// or wss:// endpoint
              <Input
                className="mt-1"
                type="url"
                placeholder="https://bibcode.example.com"
                value={directInput.endpoint}
                onChange={(event) =>
                  setDirectInput({ ...directInput, endpoint: event.target.value })
                }
              />
            </label>
            <label className="block text-xs font-medium text-muted-foreground">
              One-use pairing code
              <Input
                className="mt-1"
                type="password"
                autoComplete="off"
                value={directInput.pairingCode}
                onChange={(event) =>
                  setDirectInput({ ...directInput, pairingCode: event.target.value })
                }
              />
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              TLS must pass system certificate trust or an explicit SPKI SHA-256 pin. The pairing
              pin must come from the host-local or SSH enrollment channel; it is never trusted from
              the network endpoint itself. The pairing code is exchanged for device-bound
              administrator credentials and is never stored.
            </p>
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={
                  pendingAction !== null ||
                  directInput.endpoint.trim() === "" ||
                  directInput.pairingCode.trim() === ""
                }
              >
                {pendingAction === "direct" ? "Connecting…" : "Connect securely"}
              </Button>
            </div>
          </form>
        </WorkspaceSection>

        {preparedSetup !== null && consent !== null ? (
          <section aria-label="Remote server install consent" className="space-y-3">
            <SetupConsentReview consent={consent} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPreparedSetup(null)}>
                Cancel
              </Button>
              <Button disabled={pendingAction !== null} onClick={installPreparedSetup}>
                {pendingAction === "install" ? "Installing…" : "Install remote server"}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
