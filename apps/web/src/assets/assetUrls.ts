import { useAtomValue } from "@effect/atom-react";
import type { AssetResource, EnvironmentId } from "@bibcode/contracts";

import { assetEnvironment } from "~/state/assets";

export { resolveAssetUrl } from "@bibcode/client-runtime/state/assets";

export function useAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  return useAtomValue(assetEnvironment.url({ environmentId, resource }));
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  return useAtomValue(assetEnvironment.urls({ environmentId, resources }));
}
