import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeURL from "node:url";

export async function prepareWebkit({
  runnerTemp,
  environmentFile,
  spawnSync = NodeChildProcess.spawnSync,
}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(runnerTemp, "typography-webkit-"));
  const extracted = NodePath.join(directory, "root");
  await NodeFSP.mkdir(extracted);
  function run(command, args) {
    const result = spawnSync(command, args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 180_000,
    });
    if (result.status !== 0) throw new Error(`Runner-local WebKit preparation failed: ${command}.`);
    return result.stdout;
  }
  const required = ["webkit2gtk-driver", "libwebkit2gtk-4.1-0", "libjavascriptcoregtk-4.1-0"];
  const dependencies = run("apt-cache", [
    "depends",
    "--recurse",
    "--no-recommends",
    "--no-suggests",
    "--no-conflicts",
    "--no-breaks",
    "--no-replaces",
    "--no-enhances",
    ...required,
  ]);
  const packages = new Set(required);
  for (const line of dependencies.split("\n")) {
    const name = /^\s*\|?Depends:\s+([a-z0-9][a-z0-9+.-]*)$/.exec(line)?.[1];
    if (!name) continue;
    const installed = spawnSync("dpkg-query", ["-W", "-f=${Status}", name], {
      encoding: "utf8",
    });
    if (installed.status !== 0 || installed.stdout.trim() !== "install ok installed")
      packages.add(name);
  }
  run("apt-get", ["download", ...packages]);
  for (const name of await NodeFSP.readdir(directory))
    if (name.endsWith(".deb")) run("dpkg-deb", ["-x", NodePath.join(directory, name), extracted]);
  const driver = NodePath.join(extracted, "usr/bin/WebKitWebDriver");
  const browser = NodePath.join(extracted, "usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser");
  await NodeFSP.access(driver);
  await NodeFSP.access(browser);
  const libraryPath = [
    NodePath.join(extracted, "usr/lib/x86_64-linux-gnu"),
    NodePath.join(extracted, "lib/x86_64-linux-gnu"),
  ].join(":");
  await NodeFSP.appendFile(
    environmentFile,
    `BIBCODE_FIXTURE_WEBKIT_DRIVER=${driver}\nBIBCODE_FIXTURE_WEBKIT_BROWSER=${browser}\nLD_LIBRARY_PATH=${libraryPath}\nWEBKIT_EXEC_PATH=${NodePath.dirname(browser)}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(directory, "packages.txt"), [...packages].join("\n"));

  return { directory, driver, browser, packages: [...packages] };
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  // oxlint-disable-next-line bibcode/no-global-process-runtime -- The CI-only CLI validates its native host before running the injectable preparation caller.
  const platform = process.platform;
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    platform !== "linux" ||
    !process.env.RUNNER_TEMP ||
    !process.env.GITHUB_ENV
  )
    throw new Error("Native WebKit preparation is CI-only.");
  await prepareWebkit({
    runnerTemp: process.env.RUNNER_TEMP,
    environmentFile: process.env.GITHUB_ENV,
  });
}
