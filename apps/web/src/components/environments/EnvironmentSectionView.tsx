import type { EnvironmentWorkspaceSection } from "./environmentWorkspaceModel";

export function EnvironmentSectionView({
  section,
}: {
  readonly section: EnvironmentWorkspaceSection;
}) {
  return (
    <section className="space-y-4" aria-labelledby={`environment-section-${section.title}`}>
      <div>
        <h2
          id={`environment-section-${section.title}`}
          className="text-lg font-semibold tracking-tight text-foreground"
        >
          {section.title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
      </div>

      <dl className="overflow-hidden rounded-xl border border-border/70 bg-card/35">
        {section.fields.map((field) => (
          <div
            key={field.label}
            className="grid gap-1 border-t border-border/60 px-4 py-3 first:border-t-0 sm:grid-cols-[minmax(9rem,0.45fr)_minmax(0,1fr)] sm:items-start sm:gap-4"
          >
            <dt className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {field.label}
              {field.readOnly ? (
                <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] font-normal">
                  Read-only
                </span>
              ) : null}
            </dt>
            <dd className="min-w-0 break-words text-sm text-foreground">
              {field.value}
              {field.help ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{field.help}</p>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
