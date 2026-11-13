/*
 * The control set, order and commands follow Orca's formatting toolbar
 * (https://github.com/stablyai/orca, src/renderer/src/components/editor/rich-markdown/commands/
 * RichMarkdownToolbar.tsx). Copyright (c) 2026 Lovecast Inc. Licensed under the MIT License (full
 * text in detailsExtension.ts). Rebuilt on this repository's Button, Tooltip and Menu.
 */
import {
  Bold,
  Ellipsis,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Image,
  Italic,
  Link,
  List,
  ListCollapse,
  ListOrdered,
  ListTodo,
  Pilcrow,
  Strikethrough,
  TextQuote,
  type LucideIcon,
} from "lucide-react";
import { useSyncExternalStore } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import type { FormatName, RichMarkdownEditor } from "./richMarkdownExtensions";

const UNAVAILABLE_REASON = "Formatting is available in rendered view";

const FORMATS: ReadonlyArray<{ name: FormatName; label: string; icon: LucideIcon }> = [
  { name: "paragraph", label: "Paragraph", icon: Pilcrow },
  { name: "heading1", label: "Heading 1", icon: Heading1 },
  { name: "heading2", label: "Heading 2", icon: Heading2 },
  { name: "heading3", label: "Heading 3", icon: Heading3 },
  { name: "bold", label: "Bold", icon: Bold },
  { name: "italic", label: "Italic", icon: Italic },
  { name: "strike", label: "Strikethrough", icon: Strikethrough },
  { name: "bulletList", label: "Bullet list", icon: List },
  { name: "orderedList", label: "Numbered list", icon: ListOrdered },
  { name: "taskList", label: "Task list", icon: ListTodo },
  { name: "blockquote", label: "Quote", icon: TextQuote },
];

const MORE_FORMATS: ReadonlyArray<{ name: FormatName; label: string; icon: LucideIcon }> = [
  { name: "heading4", label: "Heading 4", icon: Heading4 },
  { name: "heading5", label: "Heading 5", icon: Heading5 },
  { name: "details", label: "Collapsible section", icon: ListCollapse },
];

const PRESSABLE: readonly FormatName[] = [...FORMATS.map((format) => format.name), "link"];

const noSubscription = () => () => {};

function FormatButton({
  label,
  icon: Icon,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  pressed?: boolean | undefined;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={pressed}
            aria-disabled={disabled || undefined}
            className={
              disabled
                ? "text-muted-foreground hover:text-muted-foreground"
                : pressed
                  ? "bg-accent text-foreground hover:text-foreground"
                  : "text-foreground hover:text-foreground"
            }
            size="icon-xs"
            variant="ghost"
            // Keep the editor's selection: a click on the toolbar must not take focus from it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={disabled ? undefined : onClick}
          >
            <Icon className="text-current" />
          </Button>
        }
      />
      <TooltipPopup>{disabled ? UNAVAILABLE_REASON : label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The Markdown formatting controls of the Files toolbar. Without an editor (source view, or a
 * file the editor cannot change) every control stays focusable and says why it does nothing.
 */
export function RichMarkdownFormatGroup({
  editor,
  onLink,
  onImage,
}: {
  editor: RichMarkdownEditor | null;
  onLink(): void;
  onImage(): void;
}) {
  // One character per format, so the group renders again only when an active state changes.
  const active = useSyncExternalStore(
    editor?.subscribe ?? noSubscription,
    () => PRESSABLE.map((name) => (editor?.isActive(name) ? "1" : "0")).join(""),
    () => "",
  );
  const disabled = editor === null;
  const isPressed = (name: FormatName) => active[PRESSABLE.indexOf(name)] === "1";

  return (
    <div aria-label="Formatting" className="flex items-center gap-0.5" role="group">
      {FORMATS.map((format) => (
        <FormatButton
          key={format.name}
          disabled={disabled}
          icon={format.icon}
          label={format.label}
          pressed={disabled ? undefined : isPressed(format.name)}
          onClick={() => editor?.run(format.name)}
        />
      ))}
      <FormatButton
        disabled={disabled}
        icon={Link}
        label="Link"
        pressed={disabled ? undefined : isPressed("link")}
        onClick={onLink}
      />
      <FormatButton disabled={disabled} icon={Image} label="Image" onClick={onImage} />
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                aria-disabled={disabled || undefined}
                aria-label="More formatting"
                disabled={disabled}
                nativeButton
                render={
                  <Button
                    className={disabled ? "text-muted-foreground" : "text-foreground"}
                    size="icon-xs"
                    variant="ghost"
                  />
                }
              >
                <Ellipsis className="text-current" />
              </MenuTrigger>
            }
          />
          <TooltipPopup>{disabled ? UNAVAILABLE_REASON : "More formatting"}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="start">
          {MORE_FORMATS.map((format) => (
            <MenuItem key={format.name} onClick={() => editor?.run(format.name)}>
              <format.icon aria-hidden="true" className="size-4" />
              {format.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}
