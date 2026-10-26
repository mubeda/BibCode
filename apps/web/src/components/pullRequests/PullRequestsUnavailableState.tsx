import { GitPullRequestIcon } from "lucide-react";
import {
  RepositoryModuleUnavailableState,
  type RepositoryModuleUnavailableStateProps,
} from "../repositoryModule/RepositoryModuleUnavailableState";

/** The Pull Requests variant of the repository module's unavailable state. */
export function PullRequestsUnavailableState(
  props: Omit<RepositoryModuleUnavailableStateProps, "label" | "Icon">,
) {
  return (
    <RepositoryModuleUnavailableState label="Pull Requests" Icon={GitPullRequestIcon} {...props} />
  );
}
