export interface TagNameValidation {
  readonly valid: boolean;
  readonly reason: string | null;
}

export interface TagDeleteDialogCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
}

export function validateTagName(
  name: string,
  existingTags: ReadonlyArray<string>,
): TagNameValidation {
  if (existingTags.includes(name)) {
    return { valid: false, reason: `A tag named ${name} already exists.` };
  }
  if ([...name].length > 245) {
    return { valid: false, reason: "Tag names must be 245 characters or fewer." };
  }
  const invalidCharacter = [...name].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
  });
  const invalidComponent = name
    .split("/")
    .some(
      (component) =>
        component.length === 0 || component.startsWith(".") || component.endsWith(".lock"),
    );
  if (
    name.length === 0 ||
    name.trim() !== name ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.includes("..") ||
    name.includes("@{") ||
    name === "@" ||
    invalidCharacter ||
    invalidComponent
  ) {
    return { valid: false, reason: "Enter a valid Git tag name." };
  }
  return { valid: true, reason: null };
}

export function resolveTagDeleteDialogCopy(tag: string): TagDeleteDialogCopy {
  return {
    title: `Delete tag ${tag}?`,
    description: `This deletes the local tag ${tag}. A tag already pushed to a remote is not deleted there.`,
    confirmLabel: "Delete Tag",
  };
}
