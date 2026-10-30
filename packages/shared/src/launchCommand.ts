/**
 * Builds the command a person copies to start an MCP relay (`<bibcode> mcp …`, #139) from the
 * argv the server reports, quoted for the shell that will run it. No part is guessed: the
 * server names its executable, data root and dev state, and the caller names any WSL or SSH
 * wrapper it knows.
 */

export type LaunchShell = "posix" | "windows";

const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One argument for a POSIX shell (sh, bash, zsh): bare when safe, else single-quoted. */
export function quotePosixArgument(argument: string): string {
  if (argument.length > 0 && POSIX_SAFE.test(argument)) return argument;
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

/**
 * One argument as Windows programs parse their command line (`CommandLineToArgvW`): bare when
 * it has no space, tab or quote, else double-quoted with backslashes before a quote, and at
 * the end, doubled.
 */
export function quoteWindowsArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += "\\".repeat(backslashes) + character;
    }
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function joinCommand(argv: ReadonlyArray<string>, shell: LaunchShell): string {
  const quote = shell === "posix" ? quotePosixArgument : quoteWindowsArgument;
  return argv.map(quote).join(" ");
}

export interface SshLaunchTarget {
  readonly alias: string;
  readonly username: string | null;
  readonly port: number | null;
}

/**
 * `ssh [-p <port>] [<user>@]<alias> -- <command>`: the remote part is quoted for the remote
 * POSIX shell, then the whole for the shell on this computer.
 */
export function sshLaunchArgv(
  target: SshLaunchTarget,
  remoteArgv: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const destination =
    target.username === null ? target.alias : `${target.username}@${target.alias}`;
  return [
    "ssh",
    ...(target.port === null ? [] : ["-p", String(target.port)]),
    destination,
    "--",
    joinCommand(remoteArgv, "posix"),
  ];
}

/** `wsl.exe -d <distro> --exec <command>`: the distribution's binary and root, as launched. */
export function wslLaunchArgv(distro: string, argv: ReadonlyArray<string>): ReadonlyArray<string> {
  return ["wsl.exe", "-d", distro, "--exec", ...argv];
}

/** The agent registration commands, for the harness's own CLI. */
export function agentRegistrationCommand(agent: "claude" | "codex", launch: string): string {
  return `${agent} mcp add bibcode -- ${launch}`;
}
