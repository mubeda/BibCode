import { MutationsDisabledContext } from "./mutationAvailability";
import { useContext, useId, type ComponentProps } from "react";
import { Button } from "./button";

export interface ActionPermission {
  readonly allowed: boolean;
  readonly reason: string | null;
}

export type PermissionButtonProps = Omit<ComponentProps<typeof Button>, "disabled"> & {
  permission: ActionPermission;
  mutation?: boolean;
};
export function constrainPermission(
  permission: ActionPermission,
  reason: string | null,
): ActionPermission {
  return permission.allowed && reason ? { allowed: false, reason } : permission;
}
export function PermissionButton({
  permission: requestedPermission,
  mutation = false,
  children,
  onClick,
  variant,
  size,
  ...props
}: PermissionButtonProps) {
  const id = useId();
  const disabledReason = useContext(MutationsDisabledContext);
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
