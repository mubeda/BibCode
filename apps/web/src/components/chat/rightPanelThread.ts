import type { ScopedThreadRef } from "@bibcode/contracts";
import { createContext } from "react";

/**
 * The thread whose right panel shows what a chat opens (a link in the browser, a file).
 * A chat panel renders no right panel, so it provides its host thread; elsewhere it is
 * absent and a chat opens in its own thread's panel.
 */
export const RightPanelThreadContext = createContext<ScopedThreadRef | null>(null);
