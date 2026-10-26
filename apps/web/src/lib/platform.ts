/** Platform checks with no other dependencies, so a worker can import them. */
export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}
