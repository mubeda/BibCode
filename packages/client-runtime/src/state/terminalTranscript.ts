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
  CsiParams: 7,
  CsiBang: 8,
  CsiDecPrivate: 9,
  CsiIgnore: 10,
} as const;
type ModeParseState = (typeof ModeParseState)[keyof typeof ModeParseState];

const MAX_PENDING_ESCAPE_CHARS = 128;

/**
 * Streaming VT state machine aligned with xterm.js tracking DEC private mode `?2004h`/`?2004l`
 * (bracketed paste) across arbitrary chunk boundaries, including C1 CSI (`\u009b`),
 * multi-parameter DECSET/DECRST with colon subparameters (`\x1b[?1:2;2004h`), RIS (`\x1bc`),
 * and parameterized DECSTR (`\x1b[0!p` / `\x1b[!p`). Also remembers any unfinished escape prefix
 * at the end of the stream so mode restoration is inserted at a parser-safe boundary and never
 * aborts an in-flight control sequence (#431).
 */
class BracketedPasteModeTracker {
  private state: ModeParseState = ModeParseState.Ground;
  private currentParam = 0;
  private inSubparam = false;
  private has2004 = false;
  private enabled = false;
  /** Unfinished control sequence at the end of the fed stream, when not in Ground. */
  private pendingSeq = "";

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Trailing incomplete escape sequence currently in progress (empty when in Ground). */
  pendingSequence(): string {
    return this.state === ModeParseState.Ground ? "" : this.pendingSeq;
  }

  reset(): void {
    this.state = ModeParseState.Ground;
    this.currentParam = 0;
    this.inSubparam = false;
    this.has2004 = false;
    this.enabled = false;
    this.pendingSeq = "";
  }

