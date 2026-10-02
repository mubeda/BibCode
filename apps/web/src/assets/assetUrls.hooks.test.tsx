import { EnvironmentId } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const h = vi.hoisted(() => ({
  value: null as string | null,
  values: [] as Array<string | null>,
  selected: [] as string[],
  raw: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { selected: string; value: unknown }) => {
    h.selected.push(atom.selected);
    return atom.value;
  },
}));
vi.mock("~/state/assets", () => ({
  assetEnvironment: {
    url: () => ({ selected: "resolved-one", value: h.value }),
    urls: () => ({ selected: "resolved-many", value: h.values }),
    createUrl: () => {
      h.raw();
      return {
        selected: "raw-one",
        value: { _tag: "Success", value: { relativeUrl: "/api/assets/cap/a.png" } },
      };
    },
    createUrls: () => {
      h.raw();
      return { selected: "raw-many", value: [] };
    },
  },
}));
vi.mock("~/state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://old.invalid" } }),
}));
import { useAssetUrl, useAssetUrls } from "./assetUrls";
const env = EnvironmentId.make("images");
beforeEach(() => {
  h.value = null;
  h.values = [];
  h.selected = [];
  h.raw.mockClear();
});
describe("asset hook public resolved-atom binding", () => {
  it.each(["blob:leased", null, "https://actual.invalid/api/assets/cap/a.png"])(
    "returns selected %s without an HTTP mint subscription",
    (value) => {
      h.value = value;
      function Probe() {
        const observed = useAssetUrl(env, { _tag: "attachment", attachmentId: "a" });
        return <output>{observed ?? "unavailable"}</output>;
      }
      expect(renderToStaticMarkup(<Probe />)).toBe(`<output>${value ?? "unavailable"}</output>`);
      expect(h.selected).toEqual(["resolved-one"]);
      expect(h.raw).not.toHaveBeenCalled();
    },
  );
  it("keeps one resolved value per resource including unavailable names", () => {
    h.values = ["blob:leased", null];
    function Probe() {
      const observed = useAssetUrls(env, [
        { _tag: "attachment", attachmentId: "a" },
        { _tag: "attachment", attachmentId: "b" },
      ]);
      return <output>{observed.map((value) => value ?? "unavailable").join("|")}</output>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<output>blob:leased|unavailable</output>");
    expect(h.selected).toEqual(["resolved-many"]);
    expect(h.raw).not.toHaveBeenCalled();
  });
});
