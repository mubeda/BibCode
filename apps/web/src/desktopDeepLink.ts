import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export function resolvePairingDeepLink(rawUrl: string): { readonly code: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "bibcode:") return null;
  const isPairTarget =
    url.hostname === "pair" || url.pathname === "/pair" || url.pathname === "//pair";
  if (!isPairTarget) return null;
  const code = url.searchParams.get("code")?.trim() ?? "";
  return code.length > 0 ? { code } : null;
}

/** Mounted once by the root route in desktop mode; renders nothing. */
export function DesktopDeepLinkRouter() {
  const navigate = useNavigate();

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onDeepLink) return;
    const handleUrls = (urls: ReadonlyArray<string>) => {
      for (const rawUrl of urls) {
        const pairing = resolvePairingDeepLink(rawUrl);
        if (pairing !== null) {
          void navigate({ to: "/pair", search: { code: pairing.code } });
          return;
        }
      }
    };
    void bridge
      .getPendingDeepLinks?.()
      .then(handleUrls)
      .catch(() => undefined);
    return bridge.onDeepLink(handleUrls);
  }, [navigate]);

  return null;
}
