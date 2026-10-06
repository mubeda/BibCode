// @effect-diagnostics nodeBuiltinImport:off - CI-owned raw hosting executables and disposable Git history only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import { buildPullRequestsHostExchanges } from "./release-visual-pull-requests-fixture.ts";
import type { PullRequestsFixtureProvider } from "./release-visual-pull-requests-protocol.ts";
const refused = () => new Error("Owned hosting fixture refused.");
const digest = (value: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
function directory(path: string, uid?: number) {
  const stat = NodeFS.lstatSync(path);
  if (
    !NodePath.isAbsolute(path) ||
    NodePath.normalize(path) !== path ||
    NodeFS.realpathSync(path) !== path ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (uid !== undefined && stat.uid !== uid)
  )
    throw refused();
  return stat;
}
function write(path: string, value: string, mode = 0o600) {
  NodeFS.writeFileSync(path, value, { mode, flag: "wx" });
}
export interface PullRequestsGitPortResult {
  status: number;
  stdout: string;
}
export interface PullRequestsHostingFixtureInput {
  root: string;
  sourceSha: string;
  node: string;
  ci: boolean;
  git: (cwd: string, argv: readonly string[]) => Promise<PullRequestsGitPortResult>;
}
export interface PullRequestsHostingProject {
  cwd: string;
  origin: string;
  bareRemote: string;
  baseSha: string;
  headSha: string;
  patch: string;
  originConfigSha256: string;
}
export interface PullRequestsHostingFixture {
  root: string;
  sourceSha: string;
  projects: Record<PullRequestsFixtureProvider, PullRequestsHostingProject>;
  executables: Record<PullRequestsFixtureProvider, string>;
  binDirectory: string;
  config: string;
  engine: string;
  gitConfig: string;
  hashes: Readonly<Record<string, string>>;
}
/** Parent owns the real Git/server/process lifetime; no process or real hosting account is started here. */
export async function preparePullRequestsHostingFixture(
  input: PullRequestsHostingFixtureInput,
): Promise<PullRequestsHostingFixture> {
  try {
    if (
      !input.ci ||
      !/^[0-9a-f]{40}$/.test(input.sourceSha) ||
      !/\/(light|dark)$/.test(input.root) ||
      typeof input.git !== "function" ||
      !NodePath.isAbsolute(input.node) ||
      NodeFS.realpathSync(input.node) !== input.node ||
      /[\s\0]/.test(input.node)
    )
      throw refused();
    const owner = directory(input.root);
    const parent = NodePath.join(input.root, "requests"),
      hosting = NodePath.join(input.root, "hosting"),
      bin = NodePath.join(hosting, "bin");
    for (const path of [parent, hosting, bin]) {
      NodeFS.mkdirSync(path, { mode: 0o700 });
      directory(path, owner.uid);
    }
    const git = async (cwd: string, argv: readonly string[]) => {
      directory(cwd, owner.uid);
      const result = await input.git(cwd, argv);
      if (
        result.status !== 0 ||
        typeof result.stdout !== "string" ||
        Buffer.byteLength(result.stdout) > 65536
      )
        throw refused();
      return result.stdout;
    };
    const projects = {} as Record<PullRequestsFixtureProvider, PullRequestsHostingProject>;
    const exchanges = {} as Record<
      PullRequestsFixtureProvider,
      ReturnType<typeof buildPullRequestsHostExchanges>
    >;
    const gitConfig = NodePath.join(hosting, "origins.gitconfig");
    for (const provider of ["github", "gitlab"] as const) {
      const cwd = NodePath.join(parent, provider),
        bareRemote = NodePath.join(parent, provider + "-origin.git"),
        origin = "https://" + provider + ".visual.invalid/owned/requests.git";
      NodeFS.mkdirSync(cwd, { mode: 0o700 });
      NodeFS.mkdirSync(bareRemote, { mode: 0o700 });
      await git(cwd, ["init", "--initial-branch=main"]);
      write(NodePath.join(cwd, "visual-request.ts"), "export const approved = false;\n");
      await git(cwd, ["add", "--", "visual-request.ts"]);
      await git(cwd, ["commit", "-m", "Owned request baseline"]);
      const baseSha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
      if (!/^[0-9a-f]{40}$/.test(baseSha)) throw refused();
      await git(cwd, ["switch", "-c", "visual-request"]);
      NodeFS.writeFileSync(
        NodePath.join(cwd, "visual-request.ts"),
        "export const approved = true;\n",
        { mode: 0o600 },
      );
      await git(cwd, ["add", "--", "visual-request.ts"]);
      await git(cwd, ["commit", "-m", "Owned request patch"]);
      await git(cwd, ["branch", "visual-create"]);
      const headSha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
      const patch = await git(cwd, ["diff", baseSha, headSha, "--", "visual-request.ts"]);
      const table = buildPullRequestsHostExchanges({ provider, baseSha, headSha, patch });
      if (!table) throw refused();
      await git(bareRemote, ["init", "--bare", "--initial-branch=main"]);
      await git(cwd, ["remote", "add", "origin", bareRemote]);
      await git(cwd, [
        "push",
        "--set-upstream",
        "origin",
        "main",
        "visual-request",
        "visual-create",
      ]);
      await git(cwd, ["remote", "set-url", "origin", origin]);
      await git(cwd, ["config", "--file", gitConfig, "url." + bareRemote + ".insteadOf", origin]);
      const configPath = NodePath.join(cwd, ".git", "config"),
        stat = NodeFS.lstatSync(configPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.uid !== owner.uid ||
        NodeFS.realpathSync(configPath) !== configPath ||
        stat.size > 8192
      )
        throw refused();
      const originConfigSha256 = digest(NodeFS.readFileSync(configPath));
      projects[provider] = { cwd, origin, bareRemote, baseSha, headSha, patch, originConfigSha256 };
      exchanges[provider] = table;
    }
    NodeFS.chmodSync(gitConfig, 0o600);
    const engine = NodePath.join(bin, "release-visual-pull-requests-protocol.mjs");
    const source = NodeFS.readFileSync(
      new NodeURL.URL("./release-visual-pull-requests-protocol.ts", import.meta.url),
      "utf8",
    );
    const engineBytes = NodeModule.stripTypeScriptTypes(source, { mode: "strip" });
    write(engine, engineBytes, 0o500);
    const state = NodePath.join(hosting, "host-state.json"),
      calls = NodePath.join(hosting, "host-calls.jsonl");
    write(state, JSON.stringify({ labelApplied: false }));
    write(calls, "");
    const config = NodePath.join(hosting, "hosting-config.json");
    const configBytes = JSON.stringify({
      root: input.root,
      sourceSha: input.sourceSha,
      uid: owner.uid,
      projects,
      exchanges,
      state,
      calls,
    });
    write(config, configBytes);
    const makeProgram = (
      provider: PullRequestsFixtureProvider,
    ) => `#!${input.node} --experimental-strip-types
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
const fail=()=>{throw new Error("Owned hosting fixture refused.");};
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const configPath=${JSON.stringify(config)}, enginePath=${JSON.stringify(engine)}, expectedConfigHash=${JSON.stringify(digest(configBytes))}, expectedEngineHash=${JSON.stringify(digest(engineBytes))}, provider=${JSON.stringify(provider)}, expectedSourceSha=${JSON.stringify(input.sourceSha)};
const read=(file,max,mode)=>{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||stat.size>max||fs.realpathSync(file)!==file||(mode!==null&&(stat.mode&0o777)!==mode))fail();const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const opened=fs.fstatSync(fd),bytes=Buffer.alloc(max+1),size=fs.readSync(fd,bytes,0,bytes.length,0);if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size!==stat.size||size!==stat.size||size>max)fail();return bytes.subarray(0,size);}finally{fs.closeSync(fd);}};
try {
  if(process.env.CI !== "true"||process.env.NODE_OPTIONS||process.env.NODE_PATH)fail();
  const configBytes=read(configPath,1048576,0o600),engineBytes=read(enginePath,65536,0o500);if(hash(configBytes)!==expectedConfigHash||hash(engineBytes)!==expectedEngineHash)fail();
  const config=JSON.parse(configBytes.toString("utf8"));if(config.sourceSha!==expectedSourceSha||config.uid!==process.getuid()||fs.realpathSync(config.root)!==config.root||!fs.lstatSync(config.root).isDirectory()||(fs.lstatSync(config.root).mode&0o077)!==0)fail();
  const project=config.projects[provider],cwd=fs.realpathSync(process.cwd());if(cwd!==process.cwd()||cwd!==project.cwd||hash(read(path.join(cwd,".git","config"),8192,null))!==project.originConfigSha256)fail();
  const argv=process.argv.slice(2);let stdin=fs.readFileSync(0,"utf8");if(Buffer.byteLength(stdin)>65536)fail();
  const pinnedHost=provider+".visual.invalid",envHost=process.env[provider==="github"?"GH_HOST":"GITLAB_HOST"];
  const legacy=(argv[0]==="pr"&&(argv[1]==="create"||(argv[1]==="list"&&argv.includes("--head"))))||(argv[0]==="api"&&argv.includes("projects/:fullpath/merge_requests"))||(argv[0]==="mr"&&argv[1]==="list"&&argv.includes("--source-branch"));
  if(envHost!==pinnedHost&&!(legacy&&envHost===undefined))fail();
  const bodyAt=argv.indexOf("--input");if(provider==="gitlab"&&bodyAt>=0&&argv[bodyAt+1]!=="-") {const file=argv[bodyAt+1];if(typeof file!=="string"||!file.startsWith(config.root+path.sep)||path.basename(path.dirname(file))!=="pull-requests"||!/^body-[0-9a-f-]{36}\\.json$/.test(path.basename(file))||stdin!=="")fail();stdin=read(file,65536,0o600).toString("utf8");argv[bodyAt+1]="<OWNED_BODY_FILE>";}
  const frame={provider,root:config.root,cwd,sourceSha:config.sourceSha,expectedSourceSha,host:pinnedHost,repository:"owned/requests",argv,stdin};
  const {matchPullRequestsHostExchange}=await import("data:text/javascript;base64,"+engineBytes.toString("base64"));
  const matched=matchPullRequestsHostExchange(frame,config.exchanges[provider]);if(!matched)fail();
  const state=JSON.parse(read(config.state,4096,0o600).toString("utf8"));if(Object.keys(state).length!==1||typeof state.labelApplied!=="boolean")fail();
  if(matched.kind==="labels") {state.labelApplied=argv.includes("--add-label");const temporary=config.state+"."+crypto.randomUUID();fs.writeFileSync(temporary,JSON.stringify(state),{mode:0o600,flag:"wx"});fs.renameSync(temporary,config.state);}
  let stdout=matched.stdout;if(provider==="github"&&matched.kind==="detail"&&matched.number===43&&argv[0]==="pr") {const raw=JSON.parse(stdout);if(state.labelApplied)raw.labels=[...(raw.labels??[]),{name:"owned-label",color:"0052cc",description:"Owned fixture label"}];stdout=JSON.stringify(raw);}
  const log=read(config.calls,65536,0o600);if(log.toString("utf8").split("\\n").filter(Boolean).length>=200)fail();process.once("exit",code=>{const metadata=fs.lstatSync(config.state),stateIdentity=path.basename(config.state)+"\\0"+metadata.dev+":"+metadata.ino+":"+metadata.uid+":"+(metadata.mode&0o777)+"\\n";fs.appendFileSync(config.calls,JSON.stringify({kind:matched.kind,provider,number:matched.number,success:code===0,bodySha256:stdin?hash(stdin):null,mutation:matched.kind==="labels"?(argv.includes("--add-label")?"label-add":"label-remove"):null,stateSha256:matched.kind==="labels"?hash(read(config.state,4096,0o600)):null,stateIdentitySha256:matched.kind==="labels"?hash(stateIdentity):null})+"\\n");});
  process.stdout.write(stdout);process.stderr.write(matched.stderr);process.exitCode=matched.exitCode;
} catch {process.stderr.write("Owned hosting fixture refused.\\n");process.exitCode=64;}
`;
    const executables = {} as Record<PullRequestsFixtureProvider, string>;
    for (const provider of ["github", "gitlab"] as const) {
      const executable = NodePath.join(bin, provider === "github" ? "gh" : "glab");
      write(executable, makeProgram(provider), 0o500);
      executables[provider] = executable;
    }
    const hashes = Object.fromEntries(
      [config, engine, ...Object.values(executables), gitConfig].map((file) => [
        file,
        digest(NodeFS.readFileSync(file)),
      ]),
    );
    return {
      root: input.root,
      sourceSha: input.sourceSha,
      projects,
      executables,
      binDirectory: bin,
      config,
      engine,
      gitConfig,
      hashes,
    };
  } catch {
    throw refused();
  }
}
