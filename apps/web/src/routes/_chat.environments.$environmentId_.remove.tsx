import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import { EnvironmentId, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@bibcode/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

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

  const context = useMemo<EnvironmentRemovalContext | null>(() => {
    if (environment === null || presentation === null) return null;
    const primary =
      environmentId === EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID) ||
      environment.bindings.some((binding) => binding._tag === "DesktopPrimaryBinding");
    const wsl = environment.bindings.some((binding) => binding._tag === "DesktopWslBinding");
    return {
      environmentId,
      environmentGeneration: 0,
      alias: environment.alias ?? environment.descriptor?.label ?? presentation.label,
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
      // Remote host mutation is enabled only after Plan 70 supplies its removal-plan adapter.
      hostAuthorityAvailable: false,
      plan: null,
    };
  }, [environment, environmentId, presentation]);

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
        executeRemote: async () => {
          throw new Error(
            "This build has no verified host-authority removal adapter. No remote action ran.",
          );
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
        onRequestFreshPlan={() => undefined}
        onRemove={remove}
      />
    </ChatRouteInset>
  );
}

export const Route = createFileRoute("/_chat/environments/$environmentId_/remove")({
  component: EnvironmentRemovalRouteView,
});
