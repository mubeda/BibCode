import { projectKey } from "@bibcode/client-runtime/state/entities";
import { environmentRpcKey } from "@bibcode/client-runtime/state/runtime";
import type { ScopedProjectRef } from "@bibcode/contracts";
import { GitPullRequestIcon } from "lucide-react";
import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePullRequestsStore } from "../../pullRequestsStore";
import { pullRequestsEnvironment } from "../../state/pullRequests";
import type {
  RepositoryModuleDescriptor,
  RepositoryModuleFirstPagePrefetch,
} from "../repositoryModule/repositoryModuleDescriptor";
import {
  firstPagePrefetchInput,
  selectListFilters,
  selectListSort,
  selectListTab,
} from "./list/pullRequestsList.logic";
import {
  PULL_REQUESTS_CAPABILITIES,
  PULL_REQUESTS_DISABLED_IN_SETTINGS_MESSAGE,
} from "./pullRequestsAvailability";

/** The Pull Requests module on the repository module shell. */
export const pullRequestsModule: RepositoryModuleDescriptor = {
  id: "pull-requests",
  Icon: GitPullRequestIcon,
  settingKey: "pullRequestsEnabled",
  ...PULL_REQUESTS_CAPABILITIES,
  disabledMessage: PULL_REQUESTS_DISABLED_IN_SETTINGS_MESSAGE,
  unsupportedMessage: "This environment does not support Pull Requests.",
  // Unsupported hosts already answer an unavailable context.
  providerGap: () => null,
};

/**
 * The Open or Closed first page the list opens on, from the project's saved tab,
 * filters and sort; Merged and All wait for the context (GitHub folds them into Closed).
 */
export function usePullRequestsFirstPagePrefetch(
  projectRef: ScopedProjectRef,
): RepositoryModuleFirstPagePrefetch {
  const storeKey = projectKey(projectRef);
  const listView = usePullRequestsStore(
    useShallow((state) => {
      const view = state.byProjectKey[storeKey];
      return {
        filters: selectListFilters(view),
        listTab: selectListTab(view),
        sort: selectListSort(view),
      };
    }),
  );
  const environmentId = projectRef.environmentId;
  return useCallback(
    (cwd: string) => {
      const input = firstPagePrefetchInput(listView, cwd);
      return input === null
        ? null
        : {
            atom: pullRequestsEnvironment.list({ environmentId, input }),
            key: environmentRpcKey({ environmentId, input }),
          };
    },
    [environmentId, listView],
  );
}
