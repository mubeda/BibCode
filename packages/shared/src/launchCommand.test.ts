import { describe, expect, it } from "vite-plus/test";

import {
  agentRegistrationCommand,
  joinCommand,
  quotePosixArgument,
  quoteWindowsArgument,
  sshLaunchArgv,
  wslLaunchArgv,
} from "./launchCommand.ts";

/** What a POSIX shell's word splitting would give back, for single-quoted words. */
function unquotePosix(command: string): ReadonlyArray<string> {
  const words: Array<string> = [];
  let word = "";
  let inWord = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "'") {
      const end = command.indexOf("'", index + 1);
      word += command.slice(index + 1, end);
      index = end;
      inWord = true;
    } else if (character === "\\") {
      word += command[index + 1];
      index += 1;
      inWord = true;
    } else if (character === " ") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += character;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

describe("launch commands", () => {
  const tricky = [
    "/Applications/BiBCode.app/Contents/MacOS/bibcode",
    "mcp",
    "--base-dir",
    "/Users/a b/it's $HOME",
  ];

  it("round-trips paths with spaces, quotes and $ through a POSIX shell", () => {
    expect(unquotePosix(joinCommand(tricky, "posix"))).toEqual(tricky);
    expect(quotePosixArgument("")).toBe("''");
    expect(quotePosixArgument("plain/path-1.0")).toBe("plain/path-1.0");
  });

  it("quotes for Windows command lines", () => {
    expect(quoteWindowsArgument("C:\\Program Files\\BiBCode\\BiBCode.exe")).toBe(
      '"C:\\Program Files\\BiBCode\\BiBCode.exe"',
    );
    expect(quoteWindowsArgument('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArgument("C:\\a dir\\")).toBe('"C:\\a dir\\\\"');
    expect(quoteWindowsArgument("mcp")).toBe("mcp");
  });

  it("quotes the remote argv of an SSH command for the remote POSIX shell", () => {
    const argv = sshLaunchArgv({ alias: "box", username: "me", port: 2222 }, tricky);
    expect(argv.slice(0, 5)).toEqual(["ssh", "-p", "2222", "me@box", "--"]);
    expect(unquotePosix(argv[4 + 1]!)).toEqual(tricky);
    expect(sshLaunchArgv({ alias: "box", username: null, port: null }, ["bibcode", "mcp"])).toEqual(
      ["ssh", "box", "--", "bibcode mcp"],
    );
  });

  it("runs a WSL environment's own binary and root in its distribution", () => {
    expect(
      wslLaunchArgv("Ubuntu", ["/usr/bin/bibcode", "mcp", "--base-dir", "/home/me/.bibcode"]),
    ).toEqual([
      "wsl.exe",
      "-d",
      "Ubuntu",
      "--exec",
      "/usr/bin/bibcode",
      "mcp",
      "--base-dir",
      "/home/me/.bibcode",
    ]);
  });

  it("registers the command with Claude Code and Codex", () => {
    expect(agentRegistrationCommand("claude", "bibcode mcp")).toBe(
      "claude mcp add bibcode -- bibcode mcp",
    );
    expect(agentRegistrationCommand("codex", "bibcode mcp")).toBe(
      "codex mcp add bibcode -- bibcode mcp",
    );
  });
});
