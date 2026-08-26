import { useAtomValue } from "@effect/atom-react";
import type {
  ConnectionTarget,
  EnvironmentBinding,
  EnvironmentRoute,
} from "@bibcode/client-runtime/connection";
import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import {
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopEnvironmentRemovalPlan,
  type DesktopEnvironmentRemovalResult,
  type DesktopEnvironmentRemovalTarget,
} from "@bibcode/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { EnvironmentRemovalWorkspace } from "../components/environments/EnvironmentRemovalWorkspace";
import {
  executeEnvironmentRemoval,
  type EnvironmentRemovalContext,
  type EnvironmentRemovalOutcome,
  type EnvironmentRemovalReachability,
  type EnvironmentRemovalSelection,
} from "../components/environments/environmentRemovalModel";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { environmentCatalog } from "../connection/catalog";
import { useEnvironment } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { ChatRouteInset } from "./-ChatRouteInset";

export function removalReachability(input: {
  readonly phase: string;
  readonly targetTag: string;
  readonly detail: string | null;
}): EnvironmentRemovalReachability {
  if (input.targetTag === "UnavailableConnectionTarget") {
    return input.detail?.toLocaleLowerCase().includes("stopped") ? "stopped" : "setup-required";
  }
  return input.phase === "connected" ? "online" : "offline";
}

export interface EnvironmentRemovalHostAuthority {
  readonly target: DesktopEnvironmentRemovalTarget;
  readonly environmentGeneration: number;
}

export function environmentRemovalHostAuthority(input: {
  readonly target: ConnectionTarget;
  readonly routes: ReadonlyArray<EnvironmentRoute>;
  readonly bindings: ReadonlyArray<EnvironmentBinding>;
}): EnvironmentRemovalHostAuthority | null {
  const activeTarget = input.target;
  if (!("connectionId" in activeTarget)) return null;
  const route = input.routes.find((candidate) => candidate.routeId === activeTarget.connectionId);
  if (route?._tag === "DesktopWslRoute") {
    const binding = input.bindings.find(
      (candidate) =>
        candidate._tag === "DesktopWslBinding" && candidate.bindingId === route.bindingId,
    );
    if (binding?._tag !== "DesktopWslBinding") return null;
    return {
      target: {
        transport: "wsl",
        distro: binding.distroName,
        discoveryGeneration: binding.lastDiscoveryGeneration,
      },
      environmentGeneration: binding.lastDiscoveryGeneration,
    };
  }
  if (route?._tag === "SshTunnelRoute" && route.hostKeyFingerprint !== null) {
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/u.test(route.hostKeyFingerprint)) return null;
    return {
      target: {
        transport: "ssh",
        target: route.target,
        expectedHostKeyFingerprint: route.hostKeyFingerprint,
      },
      environmentGeneration: 0,
    };
  }
  return null;
}

function assertVerifiedRemovalResult(input: {
  readonly requestAction: "uninstall" | "purge";
  readonly environmentId: EnvironmentId;
  readonly storageId: string;
  readonly result: DesktopEnvironmentRemovalResult;
}): void {
  if (
    input.result.action !== input.requestAction ||
    input.result.environmentId !== input.environmentId ||
    input.result.storageId !== input.storageId ||
    !input.result.verified
  ) {
    throw new Error("The desktop host returned a removal result for another environment.");
  }
  if (
    input.requestAction === "uninstall" &&
    (!input.result.dataRootPreserved || input.result.dataRemoved)
  ) {
    throw new Error("The desktop host could not verify that server data was preserved.");
  }
  if (
    input.requestAction === "purge" &&
    (!input.result.dataRemoved || input.result.dataRootPreserved)
  ) {
    throw new Error("The desktop host could not verify the approved remote data deletion.");
  }
}

