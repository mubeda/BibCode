import { useAtomValue } from "@effect/atom-react";
import { ProviderDriverKind, type ServerTool } from "@bibcode/contracts";
import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { primaryServerToolsAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { toolRowView } from "./toolsSection.logic";

const TONE_CLASS = {
  neutral: "text-muted-foreground",
  warning: "text-warning",
  success: "text-success",
  error: "text-destructive",
} as const;

function ToolRow({ tool }: { readonly tool: ServerTool }) {
  const primaryEnvironment = usePrimaryEnvironment();
  const updateTool = useAtomCommand(serverEnvironment.updateProvider, { reportFailure: false });
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const view = toolRowView(tool);
  const update = async () => {
    if (primaryEnvironment === null) return;
    setRequestError(null);
    setRequesting(true);
    try {
      const result = await updateTool({
        environmentId: primaryEnvironment.environmentId,
        input: { provider: ProviderDriverKind.make(tool.toolId) },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        const reason =
          error instanceof Error && "reason" in error && typeof error.reason === "string"
            ? error.reason
            : null;
        setRequestError(reason ?? `${tool.displayName} could not be updated. Try again.`);
      }
    } finally {
      setRequesting(false);
    }
  };
  const busy = view.updating || requesting;
  const description =
    view.disabledReason === null ? view.description : `${view.description} ${view.disabledReason}`;
  return (
    <SettingsRow
      title={tool.displayName}
      description={<span className={cn(TONE_CLASS[view.tone])}>{description}</span>}
      status={
        requestError === null && view.warning === null ? null : (
          <>
            {view.warning === null ? null : <p>{view.warning}</p>}
            {requestError === null ? null : <p className="text-destructive">{requestError}</p>}
          </>
        )
      }
      control={
        view.canUpdate || busy ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !view.canUpdate}
            onClick={() => void update()}
          >
            {busy ? <Spinner className="size-3" /> : null}
            {busy ? "Updating…" : "Update"}
          </Button>
        ) : null
      }
    />
  );
}

/**
 * The command-line tools BiBCode keeps up to date besides providers (CodeGraph): what is
 * installed, what is available and, when BiBCode will not update one, how to do it by hand.
 * Absent on a server older than tool maintenance, which reports no tools.
 */
export function ToolsSection() {
  const tools = useAtomValue(primaryServerToolsAtom);
  if (tools === undefined || tools.length === 0) {
    return null;
  }
  return (
    <SettingsSection title="Tools">
      {tools.map((tool) => (
        <ToolRow key={tool.toolId} tool={tool} />
      ))}
    </SettingsSection>
  );
}
