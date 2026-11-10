import type { ThemeFile } from "@bibcode/contracts";
import { CheckIcon, EllipsisIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

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
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
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
async function downloadTheme(theme: ThemeFile) {
  const suggestedName = `${theme.id}.theme.json`;
  const saveTextFile = window.desktopBridge?.saveTextFile;
  // The desktop webview cancels blob downloads, so the native Save dialog writes the file.
  if (saveTextFile) {
    try {
      await saveTextFile({ suggestedName, contents: exportThemeJson(theme) });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not export ${theme.name}`,
        description: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([exportThemeJson(theme)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.click();
  // Revoked after the click is handled; WebKit can drop a download whose URL is revoked at once.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const GROUPS = [
  { base: "light", label: "Light themes" },
  { base: "dark", label: "Dark themes" },
] as const;

function moveRowFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-theme-select]")];
  const index = rows.indexOf(event.target as HTMLElement);
  if (index < 0) return;
  event.preventDefault();
  const step = event.key === "ArrowDown" ? 1 : -1;
  rows[(index + step + rows.length) % rows.length]?.focus();
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
          className="size-3.5 sm:size-5"
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
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const returnFocusTo = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const existingIds = new Set(themes.map((theme) => theme.id));

  // Focus goes back to the row's menu button, where Edit was chosen, when the editor closes.
  useEffect(() => {
    const id = returnFocusTo.current;
    if (editingId !== null || id === null) return;
    returnFocusTo.current = null;
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-theme-row="${CSS.escape(id)}"] [data-theme-action="more"]`,
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

  // R40: a row puts its theme in its base's slot and shows it, switching the mode if needed.
  const apply = (theme: ThemeFile) => {
    const previous = { mode, slot: slots[theme.base] };
    const result = setSlot(theme.base, theme.id);
    if (!result.ok) return setActionError("Could not save the theme choice.");
    setActionError(null);
    if (theme.base === resolvedTheme) return;
    setTheme(theme.base);
    const toastId = toastManager.add({
      type: "info",
      title: `Switched to ${theme.base} mode to show ${theme.name}`,
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(toastId);
          setSlot(theme.base, previous.slot);
          setTheme(previous.mode);
        },
      },
    });
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
                  onClick={() => setTheme(option.value)}
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
          {/* Arrow keys move between rows; Enter and Space click the focused row's button. */}
          <div ref={listRef} className="grid gap-4" onKeyDown={moveRowFocus}>
            {GROUPS.map(({ base, label }) => (
              <div key={base} role="group" aria-label={label} className="grid gap-1.5">
                <div className="flex items-center gap-2 px-1">
                  <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
                  {resolvedTheme === base ? (
                    <span className="rounded-sm border border-border px-1.5 text-xs text-foreground">
                      Showing now
                    </span>
                  ) : null}
                </div>
                <ul className="grid gap-1">
                  {themes
                    .filter((theme) => theme.base === base)
                    .map((theme) => {
                      const custom = !isBuiltinThemeId(theme.id);
                      const inUse = slots[base] === theme.id;
                      return (
                        <li
                          key={theme.id}
                          data-theme-row={theme.id}
                          className="flex flex-wrap items-center gap-1"
                        >
                          <button
                            type="button"
                            data-theme-select
                            aria-pressed={inUse}
                            onClick={() => apply(theme)}
                            className={cn(
                              "flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2 py-2 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
                              inUse ? "border-primary bg-accent/30" : "border-transparent",
                            )}
                          >
                            <ThemePreview theme={theme} />
                            <span className="min-w-24 flex-1">
                              <span className="block text-sm font-medium text-foreground">
                                {theme.name}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {subtitleOf(theme)}
                              </span>
                            </span>
                            {inUse ? (
                              <span className="ms-auto flex shrink-0 items-center gap-1 text-xs font-medium text-foreground">
                                <CheckIcon
                                  aria-hidden
                                  data-theme-in-use-icon
                                  className="size-4 text-primary"
                                />
                                In use
                              </span>
                            ) : null}
                          </button>
                          <Menu>
                            <MenuTrigger
                              render={
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  data-theme-action="more"
                                  aria-label={`More actions for ${theme.name}`}
                                />
                              }
                            >
                              <EllipsisIcon aria-hidden className="size-4" />
                            </MenuTrigger>
                            {/* After Delete, focus goes to the confirmation's Cancel. */}
                            <MenuPopup
                              align="end"
                              finalFocus={() =>
                                listRef.current?.querySelector<HTMLElement>(
                                  `[data-theme-row="${CSS.escape(theme.id)}"] [data-delete-cancel]`,
                                ) ?? true
                              }
                            >
                              {custom ? (
                                <MenuItem
                                  data-theme-action="edit"
                                  onClick={() => setEditingId(theme.id)}
                                >
                                  Edit
                                </MenuItem>
                              ) : null}
                              <MenuItem
                                data-theme-action="duplicate"
                                onClick={() => duplicate(theme)}
                              >
                                Duplicate
                              </MenuItem>
                              {custom ? (
                                <>
                                  <MenuItem
                                    data-theme-action="export"
                                    onClick={() => void downloadTheme(theme)}
                                  >
                                    Export
                                  </MenuItem>
                                  <MenuItem
                                    data-theme-action="delete"
                                    variant="destructive"
                                    onClick={() => setConfirmingDelete(theme.id)}
                                  >
                                    Delete
                                  </MenuItem>
                                </>
                              ) : null}
                            </MenuPopup>
                          </Menu>
                          {confirmingDelete === theme.id ? (
                            <div
                              role="group"
                              aria-label={`Delete ${theme.name}?`}
                              className="flex basis-full flex-wrap items-center justify-end gap-2 px-2 pb-1 text-sm"
                            >
                              <span>{`Delete ${theme.name}?`}</span>
                              <Button
                                size="xs"
                                variant="ghost"
                                data-delete-cancel
                                onClick={() => setConfirmingDelete(null)}
                              >
                                Cancel
                              </Button>
                              <Button size="xs" variant="destructive" onClick={() => remove(theme)}>
                                Delete theme
                              </Button>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                </ul>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Running terminals keep the colors they started with. New terminals use the theme.
          </p>
        </div>
      </SettingsSection>
      <ThemeImportDialog open={importing} onOpenChange={setImporting} />
    </SettingsPageContainer>
  );
}
