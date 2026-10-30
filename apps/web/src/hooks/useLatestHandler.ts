import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * One function for the component's life that calls the latest committed render's `handler`.
 *
 * React Compiler keeps each memoized callback from the last render whose inputs changed, and
 * every closure of a render holds that render's whole scope. Two callbacks recreated at
 * different renders therefore hold each other's older renders, and every changed reconnect
 * kept more ChatComposer and ChatView renders alive (#198, #204). Created in this hook, the
 * returned function's scope holds only the ref, and the ref holds one render's handler.
 *
 * The ref updates in a layout effect, so the result is for event handlers, async
 * continuations and `useEffect` bodies, and may be passed as a prop (unlike an Effect Event).
 * Never call it during render, and never from a child's `useLayoutEffect`: children's layout
 * effects run before the parent's, so they would run the previous render's handler. An async
 * operation that must act on the state it started with captures that state before its first
 * `await` instead of reading it through a latest handler afterwards.
 */
export function useLatestHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  }, [handler]);
  return useCallback((...args: Args) => latest.current(...args), []);
}
