/** Private byte gate for one already admitted Noise WebSocket; never decodes auth or RPC. */
export interface SettingsConfigurationGate {
  push: (bytes: Buffer) => readonly Buffer[];
  release: () => readonly Buffer[];
  close: () => void;
  observation: () => {
    upgradeObserved: boolean;
    forwardedPreapplicationMessages: number;
    heldRecords: number;
    heldBytes: number;
    released: boolean;
    closed: boolean;
  };
}
export function createSettingsConfigurationGate(
  mode: "pass" | "hold-config" = "hold-config",
): SettingsConfigurationGate {
  const refused = () => new Error("Owned settings configuration transport refused.");
  if (mode !== "pass" && mode !== "hold-config") throw refused();
  let pending = Buffer.alloc(0),
    upgradeObserved = false,
    forwarded = 0,
    released = mode === "pass",
    closed = false,
    heldBytes = 0;
  const held: Buffer[] = [];
  const fail = (): never => {
    closed = true;
    pending = Buffer.alloc(0);
    held.length = 0;
    heldBytes = 0;
    throw refused();
  };
  return {
    push: (bytes) => {
      if (closed || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 1_048_576)
        return fail();
      pending = Buffer.concat([pending, bytes]);
      const output: Buffer[] = [];
      let frames = 0;
      if (!upgradeObserved) {
        const end = pending.indexOf("\r\n\r\n");
        if (end === -1) {
          if (pending.length > 16384) return fail();
          return output;
        }
        if (end + 4 > 16384) return fail();
        const header = pending.subarray(0, end + 4),
          text = header.toString("ascii");
        if (
          !/^HTTP\/1\.[01] 101 [^\r\n]*\r\n/.test(text) ||
          !/^Upgrade:\s*websocket\s*\r?$/im.test(text) ||
          !/^Connection:\s*Upgrade\s*\r?$/im.test(text)
        )
          return fail();
        output.push(Buffer.from(header));
        pending = pending.subarray(end + 4);
        upgradeObserved = true;
      }
      while (pending.length >= 2) {
        if (++frames > 64) return fail();
        const first = pending[0]!,
          second = pending[1]!,
          opcode = first & 15;
        if (
          (first & 0x70) !== 0 ||
          (second & 0x80) !== 0 ||
          ![2, 8, 9, 10].includes(opcode) ||
          (first & 0x80) === 0
        )
          return fail();
        let length = second & 127,
          header = 2;
        if (length === 127) return fail();
        if (length === 126) {
          if (pending.length < 4) break;
          length = pending.readUInt16BE(2);
          header = 4;
          if (length < 126) return fail();
        }
        if (opcode !== 2 && length > 125) return fail();
        if (pending.length < header + length) break;
        const frame = Buffer.from(pending.subarray(0, header + length));
        pending = pending.subarray(header + length);
        if (opcode !== 2) {
          output.push(frame);
          if (opcode === 8) {
            closed = true;
            pending = Buffer.alloc(0);
            held.length = 0;
            heldBytes = 0;
            break;
          }
        } else if (forwarded < 2) {
          // Current NK's empty-payload responder message is 48 bytes. The next
          // original encrypted message is the bounded authentication reply;
          // only the real client's configuring notice proves its success.
          if (forwarded === 0 ? length !== 48 : length < 17 || length > 16384) return fail();
          output.push(frame);
          forwarded++;
        } else if (released) output.push(frame);
        else {
          if (held.length >= 32 || heldBytes + frame.length > 1_048_576) return fail();
          held.push(frame);
          heldBytes += frame.length;
        }
      }
      if (pending.length > 65539) return fail();
      return output;
    },
    release: () => {
      if (closed || released || !upgradeObserved || forwarded !== 2 || held.length === 0)
        return fail();
      const output = held.slice();
      held.length = 0;
      heldBytes = 0;
      released = true;
      return output;
    },
    close: () => {
      closed = true;
      pending = Buffer.alloc(0);
      held.length = 0;
      heldBytes = 0;
    },
    observation: () => ({
      upgradeObserved,
      forwardedPreapplicationMessages: forwarded,
      heldRecords: held.length,
      heldBytes,
      released,
      closed,
    }),
  };
}
