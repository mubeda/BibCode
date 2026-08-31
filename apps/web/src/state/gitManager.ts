import { createGitManagerEnvironmentAtoms } from "@bibcode/client-runtime/state/git-manager";

import { connectionAtomRuntime } from "../connection/runtime";

export const gitManagerEnvironment = createGitManagerEnvironmentAtoms(connectionAtomRuntime);
