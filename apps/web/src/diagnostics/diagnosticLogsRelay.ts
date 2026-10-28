import {
  DiagnosticLogsRelaySendError,
  type DownloadedDiagnosticLogs,
  type RelayEnvironmentCandidate,
  relayFailureItem,
  relayItemsForArchive,
  resolveRelayEnvironment,
} from "@bibcode/client-runtime/diagnostics";
import type {
  DiagnosticLogsDownloadInput,
  DiagnosticLogsRelayEvent,
  DiagnosticLogsRelayItem,
  EnvironmentId,
} from "@bibcode/contracts";
import { create } from "zustand";

/**
 * A `bibcode diagnostics download` waiting for the user: the resolved environment, and what
 * the command sent so the user can recognise it (the environment as typed, its printed code,
 * and the directory it saves in).
 */
export interface DiagnosticLogsRelayPrompt {
  readonly requestId: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly includeCrashDumps: boolean;
  readonly requested: string;
  readonly code: string;
  readonly outputDirectory: string;
}

/** The prompts on screen, oldest first; the relay allows one request at a time anyway. */
export const useDiagnosticLogsRelayPrompts = create<{
  readonly prompts: ReadonlyArray<DiagnosticLogsRelayPrompt>;
}>(() => ({ prompts: [] }));

function removePrompt(requestId: string): void {
  useDiagnosticLogsRelayPrompts.setState(({ prompts }) => ({
    prompts: prompts.filter((prompt) => prompt.requestId !== requestId),
  }));
}

export interface DiagnosticLogsRelayDependencies {
  /** The environments this app can reach, as the command's selector is resolved against. */
  readonly candidates: () => ReadonlyArray<RelayEnvironmentCandidate>;
  readonly claim: (requestId: string) => Promise<boolean>;
  /** Rejects with `DiagnosticLogsRelaySendError` when the primary refuses the item. */
  readonly send: (requestId: string, item: DiagnosticLogsRelayItem) => Promise<void>;
  /** The checked download from `environmentId` over its own connection; `signal` stops it. */
  readonly download: (
    environmentId: EnvironmentId,
    label: string,
    input: DiagnosticLogsDownloadInput,
    signal: AbortSignal,
  ) => Promise<DownloadedDiagnosticLogs>;
  readonly downloadInput: (includeCrashDumps: boolean) => DiagnosticLogsDownloadInput;
}

/** Request ids remembered against a resubscription replaying them. */
const HANDLED_LIMIT = 64;

/**
 * Answers the primary's relay requests for one subscription: asks the user, then relays the
 * named environment's checked bundle, or the reason it could not. Nothing is downloaded
 * before the user allows it, and a request that ends (the command left, it expired, another
 * window answered) closes its prompt and stops its download.
 */
export class DiagnosticLogsRelayController {
  readonly #dependencies: DiagnosticLogsRelayDependencies;
  readonly #handled = new Set<string>();
  readonly #running = new Map<string, AbortController>();
  #disposed = false;

  constructor(dependencies: DiagnosticLogsRelayDependencies) {
    this.#dependencies = dependencies;
  }

  handle(event: DiagnosticLogsRelayEvent): void {
    if (this.#disposed) return;
    if (event._tag === "Claimed") {
      // A window took it; this one, if it was not that window, has nothing left to ask.
      removePrompt(event.requestId);
      return;
    }
    if (event._tag === "Closed") {
      removePrompt(event.requestId);
      this.#running.get(event.requestId)?.abort();
      return;
    }
    const { requestId, environment, includeCrashDumps, code, outputDirectory } = event.request;
    if (this.#handled.has(requestId)) return;
    this.#handled.add(requestId);
    if (this.#handled.size > HANDLED_LIMIT) {
      this.#handled.delete(this.#handled.values().next().value!);
    }
    const resolution = resolveRelayEnvironment(environment, this.#dependencies.candidates());
    if (resolution.kind !== "found") {
      // Only the name the command sent comes back, so this needs no approval.
      void this.#answer(requestId, {
        _tag: "Failed",
        reason: resolution.kind,
        message: resolution.message,
      });
      return;
    }
    const prompt: DiagnosticLogsRelayPrompt = {
      requestId,
      environmentId: resolution.environment.environmentId as EnvironmentId,
      label: resolution.environment.label.trim() || resolution.environment.environmentId,
      includeCrashDumps,
      requested: environment,
      code,
      outputDirectory,
    };
    useDiagnosticLogsRelayPrompts.setState(({ prompts }) => ({ prompts: [...prompts, prompt] }));
  }

  /** The user allowed it: claim it for this window, then relay the download. */
  async approve(prompt: DiagnosticLogsRelayPrompt): Promise<void> {
    removePrompt(prompt.requestId);
    if (this.#disposed) return;
    // Registered before the claim, so a request that closes while the claim is in flight
    // (the command left, it expired) never starts a download.
    const abort = new AbortController();
    this.#running.set(prompt.requestId, abort);
    try {
      if (!(await this.#claim(prompt.requestId)) || abort.signal.aborted || this.#disposed) {
        return;
      }
      let archive: DownloadedDiagnosticLogs;
      try {
        archive = await this.#dependencies.download(
          prompt.environmentId,
          prompt.label,
          this.#dependencies.downloadInput(prompt.includeCrashDumps),
          abort.signal,
        );
      } catch (error) {
        if (!abort.signal.aborted) {
          await this.#send(prompt.requestId, relayFailureItem(error, prompt.label));
        }
        return;
      }
      for (const item of relayItemsForArchive(archive)) {
        if (abort.signal.aborted || !(await this.#send(prompt.requestId, item))) return;
      }
    } finally {
      this.#running.delete(prompt.requestId);
    }
  }

  /** The user said no. */
  async deny(prompt: DiagnosticLogsRelayPrompt): Promise<void> {
    removePrompt(prompt.requestId);
    await this.#answer(prompt.requestId, { _tag: "Denied" });
  }

  /** The subscription ended: close this controller's prompts and stop its downloads. */
  dispose(): void {
    this.#disposed = true;
    for (const abort of this.#running.values()) abort.abort();
    this.#running.clear();
    useDiagnosticLogsRelayPrompts.setState({ prompts: [] });
  }

  async #answer(requestId: string, item: DiagnosticLogsRelayItem): Promise<void> {
    if (await this.#claim(requestId)) await this.#send(requestId, item);
  }

  async #claim(requestId: string): Promise<boolean> {
    try {
      return await this.#dependencies.claim(requestId);
    } catch {
      return false;
    }
  }

  /** `false` once the primary refused: the request is over, so stop sending. */
  async #send(requestId: string, item: DiagnosticLogsRelayItem): Promise<boolean> {
    try {
      await this.#dependencies.send(requestId, item);
      return true;
    } catch (error) {
      if (!(error instanceof DiagnosticLogsRelaySendError)) {
        console.warn("Couldn't send the diagnostics relay item", requestId);
      }
      this.#running.get(requestId)?.abort();
      return false;
    }
  }
}
