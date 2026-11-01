import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("bibcode/no-em-dash-copy", { filename: "fixture.tsx" });
const testFileRule = createOxlintRuleHarness("bibcode/no-em-dash-copy", {
  filename: "fixture.test.tsx",
});

const DASH = "—";

describe("bibcode/no-em-dash-copy", () => {
  rule.valid("allows a lone placeholder string", `export const empty = "${DASH}";`);

  rule.valid(
    "allows a lone placeholder in JSX text, a template, and a fallback",
    `
      export const A = (props: { value?: string }) => (
        <div>
          <span>${DASH}</span>
          <span>{props.value ?? "${DASH}"}</span>
          <span>{\`${DASH}\`}</span>
        </div>
      );
    `,
  );

  rule.valid("allows hyphens and en dashes", `export const label = "a - b – c";`);

  testFileRule.valid(
    "ignores test files",
    `export const label = "Diff too large ${DASH} open on host";`,
  );

  rule.invalid(
    "reports an em dash separator in a string",
    `export const label = "Diff too large ${DASH} open on host";`,
    (output) => {
      assert.match(output, /Do not use an em dash in interface copy/);
    },
  );

  rule.invalid(
    "reports an em dash in a template literal",
    `export const label = (a: string, b: string) => \`\${a} ${DASH} \${b}\`;`,
    (output) => {
      assert.match(output, /Do not use an em dash/);
    },
  );

  rule.invalid(
    "reports an em dash that is part of JSX text",
    `export const A = (props: { reason: string }) => <span> ${DASH} {props.reason}</span>;`,
    (output) => {
      assert.match(output, /Do not use an em dash/);
    },
  );

  rule.invalid(
    "reports an em dash in a JSX attribute string",
    `export const A = () => <input title="Locked ${DASH} wait" />;`,
    (output) => {
      assert.match(output, /Do not use an em dash/);
    },
  );
});
