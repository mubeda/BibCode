import type { DesktopBridge, DesktopLinuxSoftwareRenderingState } from "@bibcode/contracts";
import { useEffect, useId, useState } from "react";

import { isLinuxPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export type LinuxRenderingBridge = Pick<
  DesktopBridge,
  "getLinuxSoftwareRendering" | "setLinuxSoftwareRendering" | "restartApp"
>;

const TITLE = "Disable GPU compositing";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Linux desktop setting from issue #411; renders nothing elsewhere. */
export function LinuxRenderingSection({
  bridge = typeof window === "undefined" ? undefined : window.desktopBridge,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
}: {
  readonly bridge?: LinuxRenderingBridge | undefined;
  readonly platform?: string;
}) {
  const getState = bridge?.getLinuxSoftwareRendering;
  const setState = bridge?.setLinuxSoftwareRendering;
  if (!isLinuxPlatform(platform) || getState === undefined || setState === undefined) return null;
  return (
    <LinuxRenderingRow getState={getState} setState={setState} restartApp={bridge?.restartApp} />
  );
}

function LinuxRenderingRow({
  getState,
  setState,
  restartApp,
}: {
  readonly getState: () => Promise<DesktopLinuxSoftwareRenderingState>;
  readonly setState: (enabled: boolean) => Promise<DesktopLinuxSoftwareRenderingState>;
  readonly restartApp: (() => Promise<void>) | undefined;
}) {
  const [state, setLocalState] = useState<DesktopLinuxSoftwareRenderingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const overrideId = useId();

  useEffect(() => {
    let cancelled = false;
    getState().then(
      (next) => {
        if (!cancelled) setLocalState(next);
      },
      (cause: unknown) => {
        if (!cancelled) setError(`Could not read the setting: ${errorMessage(cause)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [getState]);

  const save = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      setLocalState(await setState(enabled));
    } catch (cause) {
      setError(
        `Could not save the setting, so nothing changed. Check that BiBCode's data folder can be written, then try again. (${errorMessage(cause)})`,
      );
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    try {
      await restartApp?.();
    } catch (cause) {
      setError(`Could not restart BiBCode: ${errorMessage(cause)}`);
    }
  };

  const overrideLine =
    state?.override == null ? null : (
      <p id={overrideId}>
        <span className="font-mono">
          BIBCODE_SOFTWARE_RENDERING={state.override === "on" ? "1" : "0"}
        </span>{" "}
        is set where BiBCode was started, so it decides this. Remove it from your environment or
        launcher to use this switch.
      </p>
    );

  return (
    <SettingsSection title="Rendering">
      <SettingsRow
        title={TITLE}
        description="Turn this on only if BiBCode freezes or ends your desktop session. The window is then drawn by the CPU, which can be slower."
        status={
          state === null && error === null ? null : (
            <div className="space-y-1">
              {state === null ? null : (
                <p>
                  {state.gpuCompositingDisabled
                    ? "GPU compositing is off in this session."
                    : "GPU compositing is on in this session."}
                </p>
              )}
              {overrideLine}
              {state?.restartApplies ? (
                restartApp === undefined ? (
                  <p>Quit and reopen BiBCode to apply this change.</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <p>Restart BiBCode to apply this change.</p>
                    <Button size="xs" variant="outline" onClick={() => void restart()}>
                      Restart now
                    </Button>
                  </div>
                )
              ) : null}
              {error === null ? null : (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              )}
            </div>
          )
        }
        control={
          <Switch
            checked={state?.enabled ?? false}
            disabled={state === null || state.override !== null || saving}
            onCheckedChange={(checked) => void save(checked)}
            aria-label={TITLE}
            aria-describedby={overrideLine === null ? undefined : overrideId}
          />
        }
      />
    </SettingsSection>
  );
}
