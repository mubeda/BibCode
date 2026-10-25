// @effect-diagnostics nodeBuiltinImport:off - The guard reads the installed renderer and sanitizer builds.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const webRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

/** `eval(…)`, `new Function` and a bare `Function(…)` call; `isRegexOrFunction(` is not one. */
const DYNAMIC_CODE = /\beval\s*\(|\bnew\s+Function\b|(?<![\w$.])Function\s*\(/;

function installedPackageDirectory(name: string): string {
  return NodeFS.realpathSync(NodePath.join(webRoot, "node_modules", name));
}

function javaScriptFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".js") || path.endsWith(".mjs"))
    .map((path) => NodePath.join(directory, path));
}

// The production CSP has no 'unsafe-eval', and the development one does: a renderer that builds
// code at run time would draw in development and fail in a release build (#171).
describe("Mermaid renderer dependencies", () => {
  it("ship no eval or Function constructor in Pele's published build", () => {
    const files = javaScriptFiles(NodePath.join(installedPackageDirectory("pele"), "dist"));
    expect(files.length).toBeGreaterThan(10);
    const offending = files.filter((file) => DYNAMIC_CODE.test(NodeFS.readFileSync(file, "utf8")));
    expect(offending).toEqual([]);
  });

  it("ship no eval or Function constructor in DOMPurify's ES build", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(installedPackageDirectory("dompurify"), "dist", "purify.es.mjs"),
      "utf8",
    );
    expect(source).toContain("@license DOMPurify");
    expect(DYNAMIC_CODE.test(source)).toBe(false);
  });

  it("recognizes the forms it guards against", () => {
    expect(DYNAMIC_CODE.test("x=eval(code)")).toBe(true);
    expect(DYNAMIC_CODE.test("new Function('a','return a')")).toBe(true);
    expect(DYNAMIC_CODE.test(";Function('return this')()")).toBe(true);
    expect(DYNAMIC_CODE.test("isRegexOrFunction(value)")).toBe(false);
  });
});
