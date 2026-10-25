import type { EnvironmentId } from "@bibcode/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useMemo, useState } from "react";
import { useEnvironmentQuery } from "../../../state/query";
import { vcsEnvironment } from "../../../state/vcs";
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "../../ui/combobox";

/**
 * The list's ref filter: the checkout's branches and tags from local git (no host
 * call), and any typed name on Enter, for a ref this clone has not fetched.
 */
export function PipelinesBranchFilter({
  scope,
  value,
  onChange,
}: {
  scope: { environmentId: EnvironmentId; cwd: string };
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(value ?? "");
  const typed = search === value ? "" : search.trim();
  const [query] = useDebouncedValue(typed, { wait: 200 });
  // Refs load when the picker opens, never for a list that is only shown.
  const refsAtom = useMemo(
    () =>
      open
        ? vcsEnvironment.listRefs({
            environmentId: scope.environmentId,
            input: {
              cwd: scope.cwd,
              limit: 100,
              refKind: "all",
              includeMatchingRemoteRefs: true,
              ...(query ? { query } : {}),
            },
          })
        : null,
    [open, query, scope.cwd, scope.environmentId],
  );
  const refs = useEnvironmentQuery(refsAtom);
  const names = useMemo(
    () =>
      [
        ...new Set(
          (refs.data?.refs ?? []).flatMap((ref) => {
            const name =
              ref.isRemote && ref.remoteName ? ref.name.slice(ref.remoteName.length + 1) : ref.name;
            return name === "" || name === "HEAD" ? [] : [name];
          }),
        ),
      ].toSorted(),
    [refs.data],
  );
  const commit = (next: string | null) => {
    const trimmed = next?.trim() ?? "";
    onChange(trimmed === "" ? null : trimmed);
  };
  return (
    <Combobox
      items={names}
      filter={null}
      value={value}
      inputValue={search}
      onOpenChange={setOpen}
      onValueChange={(next) => {
        setSearch(next ?? "");
        commit(next);
      }}
      onInputValueChange={(next) => setSearch(next)}
    >
      <ComboboxInput
        aria-label="Branch or tag"
        placeholder="Filter by branch or tag"
        className="w-56"
        size="sm"
        maxLength={256}
        showClear={value !== null}
        onKeyDown={(event) => {
          // A ref this clone has not fetched can still be typed in full.
          if (event.key === "Enter" && typed !== "" && !names.includes(typed)) {
            event.preventDefault();
            commit(typed);
            setOpen(false);
          }
        }}
      />
      <ComboboxPopup>
        <ComboboxList data-text-surface="popover">
          {(name: string) => (
            <ComboboxItem key={name} value={name}>
              {name}
            </ComboboxItem>
          )}
        </ComboboxList>
        {refs.isPending ? (
          <p role="status" className="p-2 text-sm">
            Loading branches…
          </p>
        ) : null}
        {refs.error ? (
          <p role="alert" className="p-2 text-sm">
            Could not list this checkout's branches. Type a branch name and press Enter.
          </p>
        ) : null}
        {!refs.isPending && !refs.error && names.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">
            {typed ? `Press Enter to filter by ${typed}.` : "No branches in this checkout."}
          </p>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  );
}
