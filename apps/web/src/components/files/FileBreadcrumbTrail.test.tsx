// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import FileBreadcrumbTrail from "./FileBreadcrumbTrail";
import { fileBreadcrumbs } from "./filePath";

it("makes the project and folder crumbs buttons that report their path; the file stays text", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onReveal = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <FileBreadcrumbTrail
        breadcrumbs={fileBreadcrumbs("demo", "src/lib/app.ts")}
        projectName="demo"
        onReveal={onReveal}
      />,
    ),
  );

  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((b) => b.textContent)).toEqual(["demo", "src", "lib"]);
  expect(buttons.every((b) => b.type === "button")).toBe(true);
  const current = container.querySelector("[data-current-file-crumb='true']");
  expect(current?.textContent).toBe("app.ts");
  expect(current?.querySelector("button")).toBeNull();

  for (const button of buttons) await act(async () => button.click());
  expect(onReveal.mock.calls).toEqual([[""], ["src"], ["src/lib"]]);
  await act(async () => root.unmount());
});
