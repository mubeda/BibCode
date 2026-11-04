import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("bibcode/no-em-dash-copy", {
  filename: "apps/web/src/fixture.tsx",
});
const testFileRule = createOxlintRuleHarness("bibcode/no-em-dash-copy", {
  filename: "apps/web/src/fixture.test.tsx",
});

const outOfScopeRule = createOxlintRuleHarness("bibcode/no-em-dash-copy", {
  filename: "scripts/example.tsx",
});
const fixtureRule = createOxlintRuleHarness("bibcode/no-em-dash-copy", {
  filename: "apps/web/src/fixtures/example.tsx",
});
const testDirRule = createOxlintRuleHarness("bibcode/no-em-dash-copy", {
  filename: "apps/web/src/test/mermaidCorpus.ts",
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

  outOfScopeRule.valid(
    "ignores files outside apps/*/src and packages/*/src",
    `export const l = "a ${DASH} b";`,
  );
  fixtureRule.valid("ignores fixture directories", `export const l = "a ${DASH} b";`);
  testDirRule.valid("ignores test directories", `export const l = "a ${DASH} b";`);

  rule.valid(
    "allows entity spelling in a plain string, which renders literally",
    `export const l = "a &mdash; b";`,
  );

  rule.invalid(
    "reports an entity in a JSX attribute string",
    `export const A = () => <button title="Locked &mdash; wait" />;`,
    (output) => {
      assert.match(output, /Do not use an em dash/);
    },
  );

  for (const entity of ["&mdash;", "&#8212;", "&#x2014;", "&#08212;", "&#x02014;"]) {
    rule.invalid(
      `reports the ${entity} entity in JSX text`,
      `export const A = () => <span>a ${entity} b</span>;`,
      (output) => {
        assert.match(output, /Do not use an em dash/);
      },
    );
  }

  rule.invalid(
    "reports a lone entity placeholder written as an entity",
    `export const A = () => <span>&mdash;</span>;`,
    (output) => {
      assert.match(output, /Do not use an em dash/);
    },
  );

  rule.invalid(
    "reports a padded separator string",
    `export const l = (a: string, b: string) => a + " ${DASH} " + b;`,
    (output) => {
      assert.match(output, /Do not use an em dash/);
    },
  );

  rule.invalid(
    "reports a padded separator in a JSX expression",
    `export const A = () => <span>{" ${DASH} "}</span>;`,
    (output) => {
      assert.match(output, /Do not use an em dash/);
    },
  );
});
