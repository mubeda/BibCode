// @effect-diagnostics nodeBuiltinImport:off - CI-only exact-child OS operations with private bounded stdout/stderr and joined cleanup.
// @effect-diagnostics globalTimers:off - Every child timeout terminates and awaits that same child.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

export class NativeFollowupCommandOwner {
  readonly processes: {
    executableSha256: string;
    closed: boolean;
    timeout: boolean;
    outputBounded: boolean;
  }[] = [];
  private readonly executablePins = new Map<string, { identity: string; sha256: string }>();
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fixture: string;
  private readonly unsafe: () => void;
  private readonly platform: string;
  constructor(
    environment: NodeJS.ProcessEnv,
    fixture: string,
    unsafe: () => void,
    platform = "linux",
  ) {
    this.environment = environment;
    this.fixture = fixture;
    this.unsafe = unsafe;
    this.platform = platform;
    if (
      environment.CI !== "true" ||
      environment.GITHUB_ACTIONS !== "true" ||
      !environment.GITHUB_RUN_ID ||
      !NodePath.isAbsolute(fixture) ||
      NodeFS.realpathSync(fixture) !== fixture ||
      (platform !== "win32" && (NodeFS.statSync(fixture).mode & 0o077) !== 0)
    )
      throw new Error("Native follow-up CI owner refused.");
  }
  private verifyExecutable(path: string) {
    const resolved = NodeFS.realpathSync(path),
      stat = NodeFS.lstatSync(resolved),
      identity = [
        resolved,
        stat.dev,
        stat.ino,
        stat.mode,
        stat.size,
        stat.mtimeMs,
        stat.ctimeMs,
      ].join(":"),
      sha256 = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(resolved)).digest("hex");
    if (
      !NodePath.isAbsolute(path) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (this.platform !== "win32" && (stat.mode & 0o022) !== 0) ||
      (this.platform !== "win32" && (stat.mode & 0o111) === 0)
    )
      throw new Error("Native follow-up OS executable refused.");
    const prior = this.executablePins.get(path);
    if (prior && (prior.identity !== identity || prior.sha256 !== sha256))
      throw new Error("Native follow-up OS executable changed.");
    this.executablePins.set(path, { identity, sha256 });
    return sha256;
  }
  async command(executable: string, args: readonly string[], maxBytes = 16384): Promise<Buffer> {
    if (
      args.some((arg) => arg.includes("\0")) ||
      args.length > 32 ||
      maxBytes < 1 ||
      maxBytes > 12 * 1024 ** 2
    )
      throw new Error("Native follow-up OS command refused.");
    const facts = {
      executableSha256: this.verifyExecutable(executable),
      closed: false,
      timeout: false,
      outputBounded: true,
    };
    this.processes.push(facts);
    const fd = NodeFS.openSync(
      NodePath.join(this.fixture, "native-os-" + this.processes.length + ".log"),
      "wx",
      0o600,
    );
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const child = NodeChildProcess.spawn(NodeFS.realpathSync(executable), [...args], {
          cwd: this.fixture,
          env: this.environment,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const chunks: Buffer[] = [];
        let size = 0,
          stderrSize = 0,
          spawnFailed = false;
        const timer = setTimeout(() => {
          facts.timeout = true;
          child.kill("SIGKILL");
        }, 15000);
        child.stdout!.on("data", (value: Buffer) => {
          size += value.length;
          if (size > maxBytes) {
            facts.outputBounded = false;
            child.kill("SIGKILL");
          } else chunks.push(value);
        });
        child.stderr!.on("data", (value: Buffer) => {
          stderrSize += value.length;
          if (stderrSize > 65536) {
            facts.outputBounded = false;
            child.kill("SIGKILL");
          } else NodeFS.writeSync(fd, value);
        });
        child.once("error", () => {
          spawnFailed = true;
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          facts.closed = true;
          try {
            this.verifyExecutable(executable);
          } catch {
            facts.outputBounded = false;
          }
          if (spawnFailed || code !== 0 || facts.timeout || !facts.outputBounded)
            reject(new Error("Native follow-up OS operation refused."));
          else resolve(Buffer.concat(chunks));
        });
      });
    } finally {
      NodeFS.closeSync(fd);
      if (!facts.closed) this.unsafe();
    }
  }
  assertClosed() {
    if (this.processes.some((entry) => !entry.closed || entry.timeout || !entry.outputBounded))
      throw new Error("Native follow-up OS cleanup unsafe.");
  }
}
