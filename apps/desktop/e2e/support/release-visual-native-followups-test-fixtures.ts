// @effect-diagnostics nodeBuiltinImport:off - Synthetic codec bytes for hermetic unit checks only; never native visual evidence.
import * as NodeZlib from "node:zlib";
export function syntheticNativeFollowupPng(width = 1280, height = 960) {
  const chunk = (kind: string, data: Buffer) => {
    const value = Buffer.alloc(data.length + 12);
    value.writeUInt32BE(data.length);
    value.write(kind, 4, "ascii");
    data.copy(value, 8);
    value.writeUInt32BE(NodeZlib.crc32(value.subarray(4, value.length - 4)), value.length - 4);
    return value;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      pixels[offset] = x < width / 2 ? 200 : 20;
      pixels[offset + 1] = 40;
      pixels[offset + 2] = x < width / 2 ? 20 : 200;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export const syntheticNativeWslWitness = {
  nativeHost: true,
  sourceMatched: true,
  inputMatched: true,
  mainWindowMatched: true,
  storeMatched: true,
  versionMatched: true,
  processOwnerMatched: true,
  themeMatched: true,
  publicEntryMatched: true,
  workPreserved: true,
  pixelsSafe: true,
  nativeWindows: true,
  wslAvailable: true,
  mappedDistro: true,
  localSettings: true,
  topologyMatched: true,
} as const;
