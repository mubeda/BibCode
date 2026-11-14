/**
 * Which answer notices a person has opened, by request id. It is the only stored fact behind a
 * source thread's unread mark: the rest is derived from the request list the server keeps, so
 * nothing here depends on a timestamp or on the order pages arrive in.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

const STORAGE_KEY = "bibcode:send-request-opened:v1";

export interface SendRequestOpenedState {
  openedIds: string[];
  markOpened: (requestId: string) => void;
  /** Keeps only the ids in `liveRequestIds`, so the list does not grow with every request. */
  keepOnly: (liveRequestIds: Iterable<string>) => void;
}

export const useSendRequestOpenedStore = create<SendRequestOpenedState>()(
  persist(
    (set) => ({
      openedIds: [],
      markOpened: (requestId) =>
        set((state) =>
          state.openedIds.includes(requestId)
            ? state
            : { openedIds: [...state.openedIds, requestId] },
        ),
      keepOnly: (liveRequestIds) =>
        set((state) => {
          const live = new Set(liveRequestIds);
          const kept = state.openedIds.filter((id) => live.has(id));
          return kept.length === state.openedIds.length ? state : { openedIds: kept };
        }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ openedIds: state.openedIds }),
    },
  ),
);
