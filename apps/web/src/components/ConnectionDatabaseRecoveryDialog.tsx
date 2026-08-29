import { useState, useSyncExternalStore } from "react";

import {
  deleteIncompatibleConnectionDatabase,
  getConnectionDatabaseHealth,
  subscribeConnectionDatabaseHealth,
} from "../connection/databaseHealth";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const DELETED_DATA = [
  "Saved remote servers and connection profiles",
  "Connection credentials and remote DPoP tokens",
  "Accepted storage identities",
  "Cached environment shell state",
  "Cached thread state",
] as const;

interface ConnectionDatabaseRecoveryDialogProps {
  readonly deleteDatabase?: typeof deleteIncompatibleConnectionDatabase;
  readonly reloadPage?: () => void;
  readonly copyText?: (text: string) => Promise<void>;
}

const reloadCurrentPage = () => window.location.reload();
const writeClipboardText = (text: string) => navigator.clipboard.writeText(text);

export function ConnectionDatabaseRecoveryDialog({
  deleteDatabase = deleteIncompatibleConnectionDatabase,
  reloadPage = reloadCurrentPage,
  copyText = writeClipboardText,
}: ConnectionDatabaseRecoveryDialogProps = {}) {
  const health = useSyncExternalStore(
    subscribeConnectionDatabaseHealth,
    getConnectionDatabaseHealth,
    getConnectionDatabaseHealth,
  );
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = health.status !== "ready";

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await deleteDatabase();
      if (result === "blocked") {
        setError("Reset is blocked. Close other BiBCode tabs and windows, then try again.");
        return;
      }
      reloadPage();
    } catch (cause) {
      setError(`The connection database could not be deleted: ${String(cause)}`);
    } finally {
      setBusy(false);
    }
  };
  const copyDiagnostics = async () => {
    setError(null);
    try {
      await copyText(
        `BiBCode connection database status: ${health.status}\n${health.message ?? "No detail"}`,
      );
    } catch (cause) {
      setError(`Could not copy diagnostics: ${String(cause)}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogPopup showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {health.status === "incompatible"
              ? "Connection database needs reset"
              : health.status === "blocked"
                ? "Connection database is blocked"
                : "Connection storage is unavailable"}
          </DialogTitle>
          <DialogDescription>
            {health.status === "incompatible"
              ? "This browser cannot open connection data written by a newer BiBCode version."
              : health.message}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4 text-sm">
          {health.status === "incompatible" ? (
            <>
              <p>Resetting deletes only this browser&apos;s connection-runtime data:</p>
              <ul className="list-disc space-y-1 pl-5">
                {DELETED_DATA.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                Server-side project files and databases are not changed.
              </p>
              {confirmReset ? (
                <div className="rounded border border-amber-500 p-3">
                  Confirm deletion of all saved browser connection data. This cannot be undone.
                </div>
              ) : null}
            </>
          ) : health.status === "blocked" ? (
            <p>Close other BiBCode tabs or windows using this browser profile, then reload.</p>
          ) : (
            <p>Reload to retry. If the problem continues, copy diagnostics before reporting it.</p>
          )}
          {error ? <p className="text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          {health.status === "incompatible" ? (
            confirmReset ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => setConfirmReset(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => void reset()}>
                  {busy ? "Deleting…" : "Confirm reset"}
                </Button>
              </>
            ) : (
              <Button variant="destructive" onClick={() => setConfirmReset(true)}>
                Reset saved connection data
              </Button>
            )
          ) : (
            <>
              {health.status === "unavailable" ? (
                <Button variant="outline" onClick={() => void copyDiagnostics()}>
                  Copy diagnostics
                </Button>
              ) : null}
              <Button onClick={reloadPage}>Reload</Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
