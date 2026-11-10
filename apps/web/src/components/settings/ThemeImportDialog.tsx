import type { ThemeFile } from "@bibcode/contracts";
import { useId, useState } from "react";

import { MAX_THEME_FILE_BYTES } from "../../themes/themeValidation";
import { commitThemeImport, planThemeImport, type ImportPlan } from "../../themes/themeTransfer";
import type { FixedPair } from "../../themes/themeColor";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

type Imported = { theme: ThemeFile; resetPairs: FixedPair[] };

/**
 * Imports a theme from a `.json` file or pasted JSON (#290, R53, R55). Validate lists every
 * field error and stores nothing; an id conflict asks Replace or Keep both before storing.
 */
export function ThemeImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const textId = useId();
  const fileId = useId();
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [imported, setImported] = useState<Imported | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const reset = () => {
    setText("");
    setPlan(null);
    setImported(null);
    setSaveError(null);
  };
  // Every way out (Done, Cancel, Escape, the close button) leaves the next opening empty.
  const close = () => {
    reset();
    onOpenChange(false);
  };
  const changeText = (next: string) => {
    setText(next);
    setPlan(null);
    setSaveError(null);
  };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    // Larger files are refused by size; reading only one byte past the limit keeps that cheap.
    changeText(await file.slice(0, MAX_THEME_FILE_BYTES + 1).text());
  };
  const commit = (choice: "replace" | "keep-both") => {
    if (!plan?.ok) return;
    try {
      setImported({ theme: commitThemeImport(plan, choice), resetPairs: plan.resetPairs });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not save the theme.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Import theme</DialogTitle>
          <DialogDescription>Choose a .json theme file or paste its contents.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-3">
          {imported ? (
            <div role="status" className="grid gap-1 text-sm">
              <p>{`Imported ${imported.theme.name}.`}</p>
              {imported.resetPairs.length > 0 ? (
                <p>
                  {`These pairs were too hard to read and now use the base theme's colors: ${imported.resetPairs
                    .map((pair) => pair.label)
                    .join(", ")}.`}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <label htmlFor={fileId} className="text-sm font-medium text-foreground">
                  Theme file
                </label>
                <input
                  id={fileId}
                  type="file"
                  accept=".json,application/json"
                  className="text-sm text-muted-foreground file:me-3 file:rounded-md file:border file:border-input file:bg-transparent file:px-2 file:py-1 file:text-sm file:text-foreground"
                  onChange={(event) => void readFile(event.currentTarget.files?.[0])}
                />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor={textId} className="text-sm font-medium text-foreground">
                  Theme JSON
                </label>
                <Textarea
                  id={textId}
                  className="font-mono"
                  rows={8}
                  spellCheck={false}
                  value={text}
                  onChange={(event) => changeText(event.currentTarget.value)}
                />
              </div>
              {plan && !plan.ok ? (
                <div role="alert" className="grid gap-1 text-sm">
                  <p className="font-medium text-destructive-foreground">
                    Fix these problems, then validate again. Nothing was imported.
                  </p>
                  <ul className="grid gap-0.5">
                    {plan.errors.map((error) => (
                      <li key={`${error.field}:${error.message}`} data-import-error>
                        <span className="font-mono">{error.field}</span>
                        {`: ${error.message}`}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {plan?.ok ? (
                <p className="text-sm">
                  {plan.conflict
                    ? `A theme with the id ${plan.theme.id} already exists. Replace it, or keep both.`
                    : `${plan.theme.name} is ready to import.`}
                </p>
              ) : null}
              {saveError ? (
                <p role="alert" className="text-sm text-destructive-foreground">
                  {saveError}
                </p>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          {imported ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              {plan?.ok && plan.conflict ? (
                <>
                  <Button variant="outline" onClick={() => commit("keep-both")}>
                    Keep both
                  </Button>
                  <Button onClick={() => commit("replace")}>Replace</Button>
                </>
              ) : plan?.ok ? (
                <Button onClick={() => commit("replace")}>Import</Button>
              ) : (
                <Button onClick={() => setPlan(planThemeImport(text))}>Validate</Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
