/**
 * Hostile diagram SVG whose every resource names a same-origin `/mermaid-probe/` path. The
 * production CSPs allow same-origin loads and raise no event for them, so a request for one of
 * these paths is the evidence that the sanitizer let a resource through. The typography
 * gallery inserts each through the sanitizer and its capture fails on any such request (#171).
 */
export const MERMAID_SANITIZER_PROBES: ReadonlyArray<{
  readonly name: string;
  readonly svg: string;
}> = [
  { name: "link", svg: '<a href="/mermaid-probe/link"><text x="4" y="14">Link</text></a>' },
  { name: "image", svg: '<image href="/mermaid-probe/image" width="40" height="20"></image>' },
  { name: "use", svg: '<use href="/mermaid-probe/use.svg#shape"></use>' },
  {
    name: "fill url",
    svg: '<rect width="40" height="20" style="fill:url(/mermaid-probe/fill)"></rect>',
  },
  {
    name: "image-set",
    svg: '<rect width="40" height="20" style="background-image:image-set(&quot;/mermaid-probe/a&quot; 1x)"></rect>',
  },
  {
    name: "escaped url in style",
    svg: '<rect width="40" height="20" style="fill:u\\72l(/mermaid-probe/b)"></rect>',
  },
  {
    name: "escaped url attribute",
    svg: '<rect width="40" height="20" fill="u\\72l(/mermaid-probe/c)"></rect>',
  },
  {
    name: "custom property url",
    svg: '<g style="--_fg:url(/mermaid-probe/d)"><rect width="40" height="20" fill="var(--_fg)"></rect></g>',
  },
  {
    name: "var fallback url",
    svg: '<rect width="40" height="20" style="fill:var(--x,url(/mermaid-probe/e))"></rect>',
  },
  {
    name: "foreign image",
    svg: '<foreignObject width="40" height="20"><img src="/mermaid-probe/foreign"></foreignObject>',
  },
  {
    name: "style element",
    svg: '<style>rect{fill:url(/mermaid-probe/style)}</style><rect width="40" height="20"></rect>',
  },
  {
    name: "filter image",
    svg: '<filter id="probe-filter"><feImage href="/mermaid-probe/filter"></feImage></filter><rect width="40" height="20" filter="url(#probe-filter)"></rect>',
  },
  {
    name: "mask",
    svg: '<rect width="40" height="20" mask="url(/mermaid-probe/mask.svg#m)"></rect>',
  },
].map(({ name, svg }) => ({
  name,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24" width="48" height="24">${svg}</svg>`,
}));
