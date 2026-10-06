/** CI fixture policy only. Actual Windows commands and filesystem admission remain in its fixed PowerShell owner. */
const refused = () => new Error("Owned WSL2 fixture refused.");
export const ownedWsl2ImagePin = Object.freeze({
  filename: "ubuntu-24.04.5-wsl-amd64.wsl",
  sha256: "bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e",
  signer: "843938DF228D22F7B3742BC0D94AA3F0EFE21092",
});
export interface WslFixtureRegistration {
  readonly name: string;
  readonly guid: string;
  readonly basePath: string;
  readonly version: number;
}
export interface WslFixtureInventory {
  readonly defaultGuid: string | null;
  readonly distros: readonly WslFixtureRegistration[];
}
export function admitWsl2Registration(
  before: WslFixtureInventory,
  after: WslFixtureInventory,
  intent: Pick<WslFixtureRegistration, "name" | "basePath"> & { readonly guid?: string },
): WslFixtureRegistration {
  const owned = after.distros[0];
  if (
    before.defaultGuid !== null ||
    before.distros.length !== 0 ||
    after.distros.length !== 1 ||
    !owned ||
    owned.version !== 2 ||
    owned.name !== intent.name ||
    owned.basePath !== intent.basePath ||
    !owned.guid ||
    (intent.guid !== undefined && owned.guid !== intent.guid) ||
    (after.defaultGuid !== null && after.defaultGuid !== owned.guid)
  )
    throw refused();
  return owned;
}
export function admitWsl2Runtime(input: {
  readonly kernel: string;
  readonly architecture: string;
  readonly osId: string;
  readonly osVersion: string;
}): true {
  if (
    !/^[-A-Za-z0-9.+]*microsoft-standard-WSL2$/i.test(input.kernel) ||
    input.architecture !== "x86_64" ||
    input.osId !== "ubuntu" ||
    input.osVersion !== "24.04"
  )
    throw refused();
  return true;
}
export function admitWsl2Image(input: {
  readonly signers: readonly string[];
  readonly filename: string;
  readonly signedSha256: string;
  readonly actualSha256: string;
}): true {
  if (
    input.signers.length !== 1 ||
    input.signers[0] !== ownedWsl2ImagePin.signer ||
    input.filename !== ownedWsl2ImagePin.filename ||
    input.signedSha256 !== ownedWsl2ImagePin.sha256 ||
    input.actualSha256 !== ownedWsl2ImagePin.sha256
  )
    throw refused();
  return true;
}
/** Owner admission precedes all destructive calls. A failed terminate never skips exact unregister or the restoration check. */
export function joinOwnedWslCleanup(input: {
  readonly verifyOwner: () => Promise<void>;
  readonly terminate: () => Promise<void>;
  readonly unregister: () => Promise<void>;
  readonly verifyRestored: () => Promise<void>;
  readonly deleteOwned: () => Promise<void>;
  readonly unsafe: () => void;
}) {
  let joined: Promise<void> | undefined;
  return () => {
    if (joined) return joined;
    let resolve!: () => void, reject!: (error: unknown) => void;
    joined = new Promise<void>((ok, bad) => {
      resolve = ok;
      reject = bad;
    });
    void (async () => {
      let failed = false,
        original: unknown;
      try {
        await input.verifyOwner();
      } catch (error) {
        failed = true;
        original = error;
      }
      if (!failed) {
        for (const run of [input.terminate, input.unregister, input.verifyRestored])
          try {
            await run();
          } catch (error) {
            if (!failed) original = error;
            failed = true;
          }
      }
      if (!failed)
        try {
          await input.deleteOwned();
        } catch (error) {
          failed = true;
          original = error;
        }
      if (failed) {
        try {
          input.unsafe();
        } catch {
          /* first refusal wins */
        }
        throw original;
      }
    })().then(resolve, reject);
    return joined;
  };
}
/** The PS authority has already checked ACLs, file identities, registry and kernel; this closes the narrow native settings handoff. */
export function admitOwnedWslSeed(
  value: unknown,
  sourceSha: string,
): {
  readonly distro: string;
  readonly settings: {
    readonly wslOnly: true;
    readonly wslBackendEnabled: true;
    readonly wslDistro: string;
    readonly serverExposureMode: "local-only";
    readonly tailscaleServeEnabled: false;
  };
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw refused();
  const descriptor = Object.getOwnPropertyDescriptors(value);
  const read = (key: string) => {
    const property = descriptor[key];
    if (!property || !Object.hasOwn(property, "value")) throw refused();
    return property.value as unknown;
  };
  const name = read("name");
  if (
    read("schema") !== 1 ||
    read("sourceSha") !== sourceSha ||
    read("imageSha256") !== ownedWsl2ImagePin.sha256 ||
    read("kernelVerified") !== true ||
    read("phase") !== "kernel-verified" ||
    typeof name !== "string" ||
    !/^BibCodeQA-[a-f0-9]{32}$/.test(name) ||
    typeof read("guid") !== "string" ||
    read("appState") !== "none"
  )
    throw refused();
  return {
    distro: name,
    settings: {
      wslOnly: true,
      wslBackendEnabled: true,
      wslDistro: name,
      serverExposureMode: "local-only",
      tailscaleServeEnabled: false,
    },
  };
}
