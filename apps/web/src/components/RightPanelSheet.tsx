import { type ReactNode } from "react";

import { RIGHT_PANEL_SHEET_CLASS_NAME } from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  consumeEscapeClose?: () => boolean;
}) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open, eventDetails) => {
        const childConsumesEscape =
          eventDetails.reason === "escape-key" && props.consumeEscapeClose?.() === true;
        if (!open && childConsumesEscape) {
          eventDetails.cancel();
          return;
        }
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className={RIGHT_PANEL_SHEET_CLASS_NAME}
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
