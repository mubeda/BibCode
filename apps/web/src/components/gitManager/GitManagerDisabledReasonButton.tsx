import { useId, type ComponentProps, type ReactNode } from "react";

import { Button } from "~/components/ui/button";

/**
 * A disabled control must explain itself (UI.md). The shared Button sets `pointer-events-none`
 * while disabled, so a `title` on it never shows; the reason sits on a wrapper that still
 * receives hover. Assistive technology reads it from an sr-only description this component
 * owns and always wires, after any description the caller passes in `aria-describedby`.
 */
export function GitManagerDisabledReasonButton({
  disabledReason,
  disabled = false,
  enabledTitle,
  wrapperClassName = "inline-flex",
  "aria-describedby": describedBy,
  children,
  ...props
}: {
  readonly disabledReason: string | null;
  /** Another reason to disable that has no text of its own, such as a running operation. */
  readonly disabled?: boolean;
  readonly enabledTitle?: string;
  readonly wrapperClassName?: string;
  readonly children?: ReactNode;
} & Omit<ComponentProps<typeof Button>, "disabled" | "title">) {
  const reasonId = useId();
  const reasonShown = disabledReason !== null;
  const describedByIds =
    [describedBy, reasonShown ? reasonId : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <>
      <span className={wrapperClassName} title={disabledReason ?? undefined}>
        <Button
          {...props}
          aria-describedby={describedByIds}
          disabled={reasonShown || disabled}
          title={reasonShown ? undefined : enabledTitle}
        >
          {children}
        </Button>
      </span>
      {reasonShown ? (
        <span className="sr-only" id={reasonId}>
          {disabledReason}
        </span>
      ) : null}
    </>
  );
}
