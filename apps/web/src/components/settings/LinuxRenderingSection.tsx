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
  const [restarting, setRestarting] = useState(false);
  const overrideId = useId();
  const userVariablesId = useId();
  const errorId = useId();

  useEffect(() => {
    let cancelled = false;
    getState().then(
      (next) => {
        if (!cancelled) setLocalState(next);
      },
      (cause: unknown) => {
        if (!cancelled)
          setError(
            `Could not read the setting. Fix or remove desktop-settings.json in BiBCode's data folder, then reopen Settings. (${errorMessage(cause)})`,
          );
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
    if (restarting) return;
    setRestarting(true);
    setError(null);
    try {
      await restartApp?.();
    } catch (cause) {
      setError(
        `Could not restart BiBCode. Quit and reopen BiBCode to apply this change. (${errorMessage(cause)})`,
      );
      setRestarting(false);
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

  const userVariables = state?.userVariables ?? [];
  const userVariablesLine =
    userVariables.length === 0 ? null : (
      <p id={userVariablesId}>
        <span className="font-mono">
          {userVariables.map(({ name, value }) => `${name}=${value}`).join(" ")}
        </span>{" "}
        {userVariables.length === 1
          ? "is set where BiBCode was started, so this switch cannot change it. Remove it from your environment or launcher to let this switch decide."
          : "are set where BiBCode was started, so this switch cannot change them. Remove them from your environment or launcher to let this switch decide."}
      </p>
    );
  const describedBy =
    [overrideLine && overrideId, userVariablesLine && userVariablesId, error && errorId]
      .filter(Boolean)
      .join(" ") || undefined;

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
                    ? "This launch asks WebKit to draw without GPU compositing."
                    : "This launch does not ask WebKit to turn off GPU compositing."}
                </p>
              )}
              {overrideLine}
              {userVariablesLine}
              {state?.restartApplies ? (
                restartApp === undefined ? (
                  <p>Quit and reopen BiBCode to apply this change.</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <p>Restart BiBCode to apply this change.</p>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={saving || restarting}
                      onClick={() => void restart()}
                    >
                      {restarting ? "Restarting…" : "Restart now"}
                    </Button>
                  </div>
                )
              ) : null}
              {error === null ? null : (
                <p id={errorId} role="alert" className="text-destructive">
                  {error}
                </p>
              )}
            </div>
          )
        }
        control={
          <Switch
            checked={state?.enabled ?? false}
            disabled={state === null || state.override !== null || saving || restarting}
            onCheckedChange={(checked) => void save(checked)}
            aria-label={TITLE}
            aria-describedby={describedBy}
          />
        }
      />
    </SettingsSection>
  );
}
