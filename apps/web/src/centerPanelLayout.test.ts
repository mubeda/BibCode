import { describe, expect, it } from "vite-plus/test";
import {
  MAX_CENTER_PANEL_GROUPS,
  collectCenterPanelLeafIds,
  createCenterPanelLayoutState,
  findCenterPanelGroup,
  findCenterPanelGroupEdges,
  insertCenterPanelSurface,
  mergeCenterPanelGroup,
  removeCenterPanelSurfaceIds,
  repairCenterPanelLayoutState,
  setCenterPanelSplitRatio,
  dropCenterPanelSurface,
} from "./centerPanelLayout";

describe("centerPanelLayout", () => {
  it("moves a tab into a right split and then nests a down split", () => {
    const root = createCenterPanelLayoutState(["host", "chat-a", "term-a"], "host");
    const right = dropCenterPanelSurface(root, "chat-a", {
      groupId: "center:root",
      splitDirection: "right",
      newGroupId: "group-right",
    });
    expect(right.changed).toBe(true);
    expect(right.state.layout).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", groupId: "center:root" },
      second: { type: "leaf", groupId: "group-right" },
    });

    const down = dropCenterPanelSurface(right.state, "term-a", {
      groupId: "group-right",
      splitDirection: "down",
      newGroupId: "group-down",
    });
    expect(collectCenterPanelLeafIds(down.state.layout)).toEqual([
      "center:root",
      "group-right",
      "group-down",
    ]);
    expect(down.state.groups.find((group) => group.id === "group-down")?.surfaceIds).toEqual([
      "term-a",
    ]);
  });

  it("rejects a fifth final group but allows a four-to-four relocation", () => {
    let state = createCenterPanelLayoutState(["a", "b", "c", "d", "e"], "a");
    for (const [surfaceId, groupId] of [
      ["b", "g2"],
      ["c", "g3"],
      ["d", "g4"],
    ] as const) {
      state = dropCenterPanelSurface(state, surfaceId, {
        groupId: "center:root",
        splitDirection: "right",
        newGroupId: groupId,
      }).state;
    }
    expect(state.groups).toHaveLength(MAX_CENTER_PANEL_GROUPS);
    expect(
      dropCenterPanelSurface(state, "e", {
        groupId: "center:root",
        splitDirection: "left",
        newGroupId: "g5",
      }).changed,
    ).toBe(false);

    const relocated = dropCenterPanelSurface(state, "b", {
      groupId: "g3",
      splitDirection: "down",
      newGroupId: "g2-relocated",
    });
    expect(relocated.changed).toBe(true);
    expect(relocated.state.groups).toHaveLength(MAX_CENTER_PANEL_GROUPS);
  });

  it("creates the root with first-seen tabs and a valid fallback active tab", () => {
    expect(createCenterPanelLayoutState(["host", "host", "chat-a"], "missing")).toEqual({
      groups: [{ id: "center:root", surfaceIds: ["host", "chat-a"], activeSurfaceId: "host" }],
      layout: { type: "leaf", groupId: "center:root" },
      focusedGroupId: "center:root",
    });
  });

  it("reactivates an existing surface in its owning group", () => {
    const state = dropCenterPanelSurface(
      createCenterPanelLayoutState(["host", "chat-a"], "host"),
      "chat-a",
      { groupId: "center:root", splitDirection: "right", newGroupId: "chat" },
    ).state;
    const inserted = insertCenterPanelSurface(state, "host", "chat");
    expect(inserted.state.focusedGroupId).toBe("center:root");
    expect(findCenterPanelGroup(inserted.state, "center:root")?.activeSurfaceId).toBe("host");
    expect(findCenterPanelGroup(inserted.state, "chat")?.surfaceIds).toEqual(["chat-a"]);
  });

  it("adds a new surface to the focused group when the requested group is invalid", () => {
    const state = {
      ...createCenterPanelLayoutState(["host"], "host"),
      focusedGroupId: "center:root",
    };
    const inserted = insertCenterPanelSurface(state, "chat-a", "missing");
    expect(inserted.changed).toBe(true);
    expect(findCenterPanelGroup(inserted.state, "center:root")?.surfaceIds).toEqual([
      "host",
      "chat-a",
    ]);
    expect(inserted.state.focusedGroupId).toBe("center:root");
  });

  it("removes tabs in layout order and normalizes an empty workspace to the root", () => {
    const split = dropCenterPanelSurface(
      createCenterPanelLayoutState(["host", "chat-a"], "chat-a"),
      "chat-a",
      { groupId: "center:root", splitDirection: "right", newGroupId: "chat" },
    ).state;
    const removed = removeCenterPanelSurfaceIds(split, new Set(["chat-a", "host", "missing"]));
    expect(removed.removedSurfaceIds).toEqual(["host", "chat-a"]);
    expect(removed.state).toEqual(createCenterPanelLayoutState([], null));
  });

  it("merges into the direct sibling or first depth-first leaf without losing tabs", () => {
    const result = mergeCenterPanelGroup(nestedState, "focused-source");
    expect(result.changed).toBe(true);
    expect(result.destinationGroupId).toBe("first-leaf-in-sibling-subtree");
    expect(findCenterPanelGroup(result.state, result.destinationGroupId!)?.surfaceIds).toEqual([
      "destination-existing",
      "source-first",
      "source-active",
    ]);
    expect(findCenterPanelGroup(result.state, result.destinationGroupId!)?.activeSurfaceId).toBe(
      "source-active",
    );
  });

  it("repairs duplicate leaves, orphaned surfaces, excess groups, and invalid ratios", () => {
    const repaired = repairCenterPanelLayoutState(
      malformedPersistedLayout,
      ["host", "chat-a", "term-a", "term-b", "term-c"],
      "chat-a",
    );
    expect(new Set(repaired.groups.flatMap((group) => group.surfaceIds))).toEqual(
      new Set(["host", "chat-a", "term-a", "term-b", "term-c"]),
    );
    expect(repaired.groups).toHaveLength(3);
    expect(collectCenterPanelLeafIds(repaired.layout)).toEqual(
      repaired.groups.map((group) => group.id),
    );
    expect(findCenterPanelGroup(repaired, "one")?.surfaceIds).toEqual(["host", "chat-a", "term-c"]);
  });

  it("recovers orphaned surfaces before pruning empty leaves and collapsing their parents", () => {
    const repaired = repairCenterPanelLayoutState(
      {
        groups: [
          { id: "left", surfaceIds: ["host"], activeSurfaceId: "host" },
          { id: "empty", surfaceIds: [], activeSurfaceId: null },
          { id: "right", surfaceIds: ["term-a"], activeSurfaceId: "term-a" },
        ],
        layout: {
          type: "split",
          direction: "horizontal",
          ratio: 0.6,
          first: {
            type: "split",
            direction: "vertical",
            ratio: 0.35,
            first: { type: "leaf", groupId: "left" },
            second: { type: "leaf", groupId: "empty" },
          },
          second: { type: "leaf", groupId: "right" },
        },
        focusedGroupId: "empty",
      },
      ["host", "term-a", "orphan"],
      "orphan",
    );

    expect(repaired).toEqual({
      groups: [
        { id: "left", surfaceIds: ["host", "orphan"], activeSurfaceId: "host" },
        { id: "right", surfaceIds: ["term-a"], activeSurfaceId: "term-a" },
      ],
      layout: {
        type: "split",
        direction: "horizontal",
        ratio: 0.6,
        first: { type: "leaf", groupId: "left" },
        second: { type: "leaf", groupId: "right" },
      },
      focusedGroupId: "left",
    });
  });

  it("normalizes multiple persisted empty panes to one empty root group", () => {
    const repaired = repairCenterPanelLayoutState(
      {
        groups: [
          { id: "empty-left", surfaceIds: [], activeSurfaceId: null },
          { id: "empty-right", surfaceIds: [], activeSurfaceId: null },
        ],
        layout: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "leaf", groupId: "empty-left" },
          second: { type: "leaf", groupId: "empty-right" },
        },
        focusedGroupId: "empty-right",
      },
      [],
      null,
    );

    expect(repaired).toEqual(createCenterPanelLayoutState([], null));
  });

  it("clamps a ratio update and preserves identity for an invalid path", () => {
    expect(setCenterPanelSplitRatio(splitState, [], 0.01).state.layout).toMatchObject({
      ratio: 0.15,
    });
    expect(setCenterPanelSplitRatio(splitState, ["first"], 0.7)).toEqual({
      state: splitState,
      changed: false,
    });
  });

  it("derives outer edges for nested groups", () => {
    expect(findCenterPanelGroupEdges(nestedState.layout, "left-full-height")).toEqual({
      top: true,
      right: false,
      bottom: true,
      left: true,
    });
    expect(findCenterPanelGroupEdges(nestedState.layout, "right-bottom")).toEqual({
      top: false,
      right: true,
      bottom: true,
      left: false,
    });
  });
});

