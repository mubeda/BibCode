export function shouldApplyLinuxWebkitTypography(input: {
  hasDesktopBridge: boolean;
  userAgent: string;
}): boolean {
  return input.hasDesktopBridge && /\bLinux\b/.test(input.userAgent);
}

export function applyLinuxWebkitTypography(doc: Document): void {
  if (
    shouldApplyLinuxWebkitTypography({
      hasDesktopBridge: "desktopBridge" in window,
      userAgent: navigator.userAgent,
    })
  ) {
    doc.documentElement.dataset.linuxWebkit = "";
  }
}
