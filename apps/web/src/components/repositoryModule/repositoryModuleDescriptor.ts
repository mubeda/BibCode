import type { PullRequestsContext } from "@bibcode/contracts";
import type { AsyncResult, Atom } from "effect/reactivity";
import type { LucideIcon } from "lucide-react";
import type {
  RepositoryModuleMutationsCapability,
  RepositoryModuleReadsCapability,
} from "./repositoryModuleAvailability";

export type AvailableRepositoryContext = Extract<PullRequestsContext, { status: "available" }>;

/** The list's first page, read alongside a pending context and consumed by the list view. */
export interface RepositoryModuleFirstPage {
  readonly atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;
  /** `environmentRpcKey` of the read, which the list view compares with its own input. */
  readonly key: string;
}

/** Why a module does not show a provider it otherwise reads, and where the user can go. */
export interface RepositoryModuleProviderGap {
  readonly message: string;
  readonly url: string;
  readonly linkLabel: string;
}

/**
 * What makes a repository module itself: its name, setting, capabilities, copy, and
 * how it reads its first page. Everything else (availability, checkout, context,
 * unavailable states) is the shell's, so the modules cannot drift apart.
 */
export interface RepositoryModuleDescriptor {
  readonly id: "pull-requests" | "pipelines";
  /** The module's name, as its button says it. */
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly settingKey: "pullRequestsEnabled" | "pipelinesEnabled";
  readonly readsCapability: RepositoryModuleReadsCapability;
  readonly mutationsCapability: RepositoryModuleMutationsCapability;
  readonly disabledMessage: string;
  /** An older server without the module's reads. */
  readonly unsupportedMessage: string;
  /** An older server without the module's actions; the views stay read-only. */
  readonly mutationsUnsupportedMessage: string;
  /** A provider this server reads but the module does not show yet, or `null`. */
  readonly providerGap: (context: AvailableRepositoryContext) => RepositoryModuleProviderGap | null;
}

/**
 * The first page a module's list opens on for a checkout, or `null` when that page
 * depends on the context. Building it reads nothing: the shell subscribes to it only
 * on a list route while the context is pending. Keep it referentially stable.
 */
export type RepositoryModuleFirstPagePrefetch = (cwd: string) => RepositoryModuleFirstPage | null;

/** Which route the shell serves: only a list route reads its first page early. */
export type RepositoryModuleView = "list" | "detail";