const nestedState = {
  groups: [
    { id: "left-full-height", surfaceIds: ["left"], activeSurfaceId: "left" },
    {
      id: "focused-source",
      surfaceIds: ["source-first", "source-active"],
      activeSurfaceId: "source-active",
    },
    {
      id: "first-leaf-in-sibling-subtree",
      surfaceIds: ["destination-existing"],
      activeSurfaceId: "destination-existing",
    },
    { id: "right-bottom", surfaceIds: ["bottom"], activeSurfaceId: "bottom" },
  ],
  layout: {
    type: "split" as const,
    direction: "horizontal" as const,
    ratio: 0.5,
    first: { type: "leaf" as const, groupId: "left-full-height" },
    second: {
      type: "split" as const,
      direction: "vertical" as const,
      ratio: 0.5,
      first: { type: "leaf" as const, groupId: "focused-source" },
      second: {
        type: "split" as const,
        direction: "horizontal" as const,
        ratio: 0.5,
        first: { type: "leaf" as const, groupId: "first-leaf-in-sibling-subtree" },
        second: { type: "leaf" as const, groupId: "right-bottom" },
      },
    },
  },
  focusedGroupId: "focused-source",
};

const splitState = {
  ...createCenterPanelLayoutState(["host", "chat-a"], "host"),
  layout: {
    type: "split" as const,
    direction: "horizontal" as const,
    ratio: 0.5,
    first: { type: "leaf" as const, groupId: "center:root" },
    second: { type: "leaf" as const, groupId: "chat" },
  },
  groups: [
    { id: "center:root", surfaceIds: ["host"], activeSurfaceId: "host" },
    { id: "chat", surfaceIds: ["chat-a"], activeSurfaceId: "chat-a" },
  ],
};

