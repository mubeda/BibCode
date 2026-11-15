// @effect-diagnostics nodeBuiltinImport:off - Repository event-name guard reads source files directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const WEB_BRIDGE = NodePath.join(REPOSITORY_ROOT, "apps/web/src/tauriDesktopBridge.ts");
const RUST_SOURCES = NodePath.join(REPOSITORY_ROOT, "apps/desktop/src-tauri/src");
const EVENT_NAME = /"(desktop:[a-z-]+)"/g;

/** Names one side holds that are not events, each with the reason. */
const WEB_ONLY: ReadonlySet<string> = new Set();
const RUST_ONLY: ReadonlySet<string> = new Set([
  // A test hostname in `tailscale.rs` (an invalid URL port), not an event name.
  "desktop:invalid-port",
]);

function eventNames(text: string): Set<string> {
  return new Set([...text.matchAll(EVENT_NAME)].map((match) => match[1]!));
}

function rustText(): string {
  return NodeFS.readdirSync(RUST_SOURCES, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".rs"))
    .map((path) => NodeFS.readFileSync(NodePath.join(RUST_SOURCES, path), "utf8"))
    .join("\n");
}

describe("desktop bridge event names", () => {
  it("every desktop event name exists on both sides of the bridge", () => {
    const web = eventNames(NodeFS.readFileSync(WEB_BRIDGE, "utf8"));
    const rust = eventNames(rustText());
    expect(web.size).toBeGreaterThan(0);
    expect(rust.size).toBeGreaterThan(0);

    const missingInRust = [...web].filter((name) => !rust.has(name) && !WEB_ONLY.has(name));
    const missingInWeb = [...rust].filter((name) => !web.has(name) && !RUST_ONLY.has(name));
    expect({ missingInRust, missingInWeb }).toEqual({ missingInRust: [], missingInWeb: [] });
  });
});
