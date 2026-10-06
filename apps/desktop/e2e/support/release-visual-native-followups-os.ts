import type { NativeFollowupCommandOwner } from "./release-visual-native-followups-process.ts";
export function nativeFollowupOsPlan(
  platform: string,
  actualPlatform: string,
  theme: "light" | "dark",
) {
  if (platform !== actualPlatform || platform !== "linux" || !["light", "dark"].includes(theme))
    throw new Error("Native follow-up OS platform refused.");
  return Object.freeze({
    themeArgs: [
      "set",
      "org.gnome.desktop.interface",
      "color-scheme",
      theme === "dark" ? "prefer-dark" : "default",
    ],
    captureArgs: ["-window", "root"],
  });
}
export function parseNativeFollowupPortalScheme(value: string): "light" | "dark" {
  const match = /^\(\s*<+uint32 ([012])>+,\s*\)\s*$/.exec(value);
  if (!match) throw new Error("Native follow-up system portal unavailable.");
  return match[1] === "1" ? "dark" : "light";
}
const windowsDisplayInterop = `using System; using System.Runtime.InteropServices;
public static class NativeFollowupDisplay {
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Mode {
[MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
public ushort dmSpecVersion,dmDriverVersion,dmSize,dmDriverExtra; public uint dmFields;
public int dmPositionX,dmPositionY; public uint dmDisplayOrientation,dmDisplayFixedOutput;
public short dmColor,dmDuplex,dmYResolution,dmTTOption,dmCollate;
[MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
public ushort dmLogPixels; public uint dmBitsPerPel,dmPelsWidth,dmPelsHeight,dmDisplayFlags,dmDisplayFrequency,dmICMMethod,dmICMIntent,dmMediaType,dmDitherType,dmReserved1,dmReserved2,dmPanningWidth,dmPanningHeight;
}
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string device,int number,ref Mode mode);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettings(ref Mode mode,uint flags);
}`;
/** Changes the real disposable Windows display mode, then restores its actual prior dimensions. */
export async function withNativeFollowupWindowsDisplay<A>(
  owner: NativeFollowupCommandOwner,
  executable: string,
  unsafe: () => void,
  run: () => Promise<A>,
): Promise<A> {
  const prefix =
    "Add-Type -TypeDefinition '" +
    windowsDisplayInterop.replaceAll("'", "''") +
    "'; $m=New-Object NativeFollowupDisplay+Mode; $m.dmSize=[System.Runtime.InteropServices.Marshal]::SizeOf($m); if(-not [NativeFollowupDisplay]::EnumDisplaySettings($null,-1,[ref]$m)){throw 'Native display unavailable'}; ";
  const raw: unknown = JSON.parse(
    (
      await owner.command(executable, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        prefix + "@{width=$m.dmPelsWidth;height=$m.dmPelsHeight}|ConvertTo-Json -Compress",
      ])
    ).toString("utf8"),
  );
  if (
    !raw ||
    typeof raw !== "object" ||
    !("width" in raw) ||
    !("height" in raw) ||
    typeof raw.width !== "number" ||
    typeof raw.height !== "number" ||
    !Number.isInteger(raw.width) ||
    !Number.isInteger(raw.height) ||
    raw.width < 320 ||
    raw.width > 8192 ||
    raw.height < 240 ||
    raw.height > 8192
  )
    throw new Error("Native follow-up original display mode refused.");
  const set = async (width: number, height: number) => {
    await owner.command(executable, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      prefix +
        "$m.dmFields=0x00180000; $m.dmPelsWidth=" +
        width +
        "; $m.dmPelsHeight=" +
        height +
        "; if([NativeFollowupDisplay]::ChangeDisplaySettings([ref]$m,0) -ne 0){throw 'Native display mode refused'}",
    ]);
  };
  let failed = false,
    original: unknown,
    value: A | undefined;
  try {
    await set(1280, 960);
    value = await run();
  } catch (error) {
    failed = true;
    original = error;
  }
  try {
    await set(raw.width, raw.height);
  } catch (error) {
    unsafe();
    if (!failed) {
      failed = true;
      original = error;
    }
  }
  if (failed) throw original;
  return value as A;
}
export async function withNativeFollowupOsTheme<A>(
  ports: {
    read: () => Promise<string>;
    write: (value: string) => Promise<void>;
    verify: (theme: "light" | "dark") => Promise<void>;
    unsafe: () => void;
  },
  theme: "light" | "dark",
  run: () => Promise<A>,
): Promise<A> {
  const prior = await ports.read();
  if (!["default", "prefer-light", "prefer-dark"].includes(prior))
    throw new Error("Native follow-up prior OS theme refused.");
  let failed = false,
    original: unknown,
    result: A | undefined;
  try {
    await ports.write(theme === "dark" ? "prefer-dark" : "default");
    await ports.verify(theme);
    result = await run();
  } catch (error) {
    failed = true;
    original = error;
  }
  try {
    await ports.write(prior);
  } catch (error) {
    ports.unsafe();
    if (!failed) {
      failed = true;
      original = error;
    }
  }
  if (failed) throw original;
  return result as A;
}
/** Real GTK/portal commands, scoped to the existing disposable native owner's D-Bus session. */
export function createNativeFollowupLinuxOs(
  owner: NativeFollowupCommandOwner,
  actualPlatform: string,
  unsafe: () => void,
) {
  nativeFollowupOsPlan("linux", actualPlatform, "light");
  const command = (file: string, args: readonly string[]) => owner.command(file, args);
  const scheme = async () =>
    parseNativeFollowupPortalScheme(
      (
        await command("/usr/bin/gdbus", [
          "call",
          "--session",
          "--dest",
          "org.freedesktop.portal.Desktop",
          "--object-path",
          "/org/freedesktop/portal/desktop",
          "--method",
          "org.freedesktop.portal.Settings.Read",
          "org.freedesktop.appearance",
          "color-scheme",
        ])
      ).toString("utf8"),
    );
  return {
    read: async () =>
      (await command("/usr/bin/gsettings", ["get", "org.gnome.desktop.interface", "color-scheme"]))
        .toString("utf8")
        .trim()
        .replace(/^'|'$/g, ""),
    write: async (value: string) => {
      if (!["default", "prefer-light", "prefer-dark"].includes(value))
        throw new Error("Native follow-up theme refused.");
      await command("/usr/bin/gsettings", [
        "set",
        "org.gnome.desktop.interface",
        "color-scheme",
        value,
      ]);
    },
    verify: async (theme: "light" | "dark") => {
      if ((await scheme()) !== theme)
        throw new Error("Native follow-up actual system theme mismatch.");
    },
    capture: () => owner.command("/usr/bin/import", ["-window", "root", "png24:-"], 12 * 1024 ** 2),
    menu: async () => {
      // AT-SPI reads the actual GTK popup; no renderer menu, screenshot crop, or synthetic menu.
      const script =
        "import json,gi\ngi.require_version('Atspi','2.0')\nfrom gi.repository import Atspi\nroot=Atspi.get_desktop(0)\nseen=0; labels=set(); separators=0\ndef visit(n,d=0):\n global seen,separators\n seen+=1\n if seen>10000 or d>32: raise RuntimeError('bounded')\n role=n.get_role()\n if role==Atspi.Role.SEPARATOR: separators+=1\n if role==Atspi.Role.MENU_ITEM:\n  name=n.get_name()\n  if name in ['Copy Path','Pin','Unpin','Mark as Unread','Mark as Read','Pull','Open in']: labels.add(name)\n for i in range(n.get_child_count()): visit(n.get_child_at_index(i),d+1)\nvisit(root)\nprint(json.dumps({'nativeMenuGrouped':separators>=1 and 'Copy Path' in labels and ('Pin' in labels or 'Unpin' in labels)}))";
      const raw: unknown = JSON.parse(
        (await owner.command("/usr/bin/python3", ["-c", script])).toString("utf8"),
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        Object.keys(raw).length !== 1 ||
        !("nativeMenuGrouped" in raw) ||
        raw.nativeMenuGrouped !== true
      )
        throw new Error("Native follow-up native grouped menu unavailable.");
      return { nativeMenuGrouped: true as const };
    },
    unsafe,
  };
}

/** Windows original desktop pixels are acquired by the OS, without cropping or resizing. */
export async function captureNativeFollowupWindowsOriginal(
  owner: NativeFollowupCommandOwner,
  executable: string,
): Promise<Buffer> {
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; if($b.X -ne 0 -or $b.Y -ne 0 -or $b.Width -ne 1280 -or $b.Height -ne 960){throw 'Native geometry unavailable'}; $image=New-Object System.Drawing.Bitmap -ArgumentList 1280,960,([System.Drawing.Imaging.PixelFormat]::Format24bppRgb); $g=[System.Drawing.Graphics]::FromImage($image); $s=New-Object System.IO.MemoryStream; try{$g.CopyFromScreen(0,0,0,0,$image.Size); $image.Save($s,[System.Drawing.Imaging.ImageFormat]::Png); [Console]::OpenStandardOutput().Write($s.ToArray(),0,[int]$s.Length)}finally{$s.Dispose();$g.Dispose();$image.Dispose()}";
  return owner.command(
    executable,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    12 * 1024 ** 2,
  );
}
