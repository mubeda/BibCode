import { fnv1a32 } from "../../../lib/diffRendering";

export interface AuthorIdentityInput {
  readonly name: string;
  readonly email: string;
}

export interface AuthorIdentity {
  readonly initials: string;
  readonly hue: number;
  readonly title: string;
}

function deriveInitials(label: string): string {
  const parts = label.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 0);
  if (parts.length === 0) return "?";
  const first = parts[0]?.charAt(0) ?? "?";
  const last = parts.length > 1 ? (parts.at(-1)?.charAt(0) ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

export function deriveAuthorIdentity({ name, email }: AuthorIdentityInput): AuthorIdentity {
  const normalizedName = name.trim();
  const normalizedEmail = email.trim().toLowerCase();
  const emailLocalPart = normalizedEmail.split("@", 1)[0] ?? "";
  const identityLabel = normalizedName || emailLocalPart;
  return {
    initials: deriveInitials(identityLabel),
    hue: fnv1a32(normalizedEmail) % 360,
    title:
      normalizedName.length > 0
        ? normalizedEmail.length > 0
          ? `${normalizedName} <${normalizedEmail}>`
          : normalizedName
        : normalizedEmail || "Unknown author",
  };
}
