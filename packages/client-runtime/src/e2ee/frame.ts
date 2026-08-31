import { MAX_NOISE_MESSAGE_BYTES, NOISE_TAG_BYTES } from "./noise.ts";

export const E2EE_RECORD_FLAG_FINAL = 0x00;
export const E2EE_RECORD_FLAG_CONTINUATION = 0x01;
export const MAX_E2EE_CHUNK_BYTES = MAX_NOISE_MESSAGE_BYTES - NOISE_TAG_BYTES - 1;
export const MAX_E2EE_LOGICAL_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_E2EE_PREAUTH_MESSAGE_BYTES = 64 * 1024;
export const MAX_E2EE_RECORDS_PER_MESSAGE = 2_048;

export class E2eeFrameError extends Error {}

export const plaintextRecords = (plaintext: Uint8Array): Iterable<Uint8Array> => {
  if (plaintext.length > MAX_E2EE_LOGICAL_MESSAGE_BYTES) {
    throw new E2eeFrameError(`outbound message of ${plaintext.length} bytes exceeds the E2EE cap`);
  }

  return (function* () {
    if (plaintext.length === 0) {
      yield Uint8Array.of(E2EE_RECORD_FLAG_FINAL);
      return;
    }

    for (let offset = 0; offset < plaintext.length; offset += MAX_E2EE_CHUNK_BYTES) {
      const chunk = plaintext.subarray(offset, offset + MAX_E2EE_CHUNK_BYTES);
      const final = offset + MAX_E2EE_CHUNK_BYTES >= plaintext.length;
      const record = new Uint8Array(1 + chunk.length);
      record[0] = final ? E2EE_RECORD_FLAG_FINAL : E2EE_RECORD_FLAG_CONTINUATION;
      record.set(chunk, 1);
      yield record;
    }
  })();
};

export const splitIntoRecords = (plaintext: Uint8Array): Array<Uint8Array> => [
  ...plaintextRecords(plaintext),
];

export class RecordAssembler {
  private parts: Array<Uint8Array> = [];
  private assembledBytes = 0;
  private recordCount = 0;
  private readonly maxMessageBytes: number;

  constructor(maxMessageBytes = MAX_E2EE_LOGICAL_MESSAGE_BYTES) {
    this.maxMessageBytes = maxMessageBytes;
  }

  push(recordPlaintext: Uint8Array): Uint8Array | null {
    if (recordPlaintext.length === 0) throw new E2eeFrameError("empty E2EE record");

    const flag = recordPlaintext[0];
    const chunk = recordPlaintext.subarray(1);
    if (this.recordCount >= MAX_E2EE_RECORDS_PER_MESSAGE) {
      throw new E2eeFrameError("E2EE record count overflow");
    }
    if (flag === E2EE_RECORD_FLAG_CONTINUATION && chunk.length === 0) {
      throw new E2eeFrameError("empty E2EE continuation");
    }
    if (this.assembledBytes + chunk.length > this.maxMessageBytes) {
      throw new E2eeFrameError("E2EE reassembly overflow");
    }
    this.recordCount += 1;
    if (flag === E2EE_RECORD_FLAG_CONTINUATION) {
      if (chunk.length > 0) this.parts.push(chunk.slice());
      this.assembledBytes += chunk.length;
      return null;
    }
    if (flag !== E2EE_RECORD_FLAG_FINAL) {
      throw new E2eeFrameError(`unknown E2EE record flag ${String(flag)}`);
    }

    const message = new Uint8Array(this.assembledBytes + chunk.length);
    let offset = 0;
    for (const part of this.parts) {
      message.set(part, offset);
      offset += part.length;
    }
    message.set(chunk, offset);
    this.parts = [];
    this.assembledBytes = 0;
    this.recordCount = 0;
    return message;
  }
}
