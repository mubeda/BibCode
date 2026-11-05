// @effect-diagnostics globalTimers:off - Samples painted frames inside the packaged webview.
export interface KeyboardSample {
  readonly at: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
  /** How far the list is scrolled from its end. */
  readonly endGap: number;
  /** The latest keyboard reply's end below the usable bottom, zero or less when shown. */
  readonly endBelow: number | null;
  /** The latest keyboard reply's streamed paragraphs, and its last line as one more. */
  readonly delivered: number;
  readonly finished: boolean;
  /** Where the paragraph being read starts, below the visible top, once one is chosen. */
  readonly readingTop: number | null;
  /** Keydowns that reached the timeline's scroller so far. */
  readonly keydowns: number;
}

/** Samples the visible timeline after each painted frame, including list replacements. */
export async function startKeyboardSamples(surface: string, lastLine: string): Promise<void> {
  await browser.execute(
    (surface: string, lastLine: string) => {
      const record = window as unknown as {
        __bibcodeKeyboard?: {
          samples: KeyboardSample[];
          keyAt: number | null;
          reading: HTMLElement | null;
        };
        __bibcodeKeyboardStop?: () => void;
      };
      record.__bibcodeKeyboardStop?.();
      if (!document.querySelector(`${surface} [class*='overflow-anchor']`)) {
        throw new Error("The timeline scroller is missing.");
      }
      const state = {
        samples: [] as KeyboardSample[],
        keyAt: null as number | null,
        reading: null as HTMLElement | null,
      };
      record.__bibcodeKeyboard = state;
      const started = performance.now();
      let keydowns = 0;
      const onKeyDown = (event: KeyboardEvent) => {
        const scroller = document.querySelector(`${surface} [class*='overflow-anchor']`);
        if (!(event.target instanceof Node) || !scroller?.contains(event.target)) return;
        keydowns += 1;
        if (event.key === "PageUp") state.keyAt ??= performance.now() - started;
      };
      // Capture, so the count holds whatever the timeline's own listeners do with the key.
      document.addEventListener("keydown", onKeyDown, { capture: true });
      const read = (): KeyboardSample => {
        // Resolve at paint time: a retained node can be detached while document queries see a new list.
        const scroller = document.querySelector<HTMLElement>(
          `${surface} [class*='overflow-anchor']`,
        );
        const paragraphs = [...(scroller?.querySelectorAll<HTMLElement>(".chat-markdown p") ?? [])];
        // Earlier iterations keep the same text in history; only the lowest reply is current.
        const reply = [
          ...new Set(
            paragraphs
              .filter((element) => element.textContent === "Keyboard reply intro.")
              .map((element) => element.closest<HTMLElement>(".chat-markdown")),
          ),
        ]
          .filter((element) => element !== null)
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
          .at(-1);
        const replyParagraphs = [...(reply?.querySelectorAll("p") ?? [])];
        const area = scroller?.getBoundingClientRect();
        const reading = state.reading && scroller?.contains(state.reading) ? state.reading : null;
        const blocks = [
          ...(reply?.querySelectorAll<HTMLElement>(".chat-markdown p, .chat-markdown-codeblock") ??
            []),
        ];
        const end = Math.max(...blocks.map((block) => block.getBoundingClientRect().bottom));
        const composerTop = scroller
          ?.closest(surface)
          ?.querySelector('[data-chat-composer-form="true"]')
          ?.getBoundingClientRect().top;
        return {
          at: performance.now() - started,
          scrollTop: scroller?.scrollTop ?? 0,
          clientHeight: scroller?.clientHeight ?? 0,
          endGap: scroller
            ? Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
            : 0,
          endBelow:
            blocks.length === 0 || !area
              ? null
              : Math.round(end - Math.min(area.bottom, composerTop ?? area.bottom)),
          delivered:
            replyParagraphs.filter((element) =>
              element.textContent?.startsWith("Keyboard streamed paragraph"),
            ).length +
            (replyParagraphs.some((element) => element.textContent === lastLine) ? 1 : 0),
          finished:
            replyParagraphs.some((element) => element.textContent === lastLine) &&
            !scroller?.querySelector('[data-timeline-row-kind="working"]'),
          readingTop: reading && area ? reading.getBoundingClientRect().top - area.top : null,
          keydowns,
        };
      };
      let running = true;
      // A message posted from a frame callback is handled once that frame has painted.
      const afterPaint = new MessageChannel();
      afterPaint.port1.addEventListener("message", () => state.samples.push(read()));
      afterPaint.port1.start();
      const onFrame = () => {
        if (!running || performance.now() - started > 60_000) return;
        afterPaint.port2.postMessage(null);
        requestAnimationFrame(onFrame);
      };
      requestAnimationFrame(onFrame);
      record.__bibcodeKeyboardStop = () => {
        running = false;
        document.removeEventListener("keydown", onKeyDown, { capture: true });
        afterPaint.port1.close();
        afterPaint.port2.close();
      };
    },
    surface,
    lastLine,
  );
}
