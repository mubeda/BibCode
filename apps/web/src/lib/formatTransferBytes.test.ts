import { describe, expect, it } from "vite-plus/test";

import { formatTransferBytes } from "./formatTransferBytes";

describe("formatTransferBytes", () => {
  it.each([
    [3.1 * 1024 ** 2, 20 * 1024 ** 2, "3.1 of 20 MiB"],
    [120 * 1024 ** 2, 900 * 1024 ** 2, "120 of 900 MiB"],
    [0.5 * 1024 ** 3, 1.2 * 1024 ** 3, "0.5 of 1.2 GiB"],
    [120 * 1024, 300 * 1024, "120 of 300 KiB"],
    [3 * 1024 ** 2, 10 * 1024 ** 2, "3 of 10 MiB"],
    [0, 1024 ** 2, "0 of 1 MiB"],
    [9.95 * 1024 ** 2, 20 * 1024 ** 2, "10 of 20 MiB"],
    [120 * 1024 ** 2, null, "120 MiB"],
    [512, null, "0.5 KiB"],
  ])("formats %s acknowledged bytes against %s total as %s", (sent, total, expected) => {
    expect(formatTransferBytes(sent, total)).toBe(expected);
  });
});
