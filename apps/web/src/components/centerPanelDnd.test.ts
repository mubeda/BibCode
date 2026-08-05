import { describe, expect, it } from "vite-plus/test";
import {
  canCenterPanelPaneSplit,
  captureCenterPanelDropGeometry,
  isCenterPanelPaneDropData,
  isCenterPanelTabDragData,
  resolveCenterPanelDropIntent,
  resolveCenterPanelInsertionIndex,
  resolveCenterPanelSplitDirection,
  type CenterPanelDropGeometry,
} from "./centerPanelDnd";

const geometry: CenterPanelDropGeometry = {
  pane: { left: 100, right: 500, top: 100, bottom: 500, width: 400, height: 400 },
  tabStripBottom: 132,
};

describe("center panel drag/drop metadata", () => {
  it("accepts only complete center panel tab drag metadata", () => {
    expect(
      isCenterPanelTabDragData({
        type: "center-panel-tab",
        surfaceId: "surface-1",
        groupId: "group-1",
        surfaceKind: "chat",
        title: "Chat",
      }),
    ).toBe(true);
    expect(isCenterPanelTabDragData({ type: "center-panel-tab", surfaceId: "surface-1" })).toBe(
      false,
    );
    expect(isCenterPanelTabDragData({ type: "center-panel-tab", surfaceId: 1 })).toBe(false);
  });

  it("accepts only complete center panel pane drop metadata", () => {
    expect(isCenterPanelPaneDropData({ type: "center-panel-pane", groupId: "group-1" })).toBe(true);
    expect(isCenterPanelPaneDropData({ type: "center-panel-pane", groupId: 1 })).toBe(false);
    expect(isCenterPanelPaneDropData(null)).toBe(false);
  });
});

describe("captureCenterPanelDropGeometry", () => {
  it("captures a pane rectangle and tab strip boundary from literal rectangles", () => {
    expect(
      captureCenterPanelDropGeometry(
        { left: 100, right: 500, top: 100, bottom: 500, width: 400, height: 400 },
        { left: 100, right: 500, top: 100, bottom: 132, width: 400, height: 32 },
      ),
    ).toEqual(geometry);
  });

  it("rejects invalid and non-finite rectangles", () => {
    expect(
      captureCenterPanelDropGeometry(
        { left: 100, right: 100, top: 100, bottom: 500, width: 0, height: 400 },
        { left: 100, right: 500, top: 100, bottom: 132, width: 400, height: 32 },
      ),
    ).toBeNull();
    expect(
      captureCenterPanelDropGeometry(
        { left: 100, right: 499, top: 100, bottom: 500, width: 400, height: 400 },
        { left: 100, right: 500, top: 100, bottom: 132, width: 400, height: 32 },
      ),
    ).toBeNull();
    expect(
      captureCenterPanelDropGeometry(
        { left: 100, right: 500, top: 100, bottom: 500, width: 400, height: 400 },
        {
          left: 100,
          right: Number.POSITIVE_INFINITY,
          top: 100,
          bottom: 132,
          width: 400,
          height: 32,
        },
      ),
    ).toBeNull();
  });
});

describe("resolveCenterPanelSplitDirection", () => {
  it.each([
    [{ x: 101, y: 300 }, "left"],
    [{ x: 499, y: 300 }, "right"],
    [{ x: 300, y: 141 }, "up"],
    [{ x: 300, y: 499 }, "down"],
  ] as const)("resolves %o to %s", (point, expected) => {
    expect(resolveCenterPanelSplitDirection(point, geometry)).toBe(expected);
  });

  it("reserves the tab strip and rejects stale outside or non-finite pointers", () => {
    expect(resolveCenterPanelSplitDirection({ x: 300, y: 120 }, geometry)).toBeNull();
    expect(resolveCenterPanelSplitDirection({ x: 700, y: 300 }, geometry)).toBeNull();
    expect(resolveCenterPanelSplitDirection({ x: Number.NaN, y: 300 }, geometry)).toBeNull();
  });

  it("breaks corner ties in left, right, up, down order", () => {
    expect(resolveCenterPanelSplitDirection({ x: 101, y: 141 }, geometry)).toBe("left");
    expect(resolveCenterPanelSplitDirection({ x: 499, y: 141 }, geometry)).toBe("right");
    expect(resolveCenterPanelSplitDirection({ x: 300, y: 141 }, geometry)).toBe("up");
  });

  it("allows pane borders and rejects points beyond the 20 percent edge zones", () => {
    expect(resolveCenterPanelSplitDirection({ x: 100, y: 300 }, geometry)).toBe("left");
    expect(resolveCenterPanelSplitDirection({ x: 180, y: 300 }, geometry)).toBe("left");
    expect(resolveCenterPanelSplitDirection({ x: 181, y: 300 }, geometry)).toBeNull();
  });
});

