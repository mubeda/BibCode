/** Use one unit for acknowledged bytes and their total so progress remains comparable. */
export function formatTransferBytes(sentBytes: number, totalBytes: number | null): string {
  const reference = totalBytes ?? sentBytes;
  const [divisor, unit] =
    reference >= 1024 ** 3
      ? ([1024 ** 3, "GiB"] as const)
      : reference >= 1024 ** 2
        ? ([1024 ** 2, "MiB"] as const)
        : ([1024, "KiB"] as const);
  const format = (bytes: number) => {
    const amount = bytes / divisor;
    return (amount < 10 ? Math.round(amount * 10) / 10 : Math.round(amount)).toString();
  };
  return totalBytes === null
    ? `${format(sentBytes)} ${unit}`
    : `${format(sentBytes)} of ${format(totalBytes)} ${unit}`;
}
