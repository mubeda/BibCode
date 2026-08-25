import { describe, expect, it } from "vite-plus/test";

import {
  applyWslEnvironmentConfiguration,
  parseWslUncPath,
  resolveProjectPickerDistro,
  resolveWslProjectSelection,
} from "./wslPaths";

describe("parseWslUncPath", () => {
  it("parses wsl.localhost UNC paths into distro and POSIX path", () => {
    expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\josh\\repo")).toEqual({
      distro: "Ubuntu-22.04",
      linuxPath: "/home/josh/repo",
    });
  });

  it("parses wsl$ UNC roots as distro root", () => {
    expect(parseWslUncPath("\\\\wsl$\\Debian")).toEqual({
      distro: "Debian",
      linuxPath: "/",
    });
  });

  it("rejects non-WSL paths and invalid distro names", () => {
    expect(parseWslUncPath("C:\\Users\\Josh\\repo")).toBeNull();
    expect(parseWslUncPath("\\\\wsl.localhost\\bad!name\\home")).toBeNull();
  });
});

describe("resolveWslProjectSelection", () => {
  it("routes a UNC path to the matching WSL backend", () => {
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Ubuntu\\home\\developer\\repo", [
        { environmentId: "env-debian", runningDistro: "Debian" },
        { environmentId: "env-ubuntu", runningDistro: "Ubuntu" },
      ]),
    ).toEqual({
      distro: "Ubuntu",
      environmentId: "env-ubuntu",
      linuxPath: "/home/developer/repo",
    });
  });

  it("does not route to the only WSL backend when its distro is unknown", () => {
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Ubuntu\\home\\developer\\repo", [
        { environmentId: "env-wsl", runningDistro: null },
      ]),
    ).toBeNull();
  });

  it("does not route to a sole WSL backend for a different distro", () => {
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Debian\\home\\developer\\repo", [
        { environmentId: "env-ubuntu", runningDistro: "Ubuntu" },
      ]),
    ).toBeNull();
  });

  it("does not guess when multiple WSL backends fail to match", () => {
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Fedora\\home\\developer\\repo", [
        { environmentId: "env-debian", runningDistro: "Debian" },
        { environmentId: "env-ubuntu", runningDistro: "Ubuntu" },
      ]),
    ).toBeNull();
  });

  it("routes a default backend only to the distro used by its running process", () => {
    const candidates = [{ environmentId: "env-wsl", runningDistro: "Debian" }];

    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Debian\\home\\developer\\repo", candidates),
    ).toEqual({
      distro: "Debian",
      environmentId: "env-wsl",
      linuxPath: "/home/developer/repo",
    });
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Ubuntu\\home\\developer\\repo", candidates),
    ).toBeNull();
  });
});

describe("applyWslEnvironmentConfiguration", () => {
  const ubuntuConfiguration = {
    enabled: true,
    wslOnly: false,
    distro: null,
    distros: [
      { name: "Debian", isDefault: false },
      { name: "Ubuntu", isDefault: true },
    ],
  };

  it("preserves a live distro locator", () => {
    expect(
      applyWslEnvironmentConfiguration(
        [
          {
            environmentId: "env-wsl",
            runningDistro: "Debian",
          },
        ],
        "env-primary",
        ubuntuConfiguration,
      ),
    ).toEqual([{ environmentId: "env-wsl", runningDistro: "Debian" }]);
  });

  it("does not replace a live default backend's running distro from current configuration", () => {
    const candidates = applyWslEnvironmentConfiguration(
      [{ environmentId: "env-wsl", runningDistro: "Debian" }],
      "env-primary",
      ubuntuConfiguration,
    );

    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Ubuntu\\home\\developer\\repo", candidates),
    ).toBeNull();
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Debian\\home\\developer\\repo", candidates),
    ).toEqual({
      distro: "Debian",
      environmentId: "env-wsl",
      linuxPath: "/home/developer/repo",
    });
  });

  it("represents an explicitly configured WSL-only primary by its distro", () => {
    expect(
      applyWslEnvironmentConfiguration([], "env-primary", {
        ...ubuntuConfiguration,
        wslOnly: true,
        distro: "ubuntu",
      }),
    ).toEqual([{ environmentId: "env-primary", runningDistro: "Ubuntu" }]);
  });

  it("preserves default tracking for a WSL-only primary", () => {
    expect(
      applyWslEnvironmentConfiguration([], "env-primary", {
        ...ubuntuConfiguration,
        wslOnly: true,
      }),
    ).toEqual([{ environmentId: "env-primary", runningDistro: null }]);
  });

  it("uses the live primary distro for a default-tracking WSL-only primary", () => {
    const candidates = applyWslEnvironmentConfiguration(
      [],
      "env-primary",
      {
        ...ubuntuConfiguration,
        wslOnly: true,
        distros: [],
      },
      "Ubuntu",
    );

    expect(candidates).toEqual([{ environmentId: "env-primary", runningDistro: "Ubuntu" }]);
    expect(
      resolveWslProjectSelection("\\\\wsl.localhost\\Ubuntu\\home\\developer\\repo", candidates),
    ).toEqual({
      distro: "Ubuntu",
      environmentId: "env-primary",
      linuxPath: "/home/developer/repo",
    });
  });

  it("keeps a configured distro authoritative when discovery does not contain it", () => {
    expect(
      applyWslEnvironmentConfiguration([], "env-primary", {
        ...ubuntuConfiguration,
        wslOnly: true,
        distro: "Fedora",
      }),
    ).toEqual([{ environmentId: "env-primary", runningDistro: "Fedora" }]);
  });

  it("does not synthesize a backend for an empty configured distro name", () => {
    expect(
      applyWslEnvironmentConfiguration([], "env-primary", {
        ...ubuntuConfiguration,
        wslOnly: true,
        distro: "  ",
      }),
    ).toEqual([]);
  });
});

