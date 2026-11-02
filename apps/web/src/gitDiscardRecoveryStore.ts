import { create } from "zustand";

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
   * In memory only: another window's notices would overwrite this one's if they were saved.
   */
  readonly noticesByCheckout: Record<string, ReadonlyArray<string>>;
  readonly addNotice: (key: string, notice: string) => void;
  readonly dismissNotices: (key: string) => void;
}

export const useGitDiscardRecoveryStore = create<GitDiscardRecoveryState>()((set) => ({
  noticesByCheckout: {},
  addNotice: (key, notice) =>
    set((state) => {
      const { [key]: current = [], ...others } = state.noticesByCheckout;
      if (current.includes(notice)) return state;
      const entries = Object.entries({
        ...others,
        [key]: [...current, notice].slice(-MOST_NOTICES_PER_CHECKOUT),
      });
      return {
        noticesByCheckout: Object.fromEntries(entries.slice(-MOST_CHECKOUTS_REMEMBERED)),
      };
    }),
  dismissNotices: (key) =>
    set((state) => {
      const { [key]: _dismissed, ...others } = state.noticesByCheckout;
      return { noticesByCheckout: others };
    }),
}));
