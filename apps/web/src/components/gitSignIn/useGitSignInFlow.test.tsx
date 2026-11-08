// @vitest-environment happy-dom

import type { EnvironmentId } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  settle: null as ((result: unknown) => void) | null,
  cancel: vi.fn(),
  runSignIn: vi.fn(),
}));

vi.mock("~/state/gitManager", () => ({ runGitSignIn: h.runSignIn }));

import { GitSignInPrompt } from "./GitSignInPrompt";
import { type GitSignInRequest, useGitSignInFlow } from "./useGitSignInFlow";

const offer = {
  remote: "origin",
  destination: `https://github.com/owner/${"a".repeat(60)}/repo.git`,
  host: "github.com",
  direction: "push" as const,
};

function Harness({ request }: { request: GitSignInRequest }) {
  const flow = useGitSignInFlow("environment-1" as EnvironmentId);
  const { offer: start } = flow;
  useEffect(() => start(request), [request, start]);
  if (flow.state === null) return <p>closed</p>;
  return (
    <GitSignInPrompt
      offer={flow.state.offer}
      phase={flow.state.phase}
      onCancel={flow.cancel}
      onNotNow={flow.decline}
      onSignIn={flow.approve}
    />
  );
}

describe("useGitSignInFlow", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onSignedIn = vi.fn();
  const onEnded = vi.fn();
  const request: GitSignInRequest = { offer, cwd: "/repo", onSignedIn, onEnded };
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    h.runSignIn.mockImplementation(() => ({
      result: new Promise((resolve) => {
        h.settle = resolve;
      }),
      cancel: () => {
        h.cancel();
        h.settle?.({ _tag: "Failure", cause: Cause.interrupt(1), waiting: false });
      },
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness request={request} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("names the destination and remote before anything opens", () => {
    const text = container.textContent ?? "";
    expect(text).toContain("Sign in to github.com/owner/");
    expect(text).toContain("…");
    expect(text).toContain("/repo.git?");
    expect(text).toContain("push to remote origin");
    expect(h.runSignIn).not.toHaveBeenCalled();
  });

  it("Not now ends with the authentication error", async () => {
    await act(async () => button("Not now")?.click());
    expect(onEnded).toHaveBeenCalledWith(
      "authentication",
      "Authentication failed. Check the configured credentials and try again.",
    );
    expect(container.textContent).toBe("closed");
  });

  it("waits with Cancel, then resumes once after a sign-in", async () => {
    await act(async () => button("Sign in")?.click());
    expect(container.textContent).toContain(
      "Finish signing in with Git Credential Manager in the window or browser page it opened.",
    );
    expect(button("Cancel")).toBeDefined();
    expect(h.runSignIn).toHaveBeenCalledWith(expect.anything(), {
      environmentId: "environment-1",
      input: { cwd: "/repo", remote: "origin", direction: "push", destination: offer.destination },
    });
    await act(async () =>
      h.settle?.({
        _tag: "Success",
        value: { outcome: "signedIn", message: "Signed in." },
        waiting: false,
      }),
    );
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("reports a timeout or Cancel without resuming", async () => {
    await act(async () => button("Sign in")?.click());
    await act(async () =>
      h.settle?.({
        _tag: "Success",
        value: {
          outcome: "timedOut",
          message: "Sign-in timed out after 10 minutes. Nothing was fetched or pushed.",
        },
        waiting: false,
      }),
    );
    expect(onEnded).toHaveBeenLastCalledWith(
      "sign-in-timed-out",
      "Sign-in timed out after 10 minutes. Nothing was fetched or pushed.",
    );

    await act(async () => root.render(<Harness request={{ ...request }} />));
    await act(async () => button("Sign in")?.click());
    await act(async () => button("Cancel")?.click());
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenLastCalledWith(
      "sign-in-cancelled",
      "Sign-in cancelled. Nothing was fetched or pushed.",
    );
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
