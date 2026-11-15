import { createRouter, RouterHistory } from "@tanstack/react-router";

import { clientCollector } from "./profiler/clientCollector";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  const router = createRouter({
    routeTree,
    history,
    context: {},
    // Only the root route has an error component (the "Something went wrong." screen), so
    // this runs once for each error it catches. The route id is the pattern, never the path.
    defaultOnCatch: (error, errorInfo) => {
      clientCollector.recordRenderError(error, errorInfo.componentStack, () => {
        const routeId = router.state.matches.at(-1)?.routeId;
        // Only one of the app's own route ids, never anything taken from the location.
        return routeId !== undefined && Object.hasOwn(router.routesById, routeId)
          ? routeId
          : undefined;
      });
    },
  });
  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
