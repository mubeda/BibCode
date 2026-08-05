import * as NodeZlib from "node:zlib";

export interface DecodedRgbaPng {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(left: number, up: number, upLeft: number): number {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upLeftDistance = Math.abs(prediction - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

export function decodeRgbaPng(bytes: Uint8Array): DecodedRgbaPng {
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid PNG signature");
  }

  let width = 0;
  let height = 0;
  const idatChunks: Array<Buffer> = [];
  for (let offset = PNG_SIGNATURE.length; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd + 4 > png.length) throw new Error(`Truncated PNG ${type} chunk`);
    const payload = png.subarray(payloadStart, payloadEnd);
    if (type === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      if (
        payload[8] !== 8 ||
        payload[9] !== 6 ||
        payload[10] !== 0 ||
        payload[11] !== 0 ||
        payload[12] !== 0
      ) {
        throw new Error("PNG must be non-interlaced 8-bit RGBA");
      }
    } else if (type === "IDAT") {
      idatChunks.push(payload);
    }
    offset = payloadEnd + 4;
  }
  if (width === 0 || height === 0 || idatChunks.length === 0) {
    throw new Error("PNG is missing IHDR or IDAT data");
  }

  const rowBytes = width * 4;
  const filtered = NodeZlib.inflateSync(Buffer.concat(idatChunks));
  if (filtered.length !== height * (rowBytes + 1)) {
    throw new Error("PNG scanline length does not match its dimensions");
  }
  const pixels = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = filtered[sourceOffset++];
    const rowOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= 4 ? pixels[rowOffset + x - 4]! : 0;
      const up = y > 0 ? pixels[rowOffset - rowBytes + x]! : 0;
      const upLeft = y > 0 && x >= 4 ? pixels[rowOffset - rowBytes + x - 4]! : 0;
      let predictor: number;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[rowOffset + x] = (filtered[sourceOffset++]! + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}
