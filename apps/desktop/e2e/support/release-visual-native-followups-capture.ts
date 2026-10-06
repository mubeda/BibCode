// @effect-diagnostics nodeBuiltinImport:off - Only fixed original names are written once to the private native evidence root.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { inspectScreenshot } from "./remote-ui-evidence.ts";
import {
  validateNativeFollowupWitness,
  type NativeFollowupScene,
  type NativeFollowupTheme,
  type NativeFollowupOriginal,
} from "./release-visual-native-followups.ts";
/** The capture callback is the concrete native OS reader, never a WebView screenshot or transformed image. */
export async function captureNativeFollowupOriginal(input: {
  scene: NativeFollowupScene;
  theme: NativeFollowupTheme;
  evidence: string;
  captures: Set<string>;
  verify: () => Promise<void>;
  readWitness: () => Promise<Record<string, unknown>>;
  original: () => Promise<Buffer>;
  onJoin?: (join: {
    before: Record<string, true>;
    after: Record<string, true>;
    original: NativeFollowupOriginal;
  }) => void;
  platform?: string;
}): Promise<NativeFollowupOriginal> {
  const file = input.scene + "-" + input.theme + ".png",
    path = NodePath.join(input.evidence, file),
    dir = NodeFS.lstatSync(input.evidence);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    NodeFS.realpathSync(input.evidence) !== input.evidence ||
    (input.platform !== "win32" && (dir.mode & 0o077) !== 0) ||
    input.captures.has(file) ||
    NodeFS.existsSync(path)
  )
    throw new Error("Native follow-up original destination refused.");
  await input.verify();
  const before = validateNativeFollowupWitness(input.scene, await input.readWitness());
  const bytes = await input.original(),
    image = inspectScreenshot(bytes);
  if (image.width !== 1280 || image.height !== 960)
    throw new Error("Native follow-up original geometry refused.");
  await input.verify();
  const after = validateNativeFollowupWitness(input.scene, await input.readWitness());
  NodeFS.writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  input.captures.add(file);
  const original = Object.freeze({ scene: input.scene, theme: input.theme, file, ...image });
  input.onJoin?.({ before, after, original });
  return original;
}
