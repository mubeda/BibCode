import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const captured = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock("../components/settings/remote-servers/RemoteServersSettings", () => ({
  RemoteServersSettings: (props: Record<string, unknown>) => {
    captured.props = props;
    return null;
  },
}));

import { Route, validateRemoteServersSearch } from "./settings.remote-servers";

describe("/settings/remote-servers", () => {
  it("keeps only recognized search params", () => {
    const validate = Route.options.validateSearch;
    if (typeof validate !== "function") throw new Error("validateSearch is not registered.");
    expect(validate({ tab: "share", code: "abc", action: "add-server", junk: "x" })).toEqual({
      tab: "share",
      code: "abc",
      action: "add-server",
    });
    expect(validate({ tab: "bogus", code: "" })).toEqual({});
    expect(validate({})).toEqual({});
  });

  it("accepts only the add-server action", () => {
    expect(validateRemoteServersSearch({ action: "add-server" })).toEqual({
      action: "add-server",
    });
    expect(validateRemoteServersSearch({ action: "other" })).toEqual({});
  });

  it("forwards the code search param as the initial pairing code", () => {
    const Component = Route.options.component;
    if (typeof Component !== "function") throw new Error("Route component is not registered.");
    vi.spyOn(Route, "useSearch").mockReturnValue({ code: "abc" } as never);
    vi.spyOn(Route, "useNavigate").mockReturnValue(vi.fn() as never);
    renderToStaticMarkup(<Component />);
    expect(captured.props).toMatchObject({
      initialTab: "connect",
      initialPairingCode: "abc",
    });
  });

  it("opens and consumes the one-shot add-server action", () => {
    const Component = Route.options.component;
    if (typeof Component !== "function") throw new Error("Route component is not registered.");
    const navigate = vi.fn();
    vi.spyOn(Route, "useSearch").mockReturnValue({
      tab: "share",
      code: "abc",
      action: "add-server",
    } as never);
    vi.spyOn(Route, "useNavigate").mockReturnValue(navigate as never);

    renderToStaticMarkup(<Component />);

    expect(captured.props).toMatchObject({
      initialTab: "connect",
      initialPairingCode: "abc",
      initialAddServerOpen: true,
    });
    const consume = captured.props?.["onAddServerActionConsumed"] as (() => void) | undefined;
    expect(consume).toBeDefined();
    consume?.();
    expect(navigate).toHaveBeenCalledWith({
      search: expect.any(Function),
      replace: true,
    });
    const update = navigate.mock.calls[0]?.[0].search as (
      previous: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(update({ tab: "share", code: "abc", action: "add-server" })).toEqual({
      tab: "share",
      code: "abc",
    });
  });
});
