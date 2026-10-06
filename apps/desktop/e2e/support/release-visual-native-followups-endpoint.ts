/** A WSL address is admitted only when observed from the exact real mapped distro. */
export function admitNativeFollowupEndpoint(
  endpoint: string,
  platform: string,
  distro: string | null,
  wslHosts: readonly string[],
) {
  const url = new URL(endpoint),
    parts = url.hostname.split(".").map(Number),
    privateIp =
      parts.length === 4 &&
      parts.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) &&
      (parts[0] === 10 ||
        (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
        (parts[0] === 192 && parts[1] === 168));
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname) ||
    !url.port ||
    (url.hostname !== "127.0.0.1" &&
      !(
        platform === "win32" &&
        distro !== null &&
        distro.length > 0 &&
        privateIp &&
        wslHosts.length <= 16 &&
        wslHosts.includes(url.hostname)
      ))
  )
    throw new Error("Native follow-up actual endpoint refused.");
  return url;
}