describe("resolveProjectPickerDistro", () => {
  const ubuntuConfiguration = {
    enabled: true,
    wslOnly: true,
    distro: "Ubuntu-22.04",
    distros: [
      { name: "Debian", isDefault: true },
      { name: "Ubuntu-22.04", isDefault: false },
    ],
  };

  it("routes a WSL-only primary picker to its configured distro", () => {
    expect(
      resolveProjectPickerDistro({
        browseEnvironmentId: "env-primary",
        primaryEnvironmentId: "env-primary",
        candidates: [],
        wslConfiguration: ubuntuConfiguration,
        primaryRunningDistro: null,
      }),
    ).toBe("Ubuntu-22.04");
  });

  it("routes a configured distro while discovery is temporarily empty", () => {
    expect(
      resolveProjectPickerDistro({
        browseEnvironmentId: "env-primary",
        primaryEnvironmentId: "env-primary",
        candidates: [],
        wslConfiguration: { ...ubuntuConfiguration, distro: "ubuntu-22.04", distros: [] },
        primaryRunningDistro: null,
      }),
    ).toBe("ubuntu-22.04");
  });

  it("uses installed casing when discovery finds the configured distro", () => {
    expect(
      resolveProjectPickerDistro({
        browseEnvironmentId: "env-primary",
        primaryEnvironmentId: "env-primary",
        candidates: [],
        wslConfiguration: { ...ubuntuConfiguration, distro: "ubuntu-22.04" },
        primaryRunningDistro: null,
      }),
    ).toBe("Ubuntu-22.04");
  });

  it("routes a default-tracking WSL-only primary through its live distro locator", () => {
    expect(
      resolveProjectPickerDistro({
        browseEnvironmentId: "env-primary",
        primaryEnvironmentId: "env-primary",
        candidates: [],
        wslConfiguration: { ...ubuntuConfiguration, distro: null },
        primaryRunningDistro: "Debian",
      }),
    ).toBe("Debian");
  });

  it("does not invent a locator for a default-tracking picker with no live distro", () => {
    expect(
      resolveProjectPickerDistro({
        browseEnvironmentId: "env-primary",
        primaryEnvironmentId: "env-primary",
        candidates: [],
        wslConfiguration: {
          ...ubuntuConfiguration,
          distro: null,
          distros: [{ name: "Ubuntu-22.04", isDefault: false }],
        },
        primaryRunningDistro: null,
      }),
    ).toBeNull();

    expect(
      resolveProjectPickerDistro({
        browseEnvironmentId: "env-primary",
        primaryEnvironmentId: "env-primary",
        candidates: [],
        wslConfiguration: { ...ubuntuConfiguration, distro: null, distros: [] },
        primaryRunningDistro: null,
      }),
    ).toBeNull();
  });

  it("preserves combo-mode routing for primary and WSL backends", () => {
    const comboConfiguration = { ...ubuntuConfiguration, wslOnly: false };

    expect(
      resolveProjectPickerDistro({
        browseEnvironmentId: "env-primary",
        primaryEnvironmentId: "env-primary",
        candidates: [],
        wslConfiguration: comboConfiguration,
        primaryRunningDistro: null,
      }),
    ).toBeNull();
    expect(
      resolveProjectPickerDistro({
        browseEnvironmentId: "env-wsl",
        primaryEnvironmentId: "env-primary",
        candidates: [{ environmentId: "env-wsl", runningDistro: "Ubuntu-22.04" }],
        wslConfiguration: comboConfiguration,
        primaryRunningDistro: null,
      }),
    ).toBe("Ubuntu-22.04");
  });
});
