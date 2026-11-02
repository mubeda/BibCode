import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const GIT_DISCARD_RECOVERY_STORAGE_KEY = "bibcode:git-discard-recovery:v1";
const MOST_CHECKOUTS_REMEMBERED = 32;
const MOST_NOTICES_PER_CHECKOUT = 8;

/** The checkout a notice belongs to. */
export const discardRecoveryKey = (environmentId: string, cwd: string) =>
  `${environmentId}\u0000${cwd}`;

/** Stable, so a checkout with no notices never re-renders its readers. */
export const NO_DISCARD_RECOVERY_NOTICES: ReadonlyArray<string> = Object.freeze([]);

interface GitDiscardRecoveryState {
  /**
   * Where a discard kept files outside the working tree, per checkout, until the person
   * dismisses the notice. Held here, not in the panel, so leaving the tab or the panel keeps it.
   */
  readonly noticesByCheckout: Record<string, ReadonlyArray<string>>;
  readonly addNotice: (key: string, notice: string) => void;
  readonly dismissNotices: (key: string) => void;
}

/** Keeps only checkouts whose notices are non-empty string lists (storage may hold anything). */
function sanitize(value: unknown): Record<string, ReadonlyArray<string>> {
  if (typeof value !== "object" || value === null) return {};
  const entries = Object.entries(value).flatMap(([key, notices]) => {
    if (!Array.isArray(notices)) return [];
    const strings = notices.filter((notice): notice is string => typeof notice === "string");
    return strings.length > 0 ? [[key, strings.slice(-MOST_NOTICES_PER_CHECKOUT)] as const] : [];
  });
  return Object.fromEntries(entries.slice(-MOST_CHECKOUTS_REMEMBERED));
}

export const useGitDiscardRecoveryStore = create<GitDiscardRecoveryState>()(
  persist(
    (set) => ({
      noticesByCheckout: {},
      addNotice: (key, notice) =>
        set((state) => {
          const { [key]: current = [], ...others } = state.noticesByCheckout;
          if (current.includes(notice)) return state;
          return {
            noticesByCheckout: sanitize({ ...others, [key]: [...current, notice] }),
          };
        }),
      dismissNotices: (key) =>
        set((state) => {
          const { [key]: _dismissed, ...others } = state.noticesByCheckout;
          return { noticesByCheckout: others };
        }),
    }),
    {
      name: GIT_DISCARD_RECOVERY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ noticesByCheckout: state.noticesByCheckout }),
      merge: (persisted, current) => ({
        ...current,
        noticesByCheckout: sanitize(
          (persisted as { noticesByCheckout?: unknown } | undefined)?.noticesByCheckout,
        ),
      }),
    },
  ),
);
