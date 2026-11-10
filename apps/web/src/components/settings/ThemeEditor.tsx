import {
  type ThemeFile,
  type TerminalToken,
  type UiKeywordToken,
  type UiLengthToken,
  type UiToken,
  TERMINAL_TOKENS,
} from "@bibcode/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { setThemePreview } from "../../hooks/useTheme";
import { getTheme, saveCustomTheme } from "../../themes/customThemes";
import { pairRatios, resolveToken } from "../../themes/themeColor";
import { LENGTH_TOKEN_RANGES, themeValueError } from "../../themes/themeValidation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ThemeColorField } from "./ThemeColorField";
import { SettingsSection } from "./settingsLayout";

/** Editor groups from the design note's token list; every supported token appears once. */
const UI_GROUPS: { title: string; tokens: readonly UiToken[] }[] = [
  {
    title: "Surfaces",
    tokens: [
      "background",
      "app-chrome-background",
      "card",
      "popover",
      "secondary",
      "muted",
      "accent",
      "selected",
      "border",
      "input",
      "panel-separator",
      "radius",
      "control-shadow",
    ],
  },
  {
    title: "Text",
    tokens: [
      "foreground",
      "foreground-strong",
      "card-foreground",
      "popover-foreground",
      "secondary-foreground",
      "muted-foreground",
      "accent-foreground",
      "selected-foreground",
      "placeholder",
      "link",
    ],
  },
  {
    title: "Accent and focus",
    tokens: [
      "primary",
      "primary-foreground",
      "primary-hover",
      "primary-active",
      "ring",
      "focus-ring-width",
      "focus-ring-offset",
    ],
  },
  {
    title: "Status",
    tokens: [
      "destructive",
      "destructive-foreground",
      "info",
      "info-foreground",
      "success",
      "success-foreground",
      "warning",
      "warning-foreground",
      "find-match",
      "find-match-foreground",
      "find-match-active",
      "find-match-active-foreground",
    ],
  },
  {
    title: "Sidebar",
    tokens: [
      "sidebar-well",
      "sidebar-card",
      "sidebar-card-border",
      "sidebar-env-band",
      "sidebar-card-shadow",
    ],
  },
];

const LENGTH_TOKENS = new Set<string>(Object.keys(LENGTH_TOKEN_RANGES));
const MINIMUM_RATIO = 4.5;

type Texts = Record<string, string>;

