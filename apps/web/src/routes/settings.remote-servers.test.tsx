import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const captured = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock("../components/settings/remote-servers/RemoteServersSettings", () => ({
  RemoteServersSettings: (props: Record<string, unknown>) => {
    captured.props = props;
    return null;
  },
}));

import { Route } from "./settings.remote-servers";

describe("/settings/remote-servers", () => {
  it("keeps only recognized search params", () => {
    const validate = Route.options.validateSearch;
    if (typeof validate !== "function") throw new Error("validateSearch is not registered.");
    expect(validate({ tab: "share", code: "abc", junk: "x" })).toEqual({
      tab: "share",
      code: "abc",
    });
    expect(validate({ tab: "bogus", code: "" })).toEqual({});
    expect(validate({})).toEqual({});
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
});
