import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import type {
  DesktopBridge,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  RemoteSetupProgress,
} from "@bibcode/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  AddEnvironmentWorkspace,
  type DirectEnvironmentInput,
} from "../components/environments/AddEnvironmentWorkspace";
import { environmentCatalog } from "../connection/catalog";
import { connectPairing, connectSshEnvironment } from "../connection/onboarding";
import { desktopWslStateAtom, refreshDesktopWslState } from "../state/desktopWslState";
import { desktopSshHostsStateAtom } from "../state/desktopSshHosts";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { ChatRouteInset } from "./-ChatRouteInset";

interface EnvironmentWithBindings {
  readonly bindings: readonly { readonly _tag: string; readonly distroName?: string }[];
}

export function collectAddedWslDistroNames(
  environments: Iterable<EnvironmentWithBindings>,
): string[] {
  const names = new Map<string, string>();
  for (const environment of environments) {
    for (const binding of environment.bindings) {
      if (binding._tag !== "DesktopWslBinding" || binding.distroName === undefined) continue;
      const normalized = binding.distroName.trim();
      if (normalized === "") continue;
      names.set(normalized.toLocaleLowerCase(), normalized);
    }
  }
  return [...names.values()].toSorted((left, right) => left.localeCompare(right));
}

function requireDesktopBridge(): DesktopBridge {
  const bridge = window.desktopBridge;
  if (bridge === undefined) {
    throw new Error("WSL and SSH setup require the BiBCode desktop app.");
  }
  return bridge;
}

function throwCommandFailure(result: { readonly _tag: string }): never {
  throw squashAtomCommandFailure(result as never);
}

function AddEnvironmentRouteView() {
  const navigate = useNavigate();
  const records = useAtomValue(environmentCatalog.environmentRecordsValueAtom);
  const wslState = useEnvironmentQuery(
    typeof window !== "undefined" && window.desktopBridge !== undefined
      ? desktopWslStateAtom
      : null,
  );
  const sshHosts = useEnvironmentQuery(
    typeof window !== "undefined" && window.desktopBridge !== undefined
      ? desktopSshHostsStateAtom
      : null,
  );
  const connectPairingCommand = useAtomCommand(connectPairing, { reportFailure: false });
  const connectSshCommand = useAtomCommand(connectSshEnvironment, { reportFailure: false });
  const [setupProgress, setSetupProgress] = useState<RemoteSetupProgress | null>(null);

  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
    return bridge?.onRemoteSetupProgress?.((progress) => setSetupProgress(progress));
  }, []);

  const openEnvironment = async (environmentId: EnvironmentId) => {
    await navigate({
      to: "/environments/$environmentId",
      params: { environmentId },
      search: { tab: "overview" },
    });
  };

  const connectSsh = async (target: DesktopSshEnvironmentTarget) => {
    const result = await connectSshCommand({ target });
    if (result._tag !== "Success") throwCommandFailure(result);
    await openEnvironment(result.value);
  };

  return (
    <ChatRouteInset>
      <AddEnvironmentWorkspace
        wslDiscovery={wslState.data?.discovery ?? null}
        addedWslDistroNames={collectAddedWslDistroNames(records.values())}
        sshHosts={sshHosts.data ?? []}
        setupProgress={setupProgress}
        onRefreshWsl={refreshDesktopWslState}
        onRefreshSsh={sshHosts.refresh}
        onPrepareWsl={async (distro, discoveryGeneration) => {
          const bridge = requireDesktopBridge();
          if (bridge.prepareWslServer === undefined) {
            throw new Error("This desktop build cannot prepare WSL server setup.");
          }
          return bridge.prepareWslServer({ distro, discoveryGeneration });
        }}
        onPrepareSsh={(target) => requireDesktopBridge().prepareSshServer({ target })}
        onInstallSetup={async (setup, decision) => {
          const bridge = requireDesktopBridge();
          if (setup.transport === "wsl") {
            if (bridge.installWslServer === undefined) {
              throw new Error("This desktop build cannot install the WSL server.");
            }
            const result = await bridge.installWslServer(decision);
            if (result.status !== "completed" || result.descriptor === null) {
              throw new Error(result.message ?? "The WSL server installation did not complete.");
            }
            refreshDesktopWslState();
            await openEnvironment(result.descriptor.environmentId);
            return;
          }

          const result = await bridge.installSshServer(decision);
          if (result.status !== "completed") {
            throw new Error(result.message ?? "The SSH server installation did not complete.");
          }
          await connectSsh(setup.probe.target);
        }}
        onConnectSsh={connectSsh}
        onConnectDirect={async ({ endpoint, pairingCode }: DirectEnvironmentInput) => {
          const result = await connectPairingCommand({ host: endpoint, pairingCode });
          if (result._tag !== "Success") throwCommandFailure(result);
          await openEnvironment(result.value);
        }}
      />
    </ChatRouteInset>
  );
}

export const Route = createFileRoute("/_chat/environments/add")({
  component: AddEnvironmentRouteView,
});
