import type { ThemeFile } from "@bibcode/contracts";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { useTheme } from "../../hooks/useTheme";
import { BUILTIN_THEMES, isBuiltinThemeId } from "../../themes/builtinThemes";
import {
  deleteCustomTheme,
  duplicateTheme,
  saveCustomTheme,
  setSlot,
  useThemeLibrary,
} from "../../themes/customThemes";
import { resolveToken } from "../../themes/themeColor";
import { exportThemeJson } from "../../themes/themeTransfer";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { ThemeEditor } from "./ThemeEditor";
import { ThemeImportDialog } from "./ThemeImportDialog";

type Base = "light" | "dark";

const MODE_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

const SWATCH_TOKENS = ["background", "card", "primary", "foreground", "border"] as const;
const BASE_LABEL: Record<Base, string> = { light: "Light", dark: "Dark" };

/** Saves the theme as `<id>.theme.json`; the id grammar has no path characters. */
function downloadTheme(theme: ThemeFile) {
  const url = URL.createObjectURL(new Blob([exportThemeJson(theme)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${theme.id}.theme.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function subtitleOf(theme: ThemeFile): string {
  return BUILTIN_THEMES.find((builtin) => builtin.id === theme.id)?.subtitle ?? "Custom";
}

/** A new id from the name, unique among `taken`. */
function newThemeId(name: string, taken: ReadonlySet<string>): string {
  const stem =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "theme";
  let id = stem;
  for (let suffix = 2; taken.has(id) || isBuiltinThemeId(id); suffix += 1) id = `${stem}-${suffix}`;
  return id;
}

function ThemePreview({ theme }: { theme: ThemeFile }) {
  return (
    <span aria-hidden className="flex shrink-0 overflow-hidden rounded-md border border-border">
      {SWATCH_TOKENS.map((token) => (
        <span
          key={token}
          data-swatch={token}
          className="size-5"
          style={{ backgroundColor: resolveToken(theme, token) }}
        />
      ))}
    </span>
  );
}

function NewThemeForm({
  existingIds,
  onCreated,
  onCancel,
}: {
  existingIds: ReadonlySet<string>;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const nameId = useId();
  const errorId = useId();
  const [base, setBase] = useState<Base>("light");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return setError("Enter a name.");
    if (trimmed.length > 48) return setError("Use 48 characters or fewer.");
    const id = newThemeId(trimmed, existingIds);
    const result = saveCustomTheme({ version: 1, id, name: trimmed, base });
    if (!result.ok) return setError(result.errors[0]?.message ?? "Could not create the theme.");
    onCreated(id);
  };

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-lg border border-border p-3">
      <fieldset className="flex flex-wrap items-center gap-4 text-sm">
        <legend className="mb-2 text-sm font-medium text-foreground">Base</legend>
        {(["light", "dark"] as const).map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name="theme-base"
              value={value}
              checked={base === value}
              onChange={() => setBase(value)}
            />
            {BASE_LABEL[value]}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium text-foreground">
          Name
        </label>
        <Input
          id={nameId}
          name="theme-name"
          value={name}
          aria-invalid={error !== null || undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setName(event.currentTarget.value);
            setError(null);
          }}
        />
        {error ? (
          <p id={errorId} className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Create theme
        </Button>
      </div>
    </form>
  );
}

/** Settings > Appearance: the mode, the theme list and its actions (#290, R43 to R47). */
export function AppearanceSettingsPanel() {
  const { theme: mode, setTheme, resolvedTheme } = useTheme();
  const { themes, slots } = useThemeLibrary();
  const [switchOffer, setSwitchOffer] = useState<Base | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const returnFocusTo = useRef<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const existingIds = new Set(themes.map((theme) => theme.id));

  // Focus goes back to the row's Edit button when the editor closes.
  useEffect(() => {
    const id = returnFocusTo.current;
    if (editingId !== null || id === null) return;
    returnFocusTo.current = null;
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-theme-row="${CSS.escape(id)}"] [data-theme-action="edit"]`,
      )
      ?.focus();
  }, [editingId]);

  if (editingId !== null) {
    return (
      <SettingsPageContainer>
        <ThemeEditor
          themeId={editingId}
          onClose={() => {
            returnFocusTo.current = editingId;
            setEditingId(null);
          }}
        />
      </SettingsPageContainer>
    );
  }

  const use = (theme: ThemeFile) => {
    const result = setSlot(theme.base, theme.id);
    if (!result.ok) return setActionError("Could not save the theme choice.");
    setActionError(null);
    setSwitchOffer(theme.base === resolvedTheme ? null : theme.base);
  };
  const duplicate = (theme: ThemeFile) => {
    try {
      duplicateTheme(theme.id);
      setActionError(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not duplicate the theme.");
    }
  };
  const remove = (theme: ThemeFile) => {
    const result = deleteCustomTheme(theme.id);
    setConfirmingDelete(null);
    setActionError(result.ok ? null : "Could not delete the theme.");
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Appearance">
        <SettingsRow
          title="Mode"
          description="System follows your operating system. Each mode uses the theme picked for it."
          control={
            <div role="group" aria-label="Mode" className="flex gap-1">
              {MODE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  size="sm"
                  variant={mode === option.value ? "secondary" : "ghost"}
                  aria-pressed={mode === option.value}
                  onClick={() => {
                    setTheme(option.value);
                    setSwitchOffer(null);
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Themes"
        headerAction={
          <div className="flex gap-1">
            <Button size="xs" variant="ghost" onClick={() => setImporting(true)}>
              Import theme
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setCreating(true)}>
              New theme
            </Button>
          </div>
        }
      >
        <div className="grid gap-3 p-3">
          {switchOffer ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 text-sm"
            >
              <span>This theme is used in {BASE_LABEL[switchOffer].toLowerCase()} mode.</span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setTheme(switchOffer);
                  setSwitchOffer(null);
                }}
              >
                {`Switch to ${switchOffer} now`}
              </Button>
            </div>
          ) : null}
          {actionError ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {actionError}
            </p>
          ) : null}
          {creating ? (
            <NewThemeForm
              existingIds={existingIds}
              onCancel={() => setCreating(false)}
              onCreated={(id) => {
                setCreating(false);
                setEditingId(id);
              }}
            />
          ) : null}
          <ul ref={listRef} className="grid gap-1">
            {themes.map((theme) => {
              const custom = !isBuiltinThemeId(theme.id);
              const inUse = slots[theme.base] === theme.id;
              return (
                <li
                  key={theme.id}
                  data-theme-row={theme.id}
                  className="flex flex-wrap items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40"
                >
                  <ThemePreview theme={theme} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{theme.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {subtitleOf(theme)} · {BASE_LABEL[theme.base]} base
                      {inUse ? ` · In use for ${theme.base}` : ""}
                    </p>
                  </div>
                  {confirmingDelete === theme.id ? (
                    <div
                      role="group"
                      aria-label={`Delete ${theme.name}?`}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span>{`Delete ${theme.name}?`}</span>
                      <Button size="xs" variant="ghost" onClick={() => setConfirmingDelete(null)}>
                        Cancel
                      </Button>
                      <Button size="xs" variant="destructive" onClick={() => remove(theme)}>
                        Delete theme
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1">
                      {inUse ? null : (
                        <Button
                          size="xs"
                          variant="outline"
                          aria-label={`Use ${theme.name} for ${theme.base}`}
                          onClick={() => use(theme)}
                        >
                          {`Use for ${theme.base}`}
                        </Button>
                      )}
                      {custom ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          data-theme-action="edit"
                          aria-label={`Edit ${theme.name}`}
                          onClick={() => setEditingId(theme.id)}
                        >
                          Edit
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant="ghost"
                        data-theme-action="duplicate"
                        aria-label={`Duplicate ${theme.name}`}
                        onClick={() => duplicate(theme)}
                      >
                        Duplicate
                      </Button>
                      {custom ? (
                        <>
                          <Button
                            size="xs"
                            variant="ghost"
                            data-theme-action="export"
                            aria-label={`Export ${theme.name}`}
                            onClick={() => downloadTheme(theme)}
                          >
                            Export
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            data-theme-action="delete"
                            aria-label={`Delete ${theme.name}`}
                            onClick={() => setConfirmingDelete(theme.id)}
                          >
                            Delete
                          </Button>
                        </>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">
            Running terminals keep the colors they started with. New terminals use the theme.
          </p>
        </div>
      </SettingsSection>
      <ThemeImportDialog open={importing} onOpenChange={setImporting} />
    </SettingsPageContainer>
  );
}