const malformedPersistedLayout: unknown = {
  groups: [
    { id: "one", surfaceIds: ["host", "chat-a", "host"], activeSurfaceId: "missing" },
    { id: "two", surfaceIds: ["term-a"], activeSurfaceId: "term-a" },
    { id: "three", surfaceIds: ["term-b"], activeSurfaceId: "term-b" },
    { id: "orphan", surfaceIds: ["term-c"], activeSurfaceId: "term-c" },
    { id: "four", surfaceIds: ["term-c"], activeSurfaceId: "term-c" },
    { id: "five", surfaceIds: [], activeSurfaceId: null },
  ],
  layout: {
    type: "split",
    direction: "horizontal",
    ratio: 99,
    first: {
      type: "split",
      direction: "vertical",
      ratio: 0.5,
      first: { type: "leaf", groupId: "one" },
      second: { type: "leaf", groupId: "one" },
    },
    second: {
      type: "split",
      direction: "vertical",
      ratio: Number.NaN,
      first: { type: "leaf", groupId: "two" },
      second: {
        type: "split",
        direction: "horizontal",
        ratio: 0.1,
        first: { type: "leaf", groupId: "three" },
        second: {
          type: "split",
          direction: "horizontal",
          ratio: 0.9,
          first: { type: "leaf", groupId: "four" },
          second: { type: "leaf", groupId: "five" },
        },
      },
    },
  },
  focusedGroupId: "not-a-group",
};
