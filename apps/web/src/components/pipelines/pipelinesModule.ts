import { environmentRpcKey } from "@bibcode/client-runtime/state/runtime";
import type { EnvironmentId } from "@bibcode/contracts";
import { WorkflowIcon } from "lucide-react";
import { useCallback } from "react";
import type { PipelinesFilters } from "../../pipelinesStore";
import { pipelinesEnvironment } from "../../state/pipelines";
import type {
  RepositoryModuleDescriptor,
  RepositoryModuleFirstPagePrefetch,
} from "../repositoryModule/repositoryModuleDescriptor";
import { buildPipelinesListInput } from "./list/pipelinesList.logic";

export const PIPELINES_DISABLED_IN_SETTINGS_MESSAGE =
  "Pipelines are turned off in Settings → Source Control.";
export const PIPELINES_MUTATIONS_UNSUPPORTED_MESSAGE =
  "Update the server to retry and cancel pipelines.";

/** The Pipelines module on the repository module shell. */
export const pipelinesModule: RepositoryModuleDescriptor = {
  id: "pipelines",
  label: "Pipelines",
  Icon: WorkflowIcon,
  settingKey: "pipelinesEnabled",
  readsCapability: "pipelinesReads",
  mutationsCapability: "pipelinesMutations",
  disabledMessage: PIPELINES_DISABLED_IN_SETTINGS_MESSAGE,
  unsupportedMessage: "Update this environment's server to use Pipelines.",
  mutationsUnsupportedMessage: PIPELINES_MUTATIONS_UNSUPPORTED_MESSAGE,
  // GitHub workflow runs arrive in a later release; the host's own page has them.
  providerGap: (context) =>
    context.provider === "github"
      ? {
          message: "Pipelines for GitHub are coming.",
          url: `${context.webUrl.replace(/\/+$/, "")}/actions`,
          linkLabel: "Open on GitHub",
        }
      : null,
};

/** The first page for the filters the route shows; it needs no context field. */
export function usePipelinesFirstPagePrefetch(
  environmentId: EnvironmentId,
  filters: PipelinesFilters,
): RepositoryModuleFirstPagePrefetch {
  return useCallback(
    (cwd: string) => {
      const input = buildPipelinesListInput(filters, cwd);
      return {
        atom: pipelinesEnvironment.list({ environmentId, input }),
        key: environmentRpcKey({ environmentId, input }),
      };
    },
    [environmentId, filters],
  );
}
