import { describe, expect, it } from "vite-plus/test";

import { collectAddedWslDistroNames } from "./_chat.environments.add";

describe("add environment route", () => {
  it("derives already-added WSL distributions from authoritative environment bindings", () => {
    expect(
      collectAddedWslDistroNames([
        {
          bindings: [
            { _tag: "DesktopWslBinding", distroName: "Ubuntu-24.04" },
            { _tag: "DesktopLocalBinding" },
          ],
        },
        {
          bindings: [
            { _tag: "DesktopWslBinding", distroName: "ubuntu-24.04" },
            { _tag: "DesktopWslBinding", distroName: "Debian" },
          ],
        },
      ]),
    ).toEqual(["Debian", "ubuntu-24.04"]);
  });
});
