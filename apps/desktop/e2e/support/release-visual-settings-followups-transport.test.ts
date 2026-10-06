// @effect-diagnostics nodeBuiltinImport:off - Inert WebSocket bytes and fake sockets only, no local listener or credentials.
import { expect, it } from "vite-plus/test";
import { createSettingsConfigurationGate } from "./release-visual-settings-followups-transport.ts";
const upgrade = Buffer.from(
  "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
);
function frame(size: number, value: number, opcode = 2) {
  const header = Buffer.alloc(size < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  if (size < 126) header[1] = size;
  else {
    header[1] = 126;
    header.writeUInt16BE(size, 2);
  }
  return Buffer.concat([header, Buffer.alloc(size, value)]);
}
const handshake = frame(48, 1),
  authenticated = frame(120, 2),
  first = frame(4096, 3),
  second = frame(4096, 4);
function admitted() {
  const gate = createSettingsConfigurationGate();
  const forwarded = gate.push(Buffer.concat([upgrade, handshake, authenticated]));
  return { gate, forwarded };
}
it("forwards exact upgrade/handshake/authentication bytes and holds only later original application records", () => {
  const f = admitted();
  expect(Buffer.concat(f.forwarded)).toEqual(Buffer.concat([upgrade, handshake, authenticated]));
  expect(f.gate.push(first)).toEqual([]);
  expect(f.gate.push(second)).toEqual([]);
  expect(f.gate.observation()).toMatchObject({
    upgradeObserved: true,
    forwardedPreapplicationMessages: 2,
    heldRecords: 2,
    heldBytes: first.length + second.length,
    released: false,
  });
  expect(Buffer.concat(f.gate.release())).toEqual(Buffer.concat([first, second]));
  expect(f.gate.observation()).toMatchObject({ released: true, heldRecords: 0, heldBytes: 0 });
  expect(Buffer.concat(f.gate.push(first))).toEqual(first);
});
it("keeps fragmented TCP/header bytes in their original order without losing or rewriting a frame", () => {
  const gate = createSettingsConfigurationGate(),
    input = Buffer.concat([upgrade, handshake, authenticated, first]);
  const forwarded: Buffer[] = [];
  for (let offset = 0; offset < input.length; offset += 17)
    forwarded.push(...gate.push(input.subarray(offset, offset + 17)));
  expect(Buffer.concat(forwarded)).toEqual(Buffer.concat([upgrade, handshake, authenticated]));
  expect(Buffer.concat(gate.release())).toEqual(first);
});
it("passes original WebSocket control frames while keeping ciphertext records held", () => {
  const { gate } = admitted(),
    ping = frame(4, 5, 9);
  gate.push(first);
  expect(Buffer.concat(gate.push(ping))).toEqual(ping);
  expect(Buffer.concat(gate.release())).toEqual(first);
});
it("copies a held input so a later caller mutation cannot change released original bytes", () => {
  const { gate } = admitted(),
    input = Buffer.from(first);
  gate.push(input);
  input.fill(0);
  expect(Buffer.concat(gate.release())).toEqual(first);
});
it.each([
  "wrong-upgrade",
  "wrong-handshake",
  "text-auth",
  "masked",
  "fragmented-auth",
  "oversized-auth",
])("refuses unsupported current admission instead of claiming receiving settings: %s", (mode) => {
  const gate = createSettingsConfigurationGate();
  const response = mode === "wrong-upgrade" ? Buffer.from("HTTP/1.1 200 OK\r\n\r\n") : upgrade;
  const hello = mode === "wrong-handshake" ? frame(32, 1) : handshake;
  const auth =
    mode === "text-auth"
      ? frame(120, 2, 1)
      : mode === "oversized-auth"
        ? frame(16385, 2)
        : Buffer.from(authenticated);
  if (mode === "masked") auth[1] = (auth[1] ?? 0) | 0x80;
  if (mode === "fragmented-auth") auth[0] = 2;
  expect(() => gate.push(Buffer.concat([response, hello, auth]))).toThrow();
});
it("refuses held-buffer overflow, early/reused release and late bytes after close", () => {
  expect(() => createSettingsConfigurationGate().release()).toThrow();
  const { gate } = admitted();
  const chunk = frame(65535, 6);
  expect(() => {
    for (let count = 0; count < 20; count++) gate.push(chunk);
  }).toThrow();
  gate.close();
  expect(() => gate.push(first)).toThrow();
  expect(() => gate.release()).toThrow();
  const secondGate = admitted().gate;
  secondGate.push(first);
  secondGate.release();
  expect(() => secondGate.release()).toThrow();
});
