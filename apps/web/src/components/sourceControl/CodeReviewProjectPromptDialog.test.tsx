// @vitest-environment happy-dom

import { DEFAULT_CODE_REVIEW_PROMPT, EnvironmentId, ProjectId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => h.update,
}));

vi.mock("~/state/projects", () => ({
  projectEnvironment: { update: "project-update" },
}));

vi.mock("@bibcode/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (result: { interrupted?: boolean }) => result.interrupted === true,
  squashAtomCommandFailure: (result: { cause?: unknown }) => result.cause,
}));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: unknown }) =>
    open ? <div role="presentation">{children as never}</div> : null,
  DialogPopup: ({ children }: { children: unknown }) => (
    <div role="dialog">{children as never}</div>
  ),
  DialogHeader: ({ children }: { children: unknown }) => <header>{children as never}</header>,
  DialogTitle: ({ children }: { children: unknown }) => <h2>{children as never}</h2>,
  DialogDescription: ({ children }: { children: unknown }) => <p>{children as never}</p>,
  DialogPanel: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  DialogFooter: ({ children }: { children: unknown }) => <footer>{children as never}</footer>,
}));

import { CodeReviewProjectPromptDialog } from "./CodeReviewProjectPromptDialog";

const environmentId = EnvironmentId.make("environment-one");
const projectId = ProjectId.make("project-one");

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const onOpenChange = vi.fn();

async function renderDialog(projectPrompt: string, userPrompt = "") {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <CodeReviewProjectPromptDialog
        open
        onOpenChange={onOpenChange}
        environmentId={environmentId}
        projectId={projectId}
        projectPrompt={projectPrompt}
        userPrompt={userPrompt}
      />,
    ),
  );
}

const textarea = () => container!.querySelector("textarea")!;
const button = (label: string) =>
  [...container!.querySelectorAll("button")].find((element) => element.textContent === label)!;

async function type(value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(textarea(), value);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.update.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  onOpenChange.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("CodeReviewProjectPromptDialog (R100)", () => {
  it("shows the project prompt and saves edited text", async () => {
    await renderDialog("Project rules", "User rules");
    expect(textarea().value).toBe("Project rules");
    await type("Our rules");
    await click("Save");
    expect(h.update).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, codeReviewPrompt: "Our rules" },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the user prompt, or the default, when the project prompt is blank", async () => {
    await renderDialog("  ", "User rules");
    expect(textarea().value).toBe("User rules");
    await act(async () => root!.unmount());
    container!.remove();
    await renderDialog("", "");
    expect(textarea().value).toBe(DEFAULT_CODE_REVIEW_PROMPT);
  });

  it("stores an empty prompt after Reset", async () => {
    await renderDialog("Mine", "User rules");
    await click("Reset");
    expect(textarea().value).toBe("User rules");
    await click("Save");
    expect(h.update).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, codeReviewPrompt: "" },
    });
  });

  it("stores an empty prompt when the text equals the effective default", async () => {
    await renderDialog("", "");
    await click("Save");
    expect(h.update).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, codeReviewPrompt: "" },
    });
  });

  it("stays open with the text and the reason when the server refuses", async () => {
    h.update.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Project is deleted.") });
    await renderDialog("", "");
    await type("Our rules");
    await click("Save");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(textarea().value).toBe("Our rules");
    expect(container!.textContent).toContain("Project is deleted.");
  });

  it("counts characters and stops at 7,680", async () => {
    await renderDialog("abc");
    expect(container!.textContent).toContain("3 / 7,680");
    expect(textarea().maxLength).toBe(7_680);
    await type("x".repeat(7_690));
    expect(textarea().value).toHaveLength(7_680);
    expect(container!.textContent).toContain("7,680 / 7,680");
  });
});
