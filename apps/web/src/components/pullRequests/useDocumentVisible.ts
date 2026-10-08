import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function isVisible(): boolean {
  return document.visibilityState === "visible";
}

/** Whether the document is visible; a hidden document drops server subscriptions. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, isVisible, () => true);
}
