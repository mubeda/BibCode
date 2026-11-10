import { useId } from "react";

import { parseColor, toHex } from "../../themes/themeColor";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** The six-digit hex a native color input accepts. */
function pickerValue(value: string | undefined, baseValue: string): string {
  return toHex(value !== undefined && parseColor(value) ? value : baseValue).slice(0, 7);
}

/**
 * One theme color: a native color input, a text field for any supported color syntax and a
 * Reset button that returns the token to its base value (#290, R47). `value` is the text as
 * typed, so an invalid entry stays visible next to its error.
 */
export function ThemeColorField({
  label,
  value,
  baseValue,
  onChange,
  error,
}: {
  label: string;
  value: string | undefined;
  baseValue: string;
  onChange(value: string | undefined): void;
  error?: string | undefined;
}) {
  const textId = useId();
  const errorId = useId();
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={textId} className="min-w-0 flex-1 truncate text-sm text-foreground">
          {label}
        </label>
        <input
          type="color"
          aria-label={`${label} color picker`}
          className="size-7 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
          value={pickerValue(value, baseValue)}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <Input
          id={textId}
          size="sm"
          className="w-40 shrink-0 font-mono"
          spellCheck={false}
          autoComplete="off"
          value={value ?? ""}
          placeholder={baseValue}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => onChange(event.currentTarget.value || undefined)}
        />
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`Reset ${label}`}
          disabled={value === undefined}
          onClick={() => onChange(undefined)}
        >
          Reset
        </Button>
      </div>
      {error ? (
        <p id={errorId} className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
