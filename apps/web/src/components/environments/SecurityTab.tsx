import { EnvironmentSectionView } from "./EnvironmentSectionView";
import type { EnvironmentWorkspaceSection } from "./environmentWorkspaceModel";

export function SecurityTab({ section }: { readonly section: EnvironmentWorkspaceSection }) {
  return <EnvironmentSectionView section={section} />;
}
