import { describe, expect, it } from "vite-plus/test";

import { PANEL_UNAVAILABLE_REASON } from "./components/chat/ChatHeaderPanelMenu.logic";
import {
  resolveSideChatAvailability,
  SIDE_CHAT_IN_PANEL_REASON,
  SIDE_CHAT_UNSUPPORTED_REASON,
} from "./sideChatAvailability";

const available = {
  capabilities: { sideChats: true },
  isPanel: false,
  canCreatePanel: true,
  workspaceUnavailableReason: null,
  hostProviderReason: null,
} as const;

describe("resolveSideChatAvailability", () => {
  it("allows a side chat of a started main thread on a server that supports them", () => {
    expect(resolveSideChatAvailability(available)).toBeNull();
  });

  it("refuses inside a chat panel or side chat", () => {
    expect(resolveSideChatAvailability({ ...available, isPanel: true })).toBe(
      SIDE_CHAT_IN_PANEL_REASON,
    );
  });

  it("refuses on a server without sideChats, also before it reported capabilities", () => {
    expect(resolveSideChatAvailability({ ...available, capabilities: { sideChats: false } })).toBe(
      SIDE_CHAT_UNSUPPORTED_REASON,
    );
    expect(resolveSideChatAvailability({ ...available, capabilities: null })).toBe(
      SIDE_CHAT_UNSUPPORTED_REASON,
    );
  });

  it("waits for the thread to start, the workspace, and the host's provider", () => {
    expect(resolveSideChatAvailability({ ...available, canCreatePanel: false })).toBe(
      PANEL_UNAVAILABLE_REASON,
    );
    expect(
      resolveSideChatAvailability({ ...available, workspaceUnavailableReason: "Workspace gone." }),
    ).toBe("Workspace gone.");
    expect(
      resolveSideChatAvailability({ ...available, hostProviderReason: "Codex isn't ready." }),
    ).toBe("Codex isn't ready.");
  });
});