function labelOf(token: string): string {
  const words = token.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Field keys are `ui.<token>` or `terminal.<token>`, so the two namespaces cannot collide. */
function textsOf(theme: ThemeFile): Texts {
  const texts: Texts = {};
  for (const [token, value] of Object.entries(theme.ui ?? {})) texts[`ui.${token}`] = value;
  for (const [token, value] of Object.entries(theme.terminal ?? {})) {
    texts[`terminal.${token}`] = value;
  }
  return texts;
}

function errorOf(key: string, text: string): string | null {
  return themeValueError(key.slice(key.indexOf(".") + 1), text);
}

/** The draft holds only valid values, so the preview keeps the last valid one of a field. */
function withValue(draft: ThemeFile, key: string, value: string | undefined): ThemeFile {
  const [group, token] = key.split(".", 2) as ["ui" | "terminal", string];
  const values: Record<string, string> = { ...draft[group] };
  if (value === undefined) delete values[token];
  else values[token] = value;
  const { ui: _ui, terminal: _terminal, ...rest } = draft;
  const ui = group === "ui" ? values : draft.ui;
  const terminal = group === "terminal" ? values : draft.terminal;
  return {
    ...rest,
    ...(ui && Object.keys(ui).length > 0 ? { ui } : {}),
    ...(terminal && Object.keys(terminal).length > 0 ? { terminal } : {}),
  };
}

function LengthField({
  token,
  value,
  error,
  onChange,
}: {
  token: UiLengthToken;
  value: string | undefined;
  error: string | null;
  onChange(value: string | undefined): void;
}) {
  const id = useId();
  const hintId = useId();
  const errorId = useId();
  const label = labelOf(token);
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="min-w-0 flex-1 truncate text-sm text-foreground">
          {label}
        </label>
        <Input
          id={id}
          size="sm"
          className="w-40 shrink-0 font-mono"
          spellCheck={false}
          autoComplete="off"
          placeholder="Default"
          value={value ?? ""}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          onChange={(event) => onChange(event.currentTarget.value || undefined)}
        />
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {`From ${LENGTH_TOKEN_RANGES[token].text}. Leave empty for the default.`}
      </p>
      {error ? (
        <p id={errorId} className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function KeywordField({
  token,
  value,
  onChange,
}: {
  token: UiKeywordToken;
  value: string | undefined;
  onChange(value: string | undefined): void;
}) {
  if (token === "sidebar-card-shadow") {
    return (
      <div className="flex items-center justify-between gap-2 text-sm text-foreground">
        <span aria-hidden>Sidebar card shadow</span>
        <Switch
          aria-label="Sidebar card shadow"
          checked={value !== "none"}
          onCheckedChange={(checked) => onChange(checked ? undefined : "none")}
        />
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 text-sm text-foreground">
      <span>Control shadows</span>
      <Select
        value={value ?? "default"}
        onValueChange={(next) => onChange(next === "none" ? "none" : undefined)}
      >
        <SelectTrigger className="w-40" aria-label="Control shadows">
          <SelectValue>{value === "none" ? "None" : "Default"}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem hideIndicator value="default">
            Default
          </SelectItem>
          <SelectItem hideIndicator value="none">
            None
          </SelectItem>
        </SelectPopup>
      </Select>
    </div>
  );
}

/**
 * Edits a custom theme with a live preview in this window (#290, R47, R52, R54). Nothing is
 * stored before Save; Cancel, Save and unmount all clear the preview.
 */
export function ThemeEditor({ themeId, onClose }: { themeId: string; onClose(): void }) {
  // Read once: a save in another window must not replace the draft (R61 with an open editor).
  const [saved] = useState(() => getTheme(themeId));
  const [draft, setDraft] = useState<ThemeFile | undefined>(saved);
  const [texts, setTexts] = useState<Texts>(() => (saved ? textsOf(saved) : {}));
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rootRef.current?.focus();
    return () => setThemePreview(null);
  }, []);
  useEffect(() => {
    if (draft) setThemePreview(draft);
  }, [draft]);

  const errors = useMemo(() => {
    const found: Record<string, string> = {};
    for (const [key, text] of Object.entries(texts)) {
      const error = errorOf(key, text);
      if (error) found[key] = error;
    }
    return found;
  }, [texts]);
  const ratios = useMemo(() => (draft ? pairRatios(draft) : []), [draft]);

  if (!saved || !draft) {
    return (
      <div className="grid gap-2 p-3 text-sm">
        <p>This theme no longer exists.</p>
        <Button size="sm" variant="outline" className="justify-self-start" onClick={onClose}>
          Back to themes
        </Button>
      </div>
    );
  }

  const change = (key: string, text: string | undefined) => {
    setSaveError(null);
    setTexts((current) => {
      const next = { ...current };
      if (text === undefined) delete next[key];
      else next[key] = text;
      return next;
    });
    if (text === undefined || errorOf(key, text) === null) {
      setDraft((current) => current && withValue(current, key, text));
    }
  };
  const baseValueOf = (key: string) => {
    const token = key.slice(key.indexOf(".") + 1);
    const unset = withValue(draft, key, undefined);
    return resolveToken(unset, key.startsWith("terminal.") ? key : token);
  };
  const cancel = () => {
    setThemePreview(null);
    onClose();
  };
  const save = () => {
    const result = saveCustomTheme(draft);
    if (!result.ok) {
      setSaveError(result.errors.map((error) => error.message).join(" "));
      return;
    }
    setThemePreview(null);
    onClose();
  };
  const resetAll = () => {
    setTexts({});
    const { ui: _ui, terminal: _terminal, ...rest } = draft;
    setDraft(rest);
    setConfirmingReset(false);
  };
  const hasErrors = Object.keys(errors).length > 0;

  const renderUiField = (token: UiToken) => {
    const key = `ui.${token}`;
    let control;
    if (token === "sidebar-card-shadow" || token === "control-shadow") {
      control = (
        <KeywordField token={token} value={texts[key]} onChange={(value) => change(key, value)} />
      );
    } else if (LENGTH_TOKENS.has(token)) {
      control = (
        <LengthField
          token={token as UiLengthToken}
          value={texts[key]}
          error={errors[key] ?? null}
          onChange={(value) => change(key, value)}
        />
      );
    } else {
      control = (
        <ThemeColorField
          label={labelOf(token)}
          value={texts[key]}
          baseValue={baseValueOf(key)}
          error={errors[key]}
          onChange={(value) => change(key, value)}
        />
      );
    }
    return (
      <div key={key} data-theme-field={key}>
        {control}
      </div>
    );
  };
  const renderTerminalField = (token: TerminalToken) => {
    const key = `terminal.${token}`;
    return (
      <div key={key} data-theme-field={key}>
        <ThemeColorField
          label={`Terminal ${token.replace(/-/g, " ")}`}
          value={texts[key]}
          baseValue={baseValueOf(key)}
          error={errors[key]}
          onChange={(value) => change(key, value)}
        />
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-theme-editor={themeId}
      aria-label={`Edit ${saved.name}`}
      className="grid gap-4 outline-none"
    >
      <SettingsSection title={`Edit ${saved.name}`}>
        <div className="grid gap-5 p-4">
          {UI_GROUPS.map((group) => (
            <fieldset key={group.title} className="grid gap-2">
              <legend className="mb-2 text-sm font-medium text-foreground-strong">
                {group.title}
              </legend>
              {group.tokens.map(renderUiField)}
            </fieldset>
          ))}
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium text-foreground-strong">Terminal</legend>
            <p className="text-xs text-muted-foreground">
              Used by new terminals when the terminal follows the app theme.
            </p>
            {TERMINAL_TOKENS.map(renderTerminalField)}
          </fieldset>
        </div>
      </SettingsSection>

      <SettingsSection title="Contrast">
        <ul className="grid gap-1 p-4 text-sm">
          {ratios.map(({ pair, ratio }) => {
            const low = ratio < MINIMUM_RATIO;
            return (
              <li
                key={`${pair.text}:${pair.surface}`}
                data-contrast-pair={`${pair.text}:${pair.surface}`}
                className="flex flex-wrap items-center gap-x-2"
              >
                <span className="min-w-0 flex-1">
                  {pair.label}{" "}
                  <span className="text-muted-foreground">{`(${pair.text} on ${pair.surface})`}</span>
                </span>
                {low ? (
                  <span className="flex items-center gap-1 text-warning-foreground">
                    <TriangleAlertIcon aria-hidden className="size-4" />
                    Low contrast
                  </span>
                ) : null}
                <span className="font-mono tabular-nums">{`${ratio.toFixed(2)}:1`}</span>
              </li>
            );
          })}
        </ul>
      </SettingsSection>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {saveError ? (
          <p role="alert" className="mr-auto text-sm text-destructive-foreground">
            {saveError}
          </p>
        ) : null}
        {confirmingReset ? (
          <div
            role="group"
            aria-label="Reset all values?"
            className="mr-auto flex items-center gap-2 text-sm"
          >
            <span>Reset every value to the base theme?</span>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingReset(false)}>
              Keep my changes
            </Button>
            <Button size="sm" variant="destructive" onClick={resetAll}>
              Reset all values
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="mr-auto"
            onClick={() => setConfirmingReset(true)}
          >
            Reset all
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={cancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={hasErrors} onClick={save}>
          Save
        </Button>
        {hasErrors ? (
          <p className="basis-full text-right text-xs text-muted-foreground">
            Fix the fields marked with an error to save.
          </p>
        ) : null}
      </div>
    </div>
  );
}
