interface DesktopUiApplicationHost {
  readonly __TAURI__?: {
    readonly core?: {
      readonly invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
}

function desktopUiSpecFileName(path: string): string | undefined {
  return path.replaceAll("\\", "/").split(/[?#]/, 1)[0]?.split("/").at(-1);
}

export function isFinalDesktopUiSpec(
  currentSpecs: ReadonlyArray<string>,
  configuredSpecs: ReadonlyArray<string>,
): boolean {
  const finalSpec = configuredSpecs.at(-1);
  if (finalSpec === undefined) return false;
  const finalSpecFileName = desktopUiSpecFileName(finalSpec);
  return currentSpecs.some((spec) => desktopUiSpecFileName(spec) === finalSpecFileName);
}

export async function dispatchDesktopUiApplicationExit(
  host: DesktopUiApplicationHost = window as unknown as DesktopUiApplicationHost,
): Promise<boolean> {
  const invoke = host.__TAURI__?.core?.invoke;
  if (invoke === undefined) return false;

  await invoke("desktop_e2e_prepare_for_exit");
  void invoke("plugin:window|close", { label: "main" }).catch(() => undefined);
  return true;
}

export async function requestDesktopUiApplicationExit(): Promise<void> {
  const requested = await browser.execute(
    dispatchDesktopUiApplicationExit as () => Promise<boolean>,
  );
  if (!requested) {
    throw new Error("The Tauri bridge was unavailable during desktop UI application shutdown.");
  }
}
