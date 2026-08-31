import { describe, expect, it } from "vite-plus/test";

import { shareClassForPairingEndpoint } from "./endpointClass.ts";

describe("shareClassForPairingEndpoint", () => {
  it("maps loopback endpoints to loopback", () => {
    expect(shareClassForPairingEndpoint("http://127.0.0.1:3773")).toBe("loopback");
    expect(shareClassForPairingEndpoint("http://localhost:3773")).toBe("loopback");
  });

  it("maps private-network and public endpoints to off-host", () => {
    expect(shareClassForPairingEndpoint("http://192.168.1.20:3773")).toBe("off-host");
    expect(shareClassForPairingEndpoint("https://machine.tailnet.ts.net")).toBe("off-host");
    expect(shareClassForPairingEndpoint("https://example.com")).toBe("off-host");
  });

  it("passes unconnectable through for the invalid-address path", () => {
    expect(shareClassForPairingEndpoint("http://")).toBe("unconnectable");
  });
});
