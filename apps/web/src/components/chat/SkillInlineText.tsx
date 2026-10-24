import { Children, cloneElement, isValidElement, type ReactNode } from "react";

import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "../composerInlineChip";
import { skillChipLabel, splitSkillTokens, type InlineSkill } from "../chatMarkdownPipeline";
import { cn } from "~/lib/utils";

export function SkillInlineText(props: { text: string; skills: ReadonlyArray<InlineSkill> }) {
  const segments = splitSkillTokens(props.text, props.skills);
  if (segments.length === 1 && segments[0]?.kind === "text") {
    return <>{props.text}</>;
  }
  return (
    <>
      {segments.map((segment) =>
        segment.kind === "text" ? (
          segment.text
        ) : (
          <SkillChip
            key={`${segment.start}:${segment.skill.name}`}
            skill={segment.skill}
            rawText={segment.rawText}
          />
        ),
      )}
    </>
  );
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<InlineSkill>,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} skills={skills} />;
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) {
      return child;
    }
    if (child.type === "code" || child.type === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSkillInlineMarkdownChildren(child.props.children, skills),
    );
  });
}

function SkillChip(props: { skill: InlineSkill; rawText: string }) {
  return (
    <span className="inline-flex align-middle leading-none" data-markdown-copy={props.rawText}>
      <span
        className={cn(
          CHAT_INLINE_CHIP_CLASS_NAME,
          "border-fuchsia-500/25 bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300",
        )}
      >
        <span
          aria-hidden="true"
          className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
          data-find-ignore=""
          dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
        />
        <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>{skillChipLabel(props.skill)}</span>
      </span>
    </span>
  );
}
