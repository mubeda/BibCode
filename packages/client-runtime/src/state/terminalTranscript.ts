export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
const BRACKETED_PASTE_ENABLE_SEQUENCE = "\u001b[?2004h";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MIN_DEAD_CHUNKS_BEFORE_COMPACTION = 64;

const ModeParseState = {
  Ground: 0,
  Esc: 1,
  EscIntermediate: 2,
  Osc: 3,
  StringSeq: 4,
  StringEsc: 5,
  CsiStart: 6,
  CsiBang: 7,
  CsiDecPrivate: 8,
  CsiIgnore: 9,
} as const;
type ModeParseState = (typeof ModeParseState)[keyof typeof ModeParseState];

/**
 * Streaming VT state machine tracking DEC private mode `?2004h`/`?2004l` (bracketed paste)
 * across arbitrary chunk boundaries, including multi-parameter DECSET/DECRST, RIS (`\x1bc`),
 * and DECSTR (`\x1b[!p`).
 */
class BracketedPasteModeTracker {
  private state: ModeParseState = ModeParseState.Ground;
  private currentParam = 0;
  private has2004 = false;
  private validPrivate = true;
  private enabled = false;

  isEnabled(): boolean {
    return this.enabled;
  }

  reset(): void {
    this.state = ModeParseState.Ground;
    this.currentParam = 0;
    this.has2004 = false;
    this.validPrivate = true;
    this.enabled = false;
  }

  feed(bytes: Uint8Array): void {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      const byte = bytes[index]!;
      this.step(byte);
    }
  }

  private step(byte: number): void {
    switch (this.state) {
      case ModeParseState.Ground:
        if (byte === 0x1b) this.state = ModeParseState.Esc;
        return;
      case ModeParseState.Esc:
        this.stepEsc(byte);
        return;
      case ModeParseState.EscIntermediate:
        if (byte === 0x1b) {
          this.state = ModeParseState.Esc;
        } else if (byte >= 0x20 && byte <= 0x2f) {
          // Stay in intermediate state.
        } else {
          this.state = ModeParseState.Ground;
        }
        return;
      case ModeParseState.Osc:
        if (byte === 0x07 || byte === 0x18 || byte === 0x1a) {
          this.state = ModeParseState.Ground;
        } else if (byte === 0x1b) {
          this.state = ModeParseState.StringEsc;
        }
        return;
      case ModeParseState.StringSeq:
        if (byte === 0x18 || byte === 0x1a) {
          this.state = ModeParseState.Ground;
        } else if (byte === 0x1b) {
          this.state = ModeParseState.StringEsc;
        }
        return;
      case ModeParseState.StringEsc:
        if (byte === 0x5c) {
          // ST (`\x1b\\`)
          this.state = ModeParseState.Ground;
        } else if (byte === 0x1b) {
          this.state = ModeParseState.StringEsc;
        } else {
          this.stepEsc(byte);
        }
        return;
      case ModeParseState.CsiStart:
        if (byte === 0x3f) {
          // `?`
          this.state = ModeParseState.CsiDecPrivate;
          this.currentParam = 0;
          this.has2004 = false;
          this.validPrivate = true;
        } else if (byte === 0x21) {
          // `!`
          this.state = ModeParseState.CsiBang;
        } else if (byte === 0x1b) {
          this.state = ModeParseState.Esc;
        } else if (byte === 0x18 || byte === 0x1a) {
          this.state = ModeParseState.Ground;
        } else if (byte >= 0x40 && byte <= 0x7e) {
          this.state = ModeParseState.Ground;
        } else if (byte >= 0x20) {
          this.state = ModeParseState.CsiIgnore;
        }
        return;
      case ModeParseState.CsiBang:
        if (byte === 0x70) {
          // DECSTR (`\x1b[!p`) resets DEC private modes including ?2004.
          this.enabled = false;
          this.state = ModeParseState.Ground;
        } else if (byte === 0x1b) {
          this.state = ModeParseState.Esc;
        } else if (byte === 0x18 || byte === 0x1a) {
          this.state = ModeParseState.Ground;
        } else if (byte >= 0x40 && byte <= 0x7e) {
          this.state = ModeParseState.Ground;
        } else if (byte >= 0x20) {
          this.state = ModeParseState.CsiIgnore;
        }
        return;
      case ModeParseState.CsiDecPrivate:
        if (byte >= 0x30 && byte <= 0x39) {
          this.currentParam = Math.min(999_999, this.currentParam * 10 + (byte - 0x30));
        } else if (byte === 0x3b) {
          // `;`
          if (this.currentParam === 2004) this.has2004 = true;
          this.currentParam = 0;
        } else if (byte === 0x68 || byte === 0x6c) {
          // `h` (DECSET) or `l` (DECRST)
          if (this.validPrivate && (this.has2004 || this.currentParam === 2004)) {
            this.enabled = byte === 0x68;
          }
          this.state = ModeParseState.Ground;
        } else if (byte === 0x1b) {
          this.state = ModeParseState.Esc;
        } else if (byte === 0x18 || byte === 0x1a) {
          this.state = ModeParseState.Ground;
        } else if (byte >= 0x40 && byte <= 0x7e) {
          this.state = ModeParseState.Ground;
        } else if (byte >= 0x20) {
          this.validPrivate = false;
          this.state = ModeParseState.CsiIgnore;
        }
        return;
      case ModeParseState.CsiIgnore:
        if (byte === 0x1b) {
          this.state = ModeParseState.Esc;
        } else if (byte === 0x18 || byte === 0x1a || (byte >= 0x40 && byte <= 0x7e)) {
          this.state = ModeParseState.Ground;
        }
        return;
    }
  }

  private stepEsc(byte: number): void {
    if (byte === 0x63) {
      // RIS (`\x1bc`)
      this.enabled = false;
      this.state = ModeParseState.Ground;
    } else if (byte === 0x5b) {
      // `[`
      this.state = ModeParseState.CsiStart;
    } else if (byte === 0x5d) {
      // `]`
      this.state = ModeParseState.Osc;
    } else if (byte === 0x50 || byte === 0x5f || byte === 0x5e || byte === 0x58) {
      // DCS (`P`), APC (`_`), PM (`^`), SOS (`X`)
      this.state = ModeParseState.StringSeq;
    } else if (byte >= 0x20 && byte <= 0x2f) {
      this.state = ModeParseState.EscIntermediate;
    } else if (byte === 0x1b) {
      this.state = ModeParseState.Esc;
    } else {
      this.state = ModeParseState.Ground;
    }
  }
}

