import { createFileTransferEnvironmentAtoms } from "@bibcode/client-runtime/state/file-transfers";
import type { FileDownloadAvailability } from "@bibcode/client-runtime/operations";
import type { FileTransferOperation } from "@bibcode/client-runtime/state/file-transfers";
import { Atom } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";

/** One application factory; invocation lifetime remains owned by each AtomRegistry. */
export const fileTransfers = createFileTransferEnvironmentAtoms(connectionAtomRuntime);

/** Empty UI scope; these values never authorize a request. */
export const noFileTransferAvailability = Atom.make<FileDownloadAvailability>({
  route: "unavailable",
  connected: false,
  serverName: "Server",
});
export const noFileTransferOperation = Atom.make<FileTransferOperation | null>(null);
