/*
 * The rules follow Orca's link bubble (https://github.com/stablyai/orca,
 * src/renderer/src/components/editor/rich-markdown/links/useLinkBubble.ts): an empty URL removes
 * the link, and an empty selection inserts the URL as linked text. Copyright (c) 2026 Lovecast Inc.
 * Licensed under the MIT License (full text in detailsExtension.ts).
 */
import { type FormEvent, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup } from "~/components/ui/popover";

import type { RichMarkdownEditor } from "./richMarkdownExtensions";

/** The selection's position on screen, captured when the dialog opens. */
function selectionAnchor(): { getBoundingClientRect(): DOMRect } | undefined {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return { getBoundingClientRect: () => rect };
}

function LinkForm({ editor, onDone }: { editor: RichMarkdownEditor; onDone: () => void }) {
  const [current] = useState(() => editor.currentLink());
  const [href, setHref] = useState(current?.href ?? "");

  const save = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = href.trim();
    if (trimmed) editor.setLink(trimmed);
    else if (current) editor.removeLink();
    onDone();
  };

  return (
    <form className="flex w-72 flex-col gap-2" onSubmit={save}>
      <Input
        aria-label="Link URL"
        autoFocus
        placeholder="https://"
        size="sm"
        type="url"
        value={href}
        onChange={(event) => setHref(event.currentTarget.value)}
      />
      <div className="flex justify-end gap-2">
        {current ? (
          <Button
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => {
              editor.removeLink();
              onDone();
            }}
          >
            Remove link
          </Button>
        ) : null}
        <Button size="xs" type="submit">
          Save
        </Button>
      </div>
    </form>
  );
}

/** Adds, changes or removes the link at the selection, anchored next to it (R27). */
export function RichMarkdownLinkPopover({
  editor,
  open,
  onOpenChange,
}: {
  editor: RichMarkdownEditor;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [anchor] = useState(selectionAnchor);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverPopup anchor={anchor} align="start">
        {open ? <LinkForm editor={editor} onDone={() => onOpenChange(false)} /> : null}
      </PopoverPopup>
    </Popover>
  );
}
