// @effect-diagnostics nodeBuiltinImport:off - Inert tests execute only a passive browser observer.
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { createSizedPng } from "./chat-upload-fixture.ts";
import {
  inlineFallbackObservationScript,
  projectInlineFallbackObservation,
  type InlineFallbackObservation,
} from "./chat-inline-fallback.ts";
function fixture() {
  const sent: unknown[] = [];
  class Socket {
    readonly url: string;
    constructor(url: string) {
      this.url = url;
    }
    send(value: unknown) {
      sent.push(value);
      return 17;
    }
  }
  const page = { WebSocket: Socket } as {
    WebSocket: typeof Socket;
    __inlineFallbackObservations: { read(): InlineFallbackObservation };
  };
  NodeVM.runInNewContext(inlineFallbackObservationScript, { window: page, URL, TextEncoder });
  const socket = new page.WebSocket("ws://localhost:4903/ws?ticket=private");
  return { socket, sent, read: () => page.__inlineFallbackObservations.read(), page };
}
const request = (payload: unknown, tag = "orchestration.dispatchCommand") =>
  JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] });
const turn = (attachment: unknown) => ({
  type: "thread.turn.start",
  message: { attachments: [attachment], text: "private-prompt" },
});
const image = (sizeBytes = 256) => ({
  type: "image",
  id: "owned-image",
  name: "private-image.png",
  mimeType: "image/png",
  sizeBytes,
  dataUrl: "data:image/png;base64," + createSizedPng(sizeBytes, "inert-inline").toString("base64"),
});
describe("actual old-source inline request observation", () => {
  it("observes one exact 10 MiB inline image without uploads probes or retained content", () => {
    const f = fixture();
    const wire = request(turn(image(10 * 1024 ** 2)));
    expect(f.socket.send(wire)).toBe(17);
    expect(f.sent).toEqual([wire]);
    expect(f.read()).toEqual({
      version: 1,
      complete: true,
      plainSockets: 1,
      uploadRequests: 0,
      turnRequests: 1,
      inlineAttachments: 1,
      inlineBytes: 10485760,
      stagedReferences: 0,
    });
    expect(JSON.stringify(f.read())).not.toMatch(/private|dataUrl|ticket|headers|prompt/);
  });
  it.each([undefined, null, "", [], {}, -1, 1.5, "x".repeat(129)])(
    "quarantines a Request with invalid id %s before image attribution",
    (id) => {
      const f = fixture();
      const wire = JSON.stringify({
        _tag: "Request",
        id,
        tag: "orchestration.dispatchCommand",
        payload: turn(image()),
        headers: [],
      });
      f.socket.send(wire);
      expect(f.read()).toMatchObject({ complete: false, inlineAttachments: 0, inlineBytes: 0 });
      expect(f.sent).toEqual([wire]);
    },
  );
  it.each([
    { type: "not-an-image" },
    { type: undefined },
    { id: undefined },
    { id: "invalid id" },
    { id: "x".repeat(129) },
    { name: undefined },
    { name: " " },
    { name: "x".repeat(256) },
    { mimeType: undefined },
    { mimeType: "text/plain" },
    { sizeBytes: undefined },
    { sizeBytes: -1 },
    { sizeBytes: 1.5 },
    { sizeBytes: 2 },
  ])(
    "quarantines malformed recognized image metadata without complete image counters",
    (mutation) => {
      const f = fixture();
      f.socket.send(request(turn({ ...image(), ...mutation })));
      expect(f.read()).toMatchObject({ complete: false, inlineAttachments: 0, inlineBytes: 0 });
    },
  );
  it("quarantines malformed image batches atomically", () => {
    const f = fixture();
    f.socket.send(
      request({
        type: "thread.turn.start",
        message: { attachments: [image(), { ...image(), type: "file" }] },
      }),
    );
    expect(f.read()).toMatchObject({ complete: false, inlineAttachments: 0, inlineBytes: 0 });
  });
  it("counts upload probes and staged references so they cannot qualify as inline", () => {
    const f = fixture();
    f.socket.send(request({}, "uploads.get"));
    f.socket.send(request(turn({ uploadId: "private-upload" })));
    expect(f.read()).toMatchObject({
      uploadRequests: 1,
      stagedReferences: 1,
      inlineAttachments: 0,
    });
  });
  it.each([
    "private-invalid-json",
    "A".repeat(15 * 1024 ** 2 + 1),
    request(turn({ ...image(), sizeBytes: 1, dataUrl: "data:image/png;base64,YR==" })),
  ])("marks malformed, oversized and noncanonical observed requests incomplete", (wire) => {
    const f = fixture();
    f.socket.send(wire);
    expect(f.read().complete).toBe(false);
    expect(f.sent).toEqual([wire]);
  });
  it("does not inspect a Noise or unrelated socket as plain inline evidence", () => {
    const f = fixture();
    const noise = new f.page.WebSocket("ws://127.0.0.1:4911/ws-e2ee");
    noise.send(Uint8Array.of(1, 2, 3));
    expect(f.read()).toMatchObject({ complete: true, plainSockets: 1, turnRequests: 0 });
  });
  it("rejects arbitrary browser fields and invalid counters before evidence retention", () => {
    const f = fixture();
    const observed = f.read();
    expect(projectInlineFallbackObservation(observed)).toEqual(observed);
    expect(projectInlineFallbackObservation({ ...observed, privatePath: "private" })).toBeNull();
    expect(
      projectInlineFallbackObservation({ ...observed, inlineBytes: Number.POSITIVE_INFINITY }),
    ).toBeNull();
    expect(projectInlineFallbackObservation({ ...observed, plainSockets: 17 })).toBeNull();
  });
});
