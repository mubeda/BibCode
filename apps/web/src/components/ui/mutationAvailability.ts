import { createContext } from "react";
/** The environment capability gate is independent of the host's per-action permission. */
export const MutationsDisabledContext = createContext<string | null>(null);
