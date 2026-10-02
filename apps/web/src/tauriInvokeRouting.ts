export type TauriCommandArguments = Record<string, unknown> | ArrayBuffer | Uint8Array | undefined;
export interface TauriCommandOptions {
  readonly headers: Record<string, string>;
}
export type TauriCommandInvoker = (
  command: string,
  args: TauriCommandArguments,
  options?: TauriCommandOptions,
) => Promise<unknown>;
export type TauriCommandMock = (
  args: TauriCommandArguments,
  options?: TauriCommandOptions,
) => unknown;

export interface InvokeTauriCommandInput {
  readonly command: string;
  readonly args?: TauriCommandArguments;
  readonly options?: TauriCommandOptions;
  readonly e2eMock?: TauriCommandMock;
  readonly globalInvoke?: TauriCommandInvoker;
  readonly importedInvoke: TauriCommandInvoker;
}

export async function invokeTauriCommand<T>(input: InvokeTauriCommandInput): Promise<T> {
  if (input.e2eMock) {
    return (await (input.options === undefined
      ? input.e2eMock(input.args)
      : input.e2eMock(input.args, input.options))) as T;
  }
  const invoke = input.globalInvoke ?? input.importedInvoke;
  return (await (input.options === undefined
    ? invoke(input.command, input.args)
    : invoke(input.command, input.args, input.options))) as T;
}
