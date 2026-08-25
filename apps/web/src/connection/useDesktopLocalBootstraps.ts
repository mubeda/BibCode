import type { DesktopEnvironmentBootstrap } from "@bibcode/contracts";
import { useEffect, useState } from "react";

import { observeDesktopLocalTopology, readDesktopLocalTopologySnapshot } from "./desktopLocal";

function bootstrapsFromCurrentTopology(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const current = readDesktopLocalTopologySnapshot().secondaryBootstraps;
  return current._tag === "Success" ? current.bootstraps : (current.retainedBootstraps ?? []);
}

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). One shared controller consumes decoded native lifecycle events;
 * failed reads retain the latest successful snapshot, while a successful empty
 * read clears it.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const [bootstraps, setBootstraps] = useState<ReadonlyArray<DesktopEnvironmentBootstrap>>(
    bootstrapsFromCurrentTopology,
  );

  useEffect(
    () =>
      observeDesktopLocalTopology((snapshot) => {
        const current = snapshot.secondaryBootstraps;
        setBootstraps(
          current._tag === "Success" ? current.bootstraps : (current.retainedBootstraps ?? []),
        );
      }),
    [],
  );

  return bootstraps;
}
