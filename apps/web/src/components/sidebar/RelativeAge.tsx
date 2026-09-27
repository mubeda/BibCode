import { memo } from "react";

import { useMinuteClock } from "../../minuteClock";
import { formatCompactAge } from "../Sidebar.logic";

/**
 * A card's age. It is the only card element subscribed to the minute clock, so
 * a tick re-renders this text and no card.
 */
export const RelativeAge = memo(function RelativeAge(props: {
  readonly iso: string | null;
  readonly className?: string;
}) {
  const now = useMinuteClock();
  const label = formatCompactAge(props.iso, now);
  if (props.iso === null || label === null) {
    return null;
  }
  return (
    <time dateTime={props.iso} className={props.className}>
      {label}
    </time>
  );
});