  feed(text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      const ch = text[index]!;
      this.step(code, ch);
    }
  }

  private enterGround(): void {
    this.state = ModeParseState.Ground;
    this.pendingSeq = "";
  }

  private beginPending(ch: string): void {
    this.pendingSeq = ch;
  }

  private appendPending(ch: string): void {
    if (this.pendingSeq.length < MAX_PENDING_ESCAPE_CHARS) {
      this.pendingSeq += ch;
    }
  }

  private enterCsi(prefixChar: string, startNew: boolean): void {
    if (startNew) this.beginPending(prefixChar);
    else this.appendPending(prefixChar);
    this.state = ModeParseState.CsiStart;
  }

  private step(code: number, ch: string): void {
    // Anywhere transitions per VT500 / xterm.js EscapeSequenceParser:
    // CAN (0x18), SUB (0x1a) abort to ground; ESC (0x1b) starts ESC (except ST handled in StringEsc);
    // C1 controls 0x9b (CSI), 0x9d (OSC), 0x90/0x98/0x9e/0x9f (DCS/SOS/PM/APC), 0x9c (ST).
    if (code === 0x18 || code === 0x1a || code === 0x9c) {
      this.enterGround();
      return;
    }
    if (code === 0x9b) {
      this.enterCsi(ch, true);
      return;
    }
    if (code === 0x9d) {
      this.beginPending(ch);
      this.state = ModeParseState.Osc;
      return;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      this.beginPending(ch);
      this.state = ModeParseState.StringSeq;
      return;
    }

    switch (this.state) {
      case ModeParseState.Ground:
        if (code === 0x1b) {
          this.beginPending(ch);
          this.state = ModeParseState.Esc;
        }
        return;
      case ModeParseState.Esc:
        this.stepEsc(code, ch);
        return;
      case ModeParseState.EscIntermediate:
        if (code === 0x1b) {
          this.beginPending(ch);
          this.state = ModeParseState.Esc;
        } else if (code >= 0x20 && code <= 0x2f) {
          this.appendPending(ch);
        } else {
          this.enterGround();
        }
        return;
      case ModeParseState.Osc:
        if (code === 0x07) {
          this.enterGround();
        } else if (code === 0x1b) {
          this.appendPending(ch);
          this.state = ModeParseState.StringEsc;
        } else {
          this.appendPending(ch);
        }
        return;
      case ModeParseState.StringSeq:
        if (code === 0x1b) {
          this.appendPending(ch);
          this.state = ModeParseState.StringEsc;
        } else {
          this.appendPending(ch);
        }
        return;
      case ModeParseState.StringEsc:
        if (code === 0x5c) {
          // ST (`\x1b\\`)
          this.enterGround();
        } else if (code === 0x1b) {
          this.beginPending(ch);
          this.state = ModeParseState.Esc;
        } else {
          this.beginPending("\u001b");
          this.stepEsc(code, ch);
        }
        return;
      case ModeParseState.CsiStart:
        if (code === 0x3f) {
          // `?`
          this.appendPending(ch);
          this.state = ModeParseState.CsiDecPrivate;
          this.currentParam = 0;
          this.inSubparam = false;
          this.has2004 = false;
        } else if (code === 0x21) {
          // `!`
          this.appendPending(ch);
          this.state = ModeParseState.CsiBang;
        } else if ((code >= 0x30 && code <= 0x39) || code === 0x3b || code === 0x3a) {
          // Parameter digits/separators before `!p` (e.g. `\x1b[0!p`) or other CSI finals
          this.appendPending(ch);
          this.state = ModeParseState.CsiParams;
        } else if (code === 0x1b) {
          this.beginPending(ch);
          this.state = ModeParseState.Esc;
        } else if (code >= 0x40 && code <= 0x7e) {
          this.enterGround();
        } else if (code >= 0x20) {
          this.appendPending(ch);
          this.state = ModeParseState.CsiIgnore;
        } else {
          this.appendPending(ch);
        }
        return;
      case ModeParseState.CsiParams:
        if ((code >= 0x30 && code <= 0x39) || code === 0x3b || code === 0x3a) {
          this.appendPending(ch);
        } else if (code === 0x21) {
          // `!` intermediate after numeric params: parameterized DECSTR (`\x1b[0!p`)
          this.appendPending(ch);
          this.state = ModeParseState.CsiBang;
        } else if (code === 0x1b) {
          this.beginPending(ch);
          this.state = ModeParseState.Esc;
        } else if (code >= 0x40 && code <= 0x7e) {
          this.enterGround();
        } else if (code >= 0x20) {
          this.appendPending(ch);
          this.state = ModeParseState.CsiIgnore;
        } else {
          this.appendPending(ch);
        }
        return;
      case ModeParseState.CsiBang:
        if (code === 0x70) {
          // DECSTR (`\x1b[!p` or `\x1b[0!p`) resets DEC private modes including ?2004.
          this.enabled = false;
          this.enterGround();
        } else if (code === 0x1b) {
          this.beginPending(ch);
          this.state = ModeParseState.Esc;
        } else if (code >= 0x40 && code <= 0x7e) {
          this.enterGround();
        } else if (code >= 0x20) {
          this.appendPending(ch);
          this.state = ModeParseState.CsiIgnore;
        } else {
          this.appendPending(ch);
        }
        return;
      case ModeParseState.CsiDecPrivate:
        if (code >= 0x30 && code <= 0x39) {
          this.appendPending(ch);
          if (!this.inSubparam) {
            this.currentParam = Math.min(999_999, this.currentParam * 10 + (code - 0x30));
          }
        } else if (code === 0x3a) {
          // `:` starts a subparameter on the current parameter (e.g. `?1:2;2004h`).
          this.appendPending(ch);
          this.inSubparam = true;
        } else if (code === 0x3b) {
          // `;` advances to the next parameter.
          this.appendPending(ch);
          if (this.currentParam === 2004) this.has2004 = true;
          this.currentParam = 0;
          this.inSubparam = false;
        } else if (code === 0x68 || code === 0x6c) {
          // `h` (DECSET) or `l` (DECRST)
          if (this.has2004 || this.currentParam === 2004) {
            this.enabled = code === 0x68;
          }
          this.enterGround();
        } else if (code === 0x1b) {
          this.beginPending(ch);
          this.state = ModeParseState.Esc;
        } else if (code >= 0x40 && code <= 0x7e) {
          this.enterGround();
        } else if (code >= 0x20) {
          this.appendPending(ch);
          this.state = ModeParseState.CsiIgnore;
        } else {
          this.appendPending(ch);
        }
        return;
      case ModeParseState.CsiIgnore:
        if (code === 0x1b) {
          this.beginPending(ch);
          this.state = ModeParseState.Esc;
        } else if (code >= 0x40 && code <= 0x7e) {
          this.enterGround();
        } else {
          this.appendPending(ch);
        }
        return;
    }
  }

  private stepEsc(code: number, ch: string): void {
    if (code === 0x63) {
      // RIS (`\x1bc`)
      this.enabled = false;
      this.enterGround();
    } else if (code === 0x5b) {
      // `[`
      this.enterCsi(ch, false);
    } else if (code === 0x5d) {
      // `]`
      this.appendPending(ch);
      this.state = ModeParseState.Osc;
    } else if (code === 0x50 || code === 0x5f || code === 0x5e || code === 0x58) {
      // DCS (`P`), APC (`_`), PM (`^`), SOS (`X`)
      this.appendPending(ch);
      this.state = ModeParseState.StringSeq;
    } else if (code >= 0x20 && code <= 0x2f) {
      this.appendPending(ch);
      this.state = ModeParseState.EscIntermediate;
    } else if (code === 0x1b) {
      this.beginPending(ch);
      this.state = ModeParseState.Esc;
    } else {
      this.enterGround();
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
      modeTracker.feed(delta);
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
        const pending = modeTracker.pendingSequence();
        if (modeTracker.isEnabled() || pending.length > 0) {
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
      const retainedParts: Array<string> = [];
      for (let index = head; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        retainedParts.push(decoder.decode(chunk.bytes.subarray(chunk.start)));
      }
      const joined = retainedParts.join("");
      if (!discardedPrefix) {
        return joined;
      }
      const pending = modeTracker.pendingSequence();
      const restore = modeTracker.isEnabled() ? BRACKETED_PASTE_ENABLE_SEQUENCE : "";
      if (restore.length === 0 && pending.length === 0) {
        return joined;
      }
      // Insert the synthetic `?2004h` at a parser-safe boundary BEFORE any unfinished control
      // sequence still arriving from the PTY so the next live delta completes it cleanly.
      if (pending.length > 0) {
        if (joined.endsWith(pending)) {
          return `${joined.slice(0, joined.length - pending.length)}${restore}${pending}`;
        }
        return `${joined}${restore}${pending}`;
      }
      return `${joined}${restore}`;
    },
    byteLength() {
      return totalBytes;
    },
  };
}
