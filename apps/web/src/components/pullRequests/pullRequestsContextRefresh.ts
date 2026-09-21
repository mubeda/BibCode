import { createContext } from "react";

/** Read failures can invalidate context without adding transport or permission policy to a view. */
export const PullRequestsContextRefresh = createContext<(() => void) | null>(null);
