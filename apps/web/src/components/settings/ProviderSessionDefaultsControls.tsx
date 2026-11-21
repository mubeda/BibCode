import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ProviderDriverKind,
  type ProviderSessionDefault,
  type ServerProviderModel,
} from "@bibcode/contracts";
import { useEffect, useId, useRef, useState } from "react";
import {
  getProviderSessionDefaultControls,
  type ProviderSessionDefaultChange,
  updateProviderSessionDefault,
} from "@bibcode/shared/providerSessionDefaults";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

interface ProviderSessionDefaultsControlsProps {
  readonly driver: ProviderDriverKind;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly value: ProviderSessionDefault | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: ProviderSessionDefault) => void;
}

export function ProviderSessionDefaultsControls({
  driver,
  models,
  value,
  disabled,
  onChange,
}: ProviderSessionDefaultsControlsProps) {
  const idPrefix = useId();
  const [modelLabelsByDriver, setModelLabelsByDriver] = useState<
    ReadonlyMap<ProviderDriverKind, ReadonlyMap<string, string>>
  >(() => new Map());
  const latestValueRef = useRef(value);
  const modelId = `${idPrefix}-model`;
  const effortId = `${idPrefix}-effort`;
  const fastModeId = `${idPrefix}-fast-mode`;
  const controls = getProviderSessionDefaultControls({
    driver,
    models,
    ...(value ? { configuredDefault: value } : {}),
  });
  const modelSupported = models.length > 0;
  const modelDisabled = disabled || !modelSupported;
  const effortSupported = controls.effortDescriptor !== null;
  const selectedModel = controls.modelAvailable ? controls.resolvedModel : controls.configuredModel;
  const selectedServerModel = models.find((model) => model.slug === selectedModel);
  const selectedModelSlug = selectedServerModel?.slug;
  const selectedModelName = selectedServerModel?.name;
  // Remember the selected model's name so the trigger keeps it while the model list changes.
  if (
    selectedModelSlug !== undefined &&
    selectedModelName !== undefined &&
    modelLabelsByDriver.get(driver)?.get(selectedModelSlug) !== selectedModelName
  ) {
    const modelLabels = new Map(modelLabelsByDriver.get(driver));
    modelLabels.set(selectedModelSlug, selectedModelName);
    setModelLabelsByDriver(new Map(modelLabelsByDriver).set(driver, modelLabels));
  }
  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);
  // A driver with no built-in default model (Antigravity) starts on the CLI's own model until
  // the user saves one; the shared fallback would otherwise name another vendor's model.
  const cliPicksModel =
    value === undefined && !modelSupported && DEFAULT_MODEL_BY_PROVIDER[driver] === undefined;
  const modelLabel = cliPicksModel
    ? "CLI default"
    : (selectedServerModel?.name ??
      modelLabelsByDriver.get(driver)?.get(selectedModel) ??
      selectedModel);

  const change = (next: ProviderSessionDefaultChange) => {
    const latestValue = latestValueRef.current;
    const updatedValue = updateProviderSessionDefault({
      driver,
      models,
      change: next,
      ...(latestValue ? { current: latestValue } : {}),
    });
    latestValueRef.current = updatedValue;
    onChange(updatedValue);
  };

  return (
    <div
      className="grid gap-3 pt-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] sm:items-end"
      data-testid="provider-session-defaults"
    >
      <div className="min-w-0 space-y-1">
        <label className="text-sm font-medium" htmlFor={modelId}>
          Default model
        </label>
        <Select
          disabled={modelDisabled}
          value={selectedModel}
          onValueChange={(next) => {
            if (next) change({ type: "model", value: next });
          }}
        >
          <SelectTrigger aria-label="Default model" id={modelId}>
            <SelectValue>{modelLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {!controls.modelAvailable && !cliPicksModel ? (
              <SelectItem disabled value={controls.configuredModel}>
                {controls.configuredModel}
              </SelectItem>
            ) : null}
            {models.map((model) => (
              <SelectItem key={model.slug} value={model.slug} label={model.name}>
                <span className="block">{model.name}</span>
                {model.description ? (
                  <span className="block text-xs text-muted-foreground">{model.description}</span>
                ) : null}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {!controls.modelAvailable && !cliPicksModel ? (
          <p className="text-muted-foreground text-xs">
            {/* The Antigravity Terminal passes the saved model unchanged (spec R12). */}
            {driver === "antigravity"
              ? `Not in the current model list. New chats use ${controls.resolvedModel}. The terminal still starts with ${controls.configuredModel}.`
              : `Unavailable here; new sessions will use ${controls.resolvedModel}.`}
          </p>
        ) : null}
      </div>

      <div className="min-w-0 space-y-1">
        <label className="text-sm font-medium" htmlFor={effortId}>
          Default effort
        </label>
        <Select
          disabled={disabled || !effortSupported}
          value={controls.effort ?? undefined}
          onValueChange={(next) => {
            if (effortSupported && next) change({ type: "effort", value: next });
          }}
        >
          <SelectTrigger aria-label="Default effort" id={effortId}>
            <SelectValue>{effortSupported ? undefined : "Not supported"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {controls.effortDescriptor?.options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div className="flex min-h-9 items-center gap-2 sm:pb-0.5">
        <label className="text-sm font-medium" htmlFor={fastModeId}>
          Fast by default
        </label>
        <Switch
          aria-label="Fast by default"
          checked={controls.fastModeSupported ? (controls.fastMode ?? false) : false}
          disabled={disabled || !controls.fastModeSupported}
          id={fastModeId}
          onCheckedChange={(next) => {
            if (controls.fastModeSupported) {
              change({ type: "fastMode", value: Boolean(next) });
            }
          }}
        />
      </div>
    </div>
  );
}

export type { ProviderSessionDefaultsControlsProps };
