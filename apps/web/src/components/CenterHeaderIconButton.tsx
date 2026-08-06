import type { ComponentProps, ReactElement } from "react";

import { Button } from "./ui/button";

export type CenterHeaderIconButtonProps = Omit<ComponentProps<typeof Button>, "size" | "variant">;

export function CenterHeaderIconButton(props: CenterHeaderIconButtonProps): ReactElement {
  return <Button {...props} data-center-header-icon-control size="icon-sm" variant="outline" />;
}
