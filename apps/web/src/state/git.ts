import { createGitEnvironmentAtoms } from "@bibcode/client-runtime/state/git";

import { connectionAtomRuntime } from "../connection/runtime";

export const gitEnvironment = createGitEnvironmentAtoms(connectionAtomRuntime);
