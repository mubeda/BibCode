import * as Schema from "effect/Schema";

export const VcsDriverKind = Schema.Literals(["git", "jj", "unknown"]);
export type VcsDriverKind = typeof VcsDriverKind.Type;
