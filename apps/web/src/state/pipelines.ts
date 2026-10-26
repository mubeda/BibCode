import { createPipelinesEnvironmentAtoms } from "@bibcode/client-runtime/state/pipelines";
import { connectionAtomRuntime } from "../connection/runtime";
export const pipelinesEnvironment = createPipelinesEnvironmentAtoms(connectionAtomRuntime);
