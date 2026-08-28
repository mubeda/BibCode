import { createRemoteUpdateEnvironmentAtoms } from "@bibcode/client-runtime/state/remoteUpdates";

import { connectionAtomRuntime } from "../connection/runtime";

export const remoteUpdateEnvironment = createRemoteUpdateEnvironmentAtoms(connectionAtomRuntime);
