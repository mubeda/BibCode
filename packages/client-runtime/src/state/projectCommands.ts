import {
  type EnvironmentId,
  type ProjectReadFileResult,
  type ProjectCreateUploadUrlInput,
  WS_METHODS,
} from "@bibcode/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createRuntimeCommand,
  runInEnvironment,
} from "./runtime.ts";
import {
  type CreateProjectInput,
  type DeleteProjectInput,
  type UpdateProjectInput,
  createProject,
  deleteProject,
  updateProject,
} from "../operations/commands.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { currentSession, EnvironmentRpcUnavailableError, requestInSession } from "../rpc/client.ts";
import { readFileTransferSession } from "../operations/fileTransferSession.ts";

const createUnpinnedUploadUrl = Effect.fn("Projects.createUnpinnedUploadUrl")(function* (
  input: ProjectCreateUploadUrlInput,
) {
  const registry = yield* EnvironmentRegistry;
  const supervisor = yield* EnvironmentSupervisor;
  const carrying = yield* readFileTransferSession(registry, supervisor, yield* currentSession());
  if (carrying.prepared.e2ee !== null)
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message: "Uploads aren't available over encrypted connections yet.",
    });
  // The legacy caller still owns HTTP handoff after this mint; no upload commit policy is added.
  return yield* requestInSession(
    carrying.session,
    supervisor.target.environmentId,
    WS_METHODS.projectsCreateUploadUrl,
    input,
  );
});

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  return {
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
    }),
    /**
     * Signals that the workspace changed on disk outside the application.
     *
     * The stream carries no entry data — the server's index remains the source of truth — so a
     * subscriber refreshes `listEntries` when this fires.
     */
    subscribeEntries: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:projects:subscribe-entries",
      tag: WS_METHODS.projectsSubscribeEntries,
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    readFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file",
      tag: WS_METHODS.projectsReadFile,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
    createEntry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:create-entry",
      tag: WS_METHODS.projectsCreateEntry,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
      },
    }),
    createDownloadUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:create-download-url",
      tag: WS_METHODS.projectsCreateDownloadUrl,
    }),
    createUploadUrl: createRuntimeCommand(runtime, {
      label: "environment-data:projects:create-upload-url",
      execute: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: ProjectCreateUploadUrlInput;
      }) => runInEnvironment(target.environmentId, createUnpinnedUploadUrl(target.input)),
    }),
    refreshEntries: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:refresh-entries",
      tag: WS_METHODS.projectsListEntries,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
      },
    }),
    renameEntry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:rename-entry",
      tag: WS_METHODS.projectsRenameEntry,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
      },
    }),
    deleteEntry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:delete-entry",
      tag: WS_METHODS.projectsDeleteEntry,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
      },
    }),
    duplicateEntry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:duplicate-entry",
      tag: WS_METHODS.projectsDuplicateEntry,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
      },
    }),
  };
}