function EnvironmentRemovalRouteView() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const environmentId = EnvironmentId.make(params.environmentId);
  const records = useAtomValue(environmentCatalog.environmentRecordsValueAtom);
  const environment = records.get(environmentId) ?? null;
  const presentation = useEnvironment(environmentId);
  const hideEnvironment = useAtomCommand(environmentCatalog.hide, { reportFailure: true });
  const restoreEnvironment = useAtomCommand(environmentCatalog.restore, { reportFailure: true });
  const disconnectEnvironment = useAtomCommand(environmentCatalog.disconnect, {
    reportFailure: true,
  });
  const forgetEnvironment = useAtomCommand(environmentCatalog.forget, { reportFailure: false });
  const [remotePlan, setRemotePlan] = useState<DesktopEnvironmentRemovalPlan | null>(null);
  const [planningRemoval, setPlanningRemoval] = useState(false);
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;

  const hostAuthority = useMemo(
    () =>
      environment === null || presentation === null
        ? null
        : environmentRemovalHostAuthority({
            target: presentation.entry.target,
            routes: environment.routes,
            bindings: environment.bindings,
          }),
    [environment, presentation],
  );
  const alias =
    environment?.alias ?? environment?.descriptor?.label ?? presentation?.label ?? "Environment";
  const authorityKey = hostAuthority === null ? null : JSON.stringify(hostAuthority.target);

  useEffect(() => {
    setRemotePlan(null);
  }, [alias, authorityKey, environmentId, environment?.acceptedStorageInstanceId]);

  const context = useMemo<EnvironmentRemovalContext | null>(() => {
    if (environment === null || presentation === null) return null;
    const primary =
      environmentId === EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID) ||
      environment.bindings.some((binding) => binding._tag === "DesktopPrimaryBinding");
    const wsl = environment.bindings.some((binding) => binding._tag === "DesktopWslBinding");
    return {
      environmentId,
      environmentGeneration: hostAuthority?.environmentGeneration ?? 0,
      alias,
      kind: primary ? "primary" : wsl ? "wsl" : "remote",
      hidden: environment.hidden,
      reachability: removalReachability({
        phase: presentation.connection.phase,
        targetTag: presentation.entry.target._tag,
        detail:
          presentation.entry.target._tag === "UnavailableConnectionTarget"
            ? presentation.entry.target.detail
            : null,
      }),
      storageId: environment.acceptedStorageInstanceId,
      hostAuthorityAvailable:
        hostAuthority !== null &&
        bridge?.planEnvironmentRemoval !== undefined &&
        bridge.executeEnvironmentRemoval !== undefined,
      plan:
        remotePlan === null
          ? null
          : { ...remotePlan, environmentGeneration: hostAuthority?.environmentGeneration ?? 0 },
    };
  }, [alias, bridge, environment, environmentId, hostAuthority, presentation, remotePlan]);

  const requestFreshPlan = async () => {
    if (
      context === null ||
      hostAuthority === null ||
      context.storageId === null ||
      bridge?.planEnvironmentRemoval === undefined
    ) {
      return;
    }
    setPlanningRemoval(true);
    try {
      const plan = await bridge.planEnvironmentRemoval({
        target: hostAuthority.target,
        expectedEnvironmentId: context.environmentId,
        expectedStorageId: context.storageId,
        environmentName: context.alias,
      });
      setRemotePlan(plan);
    } catch (error) {
      setRemotePlan(null);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not verify remote removal",
          description:
            error instanceof Error
              ? error.message
              : "The host did not return an identity-bound removal plan.",
        }),
      );
    } finally {
      setPlanningRemoval(false);
    }
  };

  const runVisibilityCommand = async (hidden: boolean) => {
    const result = await (hidden
      ? hideEnvironment(environmentId)
      : restoreEnvironment(environmentId));
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: hidden ? "Could not hide environment" : "Could not restore environment",
          description:
            error instanceof Error ? error.message : "The client metadata update failed.",
        }),
      );
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: hidden ? "Environment hidden" : "Environment restored",
        description: hidden
          ? "Only navigation presentation changed. Routes, credentials, cache, and settings remain."
          : "The environment is visible in navigation again.",
        ...(hidden
          ? {
              actionProps: {
                children: "Undo",
                onClick: () => void restoreEnvironment(environmentId),
              },
            }
          : {}),
      }),
    );
  };

  const disconnect = async () => {
    const result = await disconnectEnvironment(environmentId);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not disconnect environment",
          description: error instanceof Error ? error.message : "The active session stayed open.",
        }),
      );
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Environment disconnected",
        description: "Routes, credentials, cached content, settings, and remote data remain.",
      }),
    );
  };

  const remove = async (
    selection: EnvironmentRemovalSelection,
  ): Promise<EnvironmentRemovalOutcome> => {
    if (context === null) {
      return {
        status: "local-failed",
        localRemoved: false,
        remoteOutcome: "not-requested",
        retainCatalog: true,
        message: "Environment identity metadata is unavailable.",
      };
    }
    const outcome = await executeEnvironmentRemoval(
      context,
      selection,
      {
        executeRemote: async (request) => {
          if (
            hostAuthority === null ||
            remotePlan === null ||
            bridge?.executeEnvironmentRemoval === undefined ||
            request.environmentId !== context.environmentId ||
            request.planId !== remotePlan.planId
          ) {
            throw new Error("The verified host removal plan is no longer available.");
          }
          setRemotePlan(null);
          const result = await bridge.executeEnvironmentRemoval(
            request.action === "purge"
              ? {
                  action: "purge",
                  target: hostAuthority.target,
                  plan: remotePlan,
                  confirmEnvironmentName: request.confirmEnvironmentName,
                }
              : {
                  action: "uninstall",
                  target: hostAuthority.target,
                  plan: remotePlan,
                },
          );
          assertVerifiedRemovalResult({
            requestAction: request.action,
            environmentId: context.environmentId,
            storageId: remotePlan.storageId,
            result,
          });
          return { verified: true };
        },
        forgetLocal: async (id) => {
          const result = await forgetEnvironment(id);
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
      },
      new Date(),
    );
    if (outcome.status === "removed") {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Environment removed from this client",
          description: outcome.message,
        }),
      );
      void navigate({ to: "/settings/environments", replace: true });
    }
    return outcome;
  };

  if (context === null) {
    return (
      <ChatRouteInset>
        <main className="flex h-full items-center justify-center p-6 text-center">
          <div className="max-w-md">
            <h1 className="text-lg font-semibold">Environment removal unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This client has no verified identity metadata for the selected environment.
            </p>
          </div>
        </main>
      </ChatRouteInset>
    );
  }

  return (
    <ChatRouteInset>
      <EnvironmentRemovalWorkspace
        context={context}
        busy={planningRemoval}
        onBack={() =>
          void navigate({
            to: "/environments/$environmentId",
            params: { environmentId },
            search: { tab: "overview" },
          })
        }
        onHide={() => runVisibilityCommand(true)}
        onRestore={() => runVisibilityCommand(false)}
        onDisconnect={disconnect}
        onRequestFreshPlan={requestFreshPlan}
        onRemove={remove}
      />
    </ChatRouteInset>
  );
}

export const Route = createFileRoute("/_chat/environments/$environmentId_/remove")({
  component: EnvironmentRemovalRouteView,
});
