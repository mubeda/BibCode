import { PullRequestsMutationsDisabledContext } from "../pullRequestsMutationAvailability";
import type { PullRequestsPermission } from "@bibcode/contracts";
import { useContext, useId, type ComponentProps } from "react";
import { Button } from "../../ui/button";
export type PullRequestsPermissionButtonProps = Omit<ComponentProps<typeof Button>, "disabled"> & {
  permission: PullRequestsPermission;
  mutation?: boolean;
};
/** Release placeholder only; a host denial and its wording always take precedence. */
export function readOnlyPermission(
  permission: PullRequestsPermission,
  reason = "This action arrives in a later build",
): PullRequestsPermission {
  return permission.allowed ? { allowed: false, reason } : permission;
}
export function constrainPermission(
  permission: PullRequestsPermission,
  reason: string | null,
): PullRequestsPermission {
  return permission.allowed && reason ? { allowed: false, reason } : permission;
}
export function PullRequestsPermissionButton({
  permission: requestedPermission,
  mutation = false,
  children,
  onClick,
  variant,
  size,
  ...props
}: PullRequestsPermissionButtonProps) {
  const id = useId();
  const disabledReason = useContext(PullRequestsMutationsDisabledContext);
  const permission = constrainPermission(requestedPermission, mutation ? disabledReason : null);
  return (
    <span
      className="inline-flex"
      title={!permission.allowed ? (permission.reason ?? undefined) : undefined}
    >
      <Button
        {...props}
        disabled={!permission.allowed}
        title={permission.reason ?? undefined}
        aria-describedby={!permission.allowed ? id : undefined}
        onClick={onClick}
        variant={variant}
        size={size}
      >
        {children}
      </Button>
      {!permission.allowed ? (
        <span id={id} className="sr-only">
          {permission.reason}
        </span>
      ) : null}
    </span>
  );
}