interface TranscriptChunk {
  bytes: Uint8Array;
  start: number;
}

export interface TerminalTranscriptClearOptions {
  /** Keeps active terminal modes (e.g. `?2004h`) across a running terminal's scrollback clear. */
  readonly preserveModes?: boolean;
}

export interface TerminalTranscript {
  /** Appends a delta, encoding only the new delta before evicting the oldest overflow. */
  append(delta: string): void;
  clear(options?: TerminalTranscriptClearOptions): void;
  /** Clears tracked live terminal modes without dropping retained scrollback (e.g. on exit). */
  resetModes(): void;
  /** Materializes the retained transcript only when a snapshot is requested. */
  snapshot(): string;
  byteLength(): number;
}

export function createTerminalTranscript(
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalTranscript {
  const chunks: Array<TranscriptChunk | null> = [];
  const modeTracker = new BracketedPasteModeTracker();
  let head = 0;
  let totalBytes = 0;
  let discardedPrefix = false;

  const compactDeadChunks = () => {
    if (head >= MIN_DEAD_CHUNKS_BEFORE_COMPACTION && head * 2 >= chunks.length) {
      chunks.splice(0, head);
      head = 0;
    }
  };

  const dropFrontChunk = () => {
    const front = chunks[head]!;
    totalBytes -= front.bytes.byteLength - front.start;
    chunks[head] = null;
    head += 1;
    compactDeadChunks();
  };

  const evictOverflow = () => {
    while (totalBytes > maxBufferBytes && head < chunks.length) {
      discardedPrefix = true;
      const overflow = totalBytes - maxBufferBytes;
      const front = chunks[head]!;
      if (front.bytes.byteLength - front.start <= overflow) {
        dropFrontChunk();
        continue;
      }

      let start = front.start + overflow;
      while (
        start < front.bytes.byteLength &&
        (front.bytes[start]! & 0b1100_0000) === 0b1000_0000
      ) {
        start += 1;
      }

      const retainedByteLength = front.bytes.byteLength - start;
      if (retainedByteLength === 0) {
        dropFrontChunk();
      } else {
        totalBytes -= start - front.start;
        if (start >= retainedByteLength) {
          front.bytes = front.bytes.slice(start);
          front.start = 0;
        } else {
          front.start = start;
        }
      }
    }
  };

  return {
    append(delta) {
      if (delta.length === 0) {
        return;
      }

      const encoded = encoder.encode(delta);
      modeTracker.feed(encoded);
      chunks.push({ bytes: encoded, start: 0 });
      totalBytes += encoded.byteLength;
      if (totalBytes > maxBufferBytes) {
        evictOverflow();
      }
    },
    clear(options) {
      chunks.length = 0;
      head = 0;
      totalBytes = 0;
      if (options?.preserveModes === true) {
        if (modeTracker.isEnabled()) {
          discardedPrefix = true;
        }
      } else {
        discardedPrefix = false;
        modeTracker.reset();
      }
    },
    resetModes() {
      discardedPrefix = false;
      modeTracker.reset();
    },
    snapshot() {
      const retainedText: Array<string> = [];
      for (let index = head; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        retainedText.push(decoder.decode(chunk.bytes.subarray(chunk.start)));
      }
      if (discardedPrefix && modeTracker.isEnabled()) {
        retainedText.push(BRACKETED_PASTE_ENABLE_SEQUENCE);
      }
      return retainedText.join("");
    },
    byteLength() {
      return totalBytes;
    },
  };
}
