import { describe, expect, it } from "@effect/vitest";

import {
  E2EE_RECORD_FLAG_CONTINUATION,
  E2EE_RECORD_FLAG_FINAL,
  E2eeFrameError,
  MAX_E2EE_CHUNK_BYTES,
  MAX_E2EE_LOGICAL_MESSAGE_BYTES,
  RecordAssembler,
  splitIntoRecords,
} from "./frame.ts";

const recordAt = (records: ReadonlyArray<Uint8Array>, index: number): Uint8Array => {
  const record = records[index];
  if (record === undefined) throw new Error(`missing record ${index}`);
  return record;
};

describe("e2ee record layer", () => {
  it("splits small payloads into one final record", () => {
    const records = splitIntoRecords(Uint8Array.from([1, 2, 3]));
    expect(records).toHaveLength(1);
    const record = recordAt(records, 0);
    expect(record[0]).toBe(E2EE_RECORD_FLAG_FINAL);
    expect(record.slice(1)).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("represents the empty message as one final empty record", () => {
    const records = splitIntoRecords(new Uint8Array(0));
    expect(records).toHaveLength(1);
    expect(recordAt(records, 0)).toEqual(Uint8Array.of(E2EE_RECORD_FLAG_FINAL));
  });

  it("splits large payloads with continuation flags and reassembles them", () => {
    const payload = new Uint8Array(MAX_E2EE_CHUNK_BYTES * 2 + 7).fill(0xab);
    const records = splitIntoRecords(payload);
    expect(records).toHaveLength(3);
    const first = recordAt(records, 0);
    const second = recordAt(records, 1);
    const third = recordAt(records, 2);
    expect(first[0]).toBe(E2EE_RECORD_FLAG_CONTINUATION);
    expect(second[0]).toBe(E2EE_RECORD_FLAG_CONTINUATION);
    expect(third[0]).toBe(E2EE_RECORD_FLAG_FINAL);
    expect(first).toHaveLength(1 + MAX_E2EE_CHUNK_BYTES);
    const assembler = new RecordAssembler();
    expect(assembler.push(first)).toBeNull();
    expect(assembler.push(second)).toBeNull();
    expect(assembler.push(third)).toEqual(payload);
  });

  it("the assembler resets between messages", () => {
    const assembler = new RecordAssembler();
    expect(assembler.push(Uint8Array.of(E2EE_RECORD_FLAG_FINAL, 1))).toEqual(Uint8Array.of(1));
    expect(assembler.push(Uint8Array.of(E2EE_RECORD_FLAG_FINAL, 2))).toEqual(Uint8Array.of(2));
  });

  it("rejects empty records, unknown flags, and overflow", () => {
    const assembler = new RecordAssembler();
    expect(() => assembler.push(new Uint8Array(0))).toThrow(E2eeFrameError);
    expect(() => assembler.push(Uint8Array.of(0x02, 1))).toThrow(E2eeFrameError);
    const chunk = new Uint8Array(1 + MAX_E2EE_CHUNK_BYTES);
    chunk[0] = E2EE_RECORD_FLAG_CONTINUATION;
    const overflowing = new RecordAssembler();
    const rounds = Math.ceil(MAX_E2EE_LOGICAL_MESSAGE_BYTES / MAX_E2EE_CHUNK_BYTES) + 1;
    expect(() => {
      for (let index = 0; index < rounds; index += 1) {
        overflowing.push(chunk);
      }
    }).toThrow(E2eeFrameError);
  });

  it("refuses to split payloads beyond the logical cap", () => {
    expect(() => splitIntoRecords(new Uint8Array(MAX_E2EE_LOGICAL_MESSAGE_BYTES + 1))).toThrow(
      E2eeFrameError,
    );
  });
});
