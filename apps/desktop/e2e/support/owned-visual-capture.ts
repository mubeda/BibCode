// @effect-diagnostics nodeBuiltinImport:off - Only the existing private original-capture lifecycle owns these writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  bounded,
  type QualificationBrowser,
  type QualificationOwner,
} from "./qualification-owner.ts";
import { inspectScreenshot } from "./remote-ui-evidence.ts";

export interface OwnedVisualCaptureInput<Observation, Receipt extends object> {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  evidence: string;
  file: string;
  captured: Set<string>;
  observation: () => Observation;
  read: (observation: Observation) => Promise<unknown>;
  verifyOwnedIdentity: () => Promise<void>;
  validate: (input: unknown) => Record<string, true>;
  project: (
    input: ReturnType<typeof inspectScreenshot> & {
      file: string;
      witness: Record<string, true> | undefined;
    },
  ) => Receipt;
  refused: () => Error;
}

/** One existing fixed original-capture lifecycle; scene and identity admission stay with callers. */
export async function captureOwnedVisualScene<Observation, Receipt extends object>(
  input: OwnedVisualCaptureInput<Observation, Receipt>,
): Promise<Receipt> {
  const path = NodePath.join(input.evidence, input.file);
  if (
    input.captured.has(input.file) ||
    NodeFS.existsSync(path) ||
    (await input.browser.isAlertOpen())
  )
    throw input.refused();
  const observation = input.observation();
  await input.verifyOwnedIdentity();
  let witness: Record<string, true> | undefined;
  await input.owner.until(async () => {
    const value = await bounded(input.read(observation), 2000);
    try {
      witness = input.validate(value);
      return true;
    } catch {
      return false;
    }
  });
  const bytes = Buffer.from(await bounded(input.browser.takeScreenshot(), 5000), "base64");
  await input.verifyOwnedIdentity();
  input.validate(await bounded(input.read(observation), 2000));
  const image = inspectScreenshot(bytes);
  if (image.width !== 1280 || image.height !== 960) throw input.refused();
  const receipt = input.project({ file: input.file, witness, ...image });
  NodeFS.writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  input.captured.add(input.file);
  return receipt;
}
