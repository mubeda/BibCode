// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useVisiblePullRequestRefresh } from "./useVisiblePullRequestRefresh";

function Probe({
  enabled,
  succeeded,
  paused = false,
  revalidate,
}: {
  enabled: boolean;
  succeeded: boolean;
  paused?: boolean;
  revalidate: () => void;
}) {
  useVisiblePullRequestRefresh({ enabled, succeeded, paused, revalidate });
  return null;
}

describe("useVisiblePullRequestRefresh", () => {
  let root: Root;
  let node: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    node = document.createElement("div");
    document.body.appendChild(node);
    root = createRoot(node);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    act(() => root.unmount());
    node.remove();
    vi.useRealTimers();
  });

  it("revalidates 20s after a visible success and stops when hidden", () => {
    const revalidate = vi.fn();
    act(() => {
      root.render(createElement(Probe, { enabled: true, succeeded: true, revalidate }));
    });
    act(() => vi.advanceTimersByTime(19_999));
    expect(revalidate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(revalidate).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(60_000));
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("does not schedule for a disabled route", () => {
    const revalidate = vi.fn();
    act(() => {
      root.render(createElement(Probe, { enabled: false, succeeded: true, revalidate }));
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("does not schedule or revalidate while paused", () => {
    const revalidate = vi.fn();
    act(() => {
      root.render(createElement(Probe, { enabled: true, succeeded: true, paused: true, revalidate }));
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("revalidates on show when the last success is older than 5s", () => {
    const revalidate = vi.fn();
    act(() => {
      root.render(createElement(Probe, { enabled: true, succeeded: true, revalidate }));
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(5_001));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});