describe("resolveCenterPanelInsertionIndex", () => {
  it("uses tab midpoints and appends when the pointer is after every tab", () => {
    expect(resolveCenterPanelInsertionIndex({ left: 200, width: 100 }, 2, 249)).toBe(2);
    expect(resolveCenterPanelInsertionIndex({ left: 200, width: 100 }, 2, 251)).toBe(3);
    expect(resolveCenterPanelInsertionIndex({ left: 200, width: 100 }, 2, 250)).toBe(3);
  });

  it("rejects invalid rectangles and non-finite pointer positions", () => {
    expect(resolveCenterPanelInsertionIndex({ left: 200, width: 0 }, 2, 249)).toBeNull();
    expect(resolveCenterPanelInsertionIndex({ left: 200, width: 100 }, 2, Number.NaN)).toBeNull();
  });
});

describe("canCenterPanelPaneSplit", () => {
  it("rejects directions whose axis cannot fit both minimum pane sizes", () => {
    expect(canCenterPanelPaneSplit({ width: 479, height: 500 }, "left")).toBe(false);
    expect(canCenterPanelPaneSplit({ width: 480, height: 319 }, "right")).toBe(true);
    expect(canCenterPanelPaneSplit({ width: 480, height: 319 }, "down")).toBe(false);
    expect(canCenterPanelPaneSplit({ width: 480, height: 320 }, "up")).toBe(true);
  });

  it("rejects zero, negative, and non-finite dimensions on the split axis", () => {
    expect(canCenterPanelPaneSplit({ width: Number.NaN, height: 320 }, "left")).toBe(false);
    expect(canCenterPanelPaneSplit({ width: -480, height: 319 }, "up")).toBe(false);
  });
});

describe("resolveCenterPanelDropIntent", () => {
  it("prioritizes a feasible split over a hovered tab insertion", () => {
    expect(
      resolveCenterPanelDropIntent({
        point: { x: 101, y: 300 },
        geometry: {
          pane: { left: 100, right: 600, top: 100, bottom: 500, width: 500, height: 400 },
          tabStripBottom: 132,
        },
        groupId: "group-1",
        hoveredTab: { rect: { left: 200, width: 100 }, index: 2 },
      }),
    ).toEqual({ type: "split", groupId: "group-1", direction: "left" });
  });

  it("falls through an undersized horizontal split to a hovered tab insertion", () => {
    expect(
      resolveCenterPanelDropIntent({
        point: { x: 101, y: 300 },
        geometry: {
          pane: { left: 100, right: 579, top: 100, bottom: 500, width: 479, height: 400 },
          tabStripBottom: 132,
        },
        groupId: "group-1",
        hoveredTab: { rect: { left: 200, width: 100 }, index: 2 },
      }),
    ).toEqual({ type: "insert", groupId: "group-1", index: 2 });
  });

  it("uses usable body height rather than total pane height for vertical split feasibility", () => {
    expect(
      resolveCenterPanelDropIntent({
        point: { x: 300, y: 201 },
        geometry: {
          pane: { left: 100, right: 600, top: 100, bottom: 500, width: 500, height: 400 },
          tabStripBottom: 200,
        },
        groupId: "group-1",
      }),
    ).toEqual({ type: "append", groupId: "group-1" });
  });

  it("uses hovered tab insertion before a pane append", () => {
    expect(
      resolveCenterPanelDropIntent({
        point: { x: 250, y: 120 },
        geometry,
        groupId: "group-1",
        hoveredTab: { rect: { left: 200, width: 100 }, index: 2 },
      }),
    ).toEqual({ type: "insert", groupId: "group-1", index: 3 });
  });

  it("appends in the pane body and rejects invalid geometry or metadata", () => {
    expect(
      resolveCenterPanelDropIntent({ point: { x: 300, y: 300 }, geometry, groupId: "group-1" }),
    ).toEqual({ type: "append", groupId: "group-1" });
    expect(
      resolveCenterPanelDropIntent({ point: { x: 700, y: 300 }, geometry, groupId: "group-1" }),
    ).toEqual({ type: "none" });
    expect(
      resolveCenterPanelDropIntent({ point: { x: 300, y: 300 }, geometry, groupId: "" }),
    ).toEqual({ type: "none" });
  });
});
