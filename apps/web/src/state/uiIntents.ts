import { createUiIntentsEnvironmentAtoms } from "@bibcode/client-runtime/state/uiIntents";

import { connectionAtomRuntime } from "../connection/runtime";

/** An outside agent's pending UI suggestions, per environment (#139, slice X4). */
export const uiIntentsEnvironment = createUiIntentsEnvironmentAtoms(connectionAtomRuntime);
