/**
 * The `data-find-scope` names a timeline row gives its searchable text. Find in thread projects
 * each scope's text and finds the same scope in the mounted row to paint its matches.
 */

/** The n-th Markdown part of a message: a reply has one, a user body one per segment. */
export function markdownFindScope(index: number): string {
  return `md:${index}`;
}

export const ASSISTANT_MESSAGE_FIND_SCOPE = markdownFindScope(0);
export const PLAN_TITLE_FIND_SCOPE = "plan-title";
export const PLAN_BODY_FIND_SCOPE = "plan-body";
export const TOOL_COMMAND_FIND_SCOPE = "command";
