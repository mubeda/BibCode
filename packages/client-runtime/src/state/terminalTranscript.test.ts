import { describe, expect, it, vi } from "@effect/vitest";

import {
  createTerminalTranscript as createExportedTerminalTranscript,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES as exportedDefaultMaxBytes,
} from "./terminal.ts";
import { DEFAULT_MAX_TERMINAL_BUFFER_BYTES as sessionDefaultMaxBytes } from "./terminalSession.ts";
import {
  createTerminalTranscript,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
} from "./terminalTranscript.ts";

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

describe("createTerminalTranscript", () => {
  it("exports the shared default byte cap through the terminal API", () => {
    expect(DEFAULT_MAX_TERMINAL_BUFFER_BYTES).toBe(512 * 1024);
    expect(sessionDefaultMaxBytes).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
    expect(exportedDefaultMaxBytes).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
    expect(createExportedTerminalTranscript).toBe(createTerminalTranscript);
  });

  it("concatenates appended deltas in order", () => {
    const transcript = createTerminalTranscript();

    transcript.append("hello ");
    transcript.append("world");

    expect(transcript.snapshot()).toBe("hello world");
    expect(transcript.byteLength()).toBe(bytes("hello world"));
  });

  it("ignores an empty append", () => {
    const transcript = createTerminalTranscript();

    transcript.append("");

    expect(transcript.snapshot()).toBe("");
    expect(transcript.byteLength()).toBe(0);
  });

  it("evicts whole oldest chunks only after crossing the byte cap", () => {
    const transcript = createTerminalTranscript(4);

    transcript.append("ab");
    transcript.append("cd");
    expect(transcript.snapshot()).toBe("abcd");

    transcript.append("ef");

    expect(transcript.snapshot()).toBe("cdef");
    expect(transcript.byteLength()).toBe(4);
  });

  it("partially trims the oldest chunk when the overflow is smaller than it", () => {
    const transcript = createTerminalTranscript(4);

    transcript.append("abc");
    transcript.append("def");

    expect(transcript.snapshot()).toBe("cdef");
    expect(transcript.byteLength()).toBe(4);
  });

  it("trims a prefix at a UTF-8 boundary without producing replacement characters", () => {
    const transcript = createTerminalTranscript(4);

    transcript.append("😀😀");

    expect(transcript.snapshot()).toBe("😀");
    expect(transcript.snapshot()).not.toContain("�");
    expect(transcript.byteLength()).toBe(4);
  });

  it("drops a whole scalar when no complete UTF-8 suffix fits", () => {
    const transcript = createTerminalTranscript(1);

    transcript.append("😀");

    expect(transcript.snapshot()).toBe("");
    expect(transcript.byteLength()).toBe(0);
  });

  it("keeps bounded output ordered through repeated whole-chunk eviction", () => {
    const transcript = createTerminalTranscript(200);

    for (let index = 0; index < 200; index += 1) {
      transcript.append("a");
    }
    for (let index = 0; index < 200; index += 1) {
      transcript.append("b");
    }

    expect(transcript.snapshot()).toBe("b".repeat(200));
    expect(transcript.byteLength()).toBe(200);
  });

  it("encodes only appended deltas while materializing the full text on demand", () => {
    const transcript = createTerminalTranscript(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);

    for (let index = 0; index < 1_000; index += 1) {
      transcript.append(`line ${index}\n`);
    }

    const snapshot = transcript.snapshot();
    expect(snapshot.startsWith("line 0\n")).toBe(true);
    expect(snapshot.endsWith("line 999\n")).toBe(true);
    expect(transcript.byteLength()).toBe(bytes(snapshot));
  });

  it("performs no decoding during repeated partial-prefix eviction", () => {
    const decodeSpy = vi.spyOn(TextDecoder.prototype, "decode");

    try {
      const transcript = createTerminalTranscript(4 * 1024);
      transcript.append("a".repeat(64 * 1024));
      decodeSpy.mockClear();

      for (let index = 0; index < 4_096; index += 1) {
        transcript.append("b");
      }

      expect(decodeSpy).not.toHaveBeenCalled();
      expect(transcript.byteLength()).toBe(4 * 1024);

      expect(transcript.snapshot()).toBe("b".repeat(4 * 1024));
      expect(decodeSpy).toHaveBeenCalled();
    } finally {
      decodeSpy.mockRestore();
    }
  });

  it("matches a deterministic UTF-8 suffix reference model", () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const cap = 37;
    const transcript = createTerminalTranscript(cap);
    const deltas = ["a", "é", "😀", "\r\n", "xyz"] as const;
    let expected = "";
    let seed = 0x5eed_1234;

    const trimToCap = (value: string) => {
      const encoded = encoder.encode(value);
      if (encoded.byteLength <= cap) {
        return value;
      }

      let start = encoded.byteLength - cap;
      while (start < encoded.byteLength && (encoded[start]! & 0b1100_0000) === 0b1000_0000) {
        start += 1;
      }
      return decoder.decode(encoded.subarray(start));
    };

    for (let index = 0; index < 1_000; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      if (seed % 97 === 0) {
        transcript.clear();
        expected = "";
      } else {
        const delta = deltas[seed % deltas.length]!;
        transcript.append(delta);
        expected = trimToCap(`${expected}${delta}`);
      }

      expect(transcript.snapshot()).toBe(expected);
      expect(transcript.byteLength()).toBe(bytes(expected));
    }
  });

  it("clears retained chunks and can be reused", () => {
    const transcript = createTerminalTranscript(2);

    transcript.append("ab");
    transcript.append("cd");
    transcript.clear();

    expect(transcript.snapshot()).toBe("");
    expect(transcript.byteLength()).toBe(0);

    transcript.append("xy");
    expect(transcript.snapshot()).toBe("xy");
    expect(transcript.byteLength()).toBe(2);
  });

  it("preserves active DEC ?2004h bracketed paste mode across overflow eviction and clear", () => {
    const transcript = createTerminalTranscript(32);
    // Chunk-split multi-parameter DECSET enabling ?2004h
    transcript.append("\u001b[?1049;");
    transcript.append("2004;1004h");
    transcript.append("x".repeat(64));

    const snap = transcript.snapshot();
    expect(snap.endsWith("\u001b[?2004h")).toBe(true);
    expect(snap).toContain("x".repeat(32));

    // Preserving modes on clear keeps ?2004h for a running terminal.
    transcript.clear({ preserveModes: true });
    expect(transcript.snapshot()).toBe("\u001b[?2004h");

    // DECSTR soft reset turns ?2004h off.
    transcript.append("\u001b[!p");
    transcript.append("y".repeat(64));
    expect(transcript.snapshot()).toBe("y".repeat(32));

    // Re-enable, then RIS (\x1bc) turns ?2004h off.
    transcript.append("\u001b[?02004h");
    transcript.append("z".repeat(64));
    expect(transcript.snapshot().endsWith("\u001b[?2004h")).toBe(true);
    transcript.append("\u001bc");
    transcript.append("w".repeat(64));
    expect(transcript.snapshot()).toBe("w".repeat(32));

    // Re-enable, then ?2004l turns ?2004h off.
    transcript.append("\u001b[?2004h");
    transcript.append("a".repeat(64));
    expect(transcript.snapshot().endsWith("\u001b[?2004h")).toBe(true);
    transcript.append("\u001b[?2004l");
    transcript.append("b".repeat(64));
    expect(transcript.snapshot()).toBe("b".repeat(32));
  });

  it("matches xterm on C1 CSI, colon subparameters, parameterized DECSTR, and mid-sequence replay boundaries", () => {
    // C1 CSI (`\u009b?2004h`)
    const c1 = createTerminalTranscript(32);
    c1.append("\u009b?2004h");
    c1.append("a".repeat(64));
    expect(c1.snapshot().endsWith("\u001b[?2004h")).toBe(true);

    // Colon subparameter before `;2004h` (`\x1b[?1:2;2004h`) + parameterized DECSTR (`\x1b[0!p`)
    const sub = createTerminalTranscript(32);
    sub.append("\u001b[?1:2;2004h");
    sub.append("b".repeat(64));
    expect(sub.snapshot().endsWith("\u001b[?2004h")).toBe(true);
    sub.append("\u001b[0!p");
    sub.append("c".repeat(64));
    expect(sub.snapshot()).toBe("c".repeat(32));

    // Snapshot halfway through `\x1b[?2004l` places `?2004h` BEFORE the unfinished `\x1b[?20`
    // so the next live delta `"04l"` completes `\x1b[?2004l` cleanly.
    const midDisable = createTerminalTranscript(32);
    midDisable.append("\u001b[?2004h");
    midDisable.append("d".repeat(64));
    midDisable.append("\u001b[?20");
    const snap = midDisable.snapshot();
    expect(snap.endsWith("\u001b[?2004h\u001b[?20")).toBe(true);

    // Clear halfway through `\x1b[?2004h` preserves the unfinished `\x1b[?20` prefix so live
    // `"04h"` completes the transition.
    const midEnableClear = createTerminalTranscript(32);
    midEnableClear.append("\u001b[?20");
    midEnableClear.clear({ preserveModes: true });
    expect(midEnableClear.snapshot()).toBe("\u001b[?20");

    // Long (>128 chars) unfinished OSC title after history eviction inserts `?2004h` at the exact
    // sequence boundary without appending a duplicate truncated OSC opener.
    const longOscPayload = "t".repeat(200);
    const longOsc = `\u001b]0;${longOscPayload}`;
    const longWithMode = createTerminalTranscript(512);
    longWithMode.append("\u001b[?2004h");
    longWithMode.append("x".repeat(400));
    longWithMode.append(longOsc);
    const longSnap = longWithMode.snapshot();
    expect(longSnap.endsWith(`\u001b[?2004h${longOsc}`)).toBe(true);
    expect(longSnap.split("\u001b]0;")).toHaveLength(2);

    // Without `?2004h`, a long unfinished OSC after eviction is returned verbatim with no duplication.
    const longWithoutMode = createTerminalTranscript(512);
    longWithoutMode.append("x".repeat(400));
    longWithoutMode.append(longOsc);
    const longNoModeSnap = longWithoutMode.snapshot();
    expect(longNoModeSnap.endsWith(longOsc)).toBe(true);
    expect(longNoModeSnap.split("\u001b]0;")).toHaveLength(2);

    // Unfinished OSC larger than the entire transcript buffer restores `?2004h` at the start
    // without appending a truncated duplicate OSC opener.
    const oversizedOsc = createTerminalTranscript(64);
    oversizedOsc.append("\u001b[?2004h");
    oversizedOsc.append(longOsc);
    const oversizedSnap = oversizedOsc.snapshot();
    expect(oversizedSnap.startsWith("\u001b[?2004h")).toBe(true);
    expect(oversizedSnap).not.toContain("\u001b]0;");
  });
});
