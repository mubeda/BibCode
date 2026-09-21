import { createPullRequestsEnvironmentAtoms } from "@bibcode/client-runtime/state/pull-requests";
import { connectionAtomRuntime } from "../connection/runtime";
export const pullRequestsEnvironment = createPullRequestsEnvironmentAtoms(connectionAtomRuntime);
