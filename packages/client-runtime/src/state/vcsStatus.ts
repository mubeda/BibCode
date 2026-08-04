import type { EnvironmentId } from "@bibcode/contracts";

export interface VcsStatusTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}
