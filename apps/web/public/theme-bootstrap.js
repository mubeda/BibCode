(() => {
  const LIGHT_BACKGROUND = "#ffffff";
  const DARK_BACKGROUND = "#161616";
  // The supported theme tokens (packages/contracts/src/theme.ts); a test keeps them equal.
  const COLOR_TOKENS = [
    "background",
    "app-chrome-background",
    "foreground",
    "foreground-strong",
    "card",
    "card-foreground",
    "popover",
    "popover-foreground",
    "primary",
    "primary-foreground",
    "primary-hover",
    "primary-active",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "selected",
    "selected-foreground",
    "placeholder",
    "destructive",
    "destructive-foreground",
    "border",
    "input",
    "ring",
    "panel-separator",
    "sidebar-well",
    "sidebar-card",
    "sidebar-card-border",
    "sidebar-env-band",
    "sidebar-env-accent",
    "sidebar-primary-badge",
    "sidebar-primary-badge-foreground",
    "sidebar-worktree",
    "sidebar-worktree-border",
    "sidebar-worktree-icon",
    "sidebar-chat-foreground",
    "sidebar-indent-guide",
    "link",
    "info",
    "info-foreground",
    "success",
    "success-foreground",
    "warning",
    "warning-foreground",
    "find-match",
    "find-match-foreground",
    "find-match-active",
    "find-match-active-foreground",
  ];
  // Allowed lengths in px; a rem is 16px.
  const LENGTH_RANGES = {
    radius: [0, 16],
    "focus-ring-width": [1, 3],
    "focus-ring-offset": [0, 3],
  };
  const KEYWORDS = {
    "sidebar-card-shadow": ["none"],
    "control-shadow": ["none", "default"],
  };
  const MAX_RECORD_LENGTH = 32 * 1024;
  const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
  const OPAQUE_HEX = /^#[0-9a-f]{6}$/i;
  const LENGTH = /^(\d+(?:\.\d+)?)(px|rem)$/;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function allowed(name, value) {
    if (typeof name !== "string" || typeof value !== "string" || name.slice(0, 2) !== "--") {
      return false;
    }
    const token = name.slice(2);
    if (COLOR_TOKENS.indexOf(token) >= 0) return HEX.test(value);
    if (own(LENGTH_RANGES, token)) {
      const match = LENGTH.exec(value);
      if (!match) return false;
      const px = Number(match[1]) * (match[2] === "rem" ? 16 : 1);
      return px >= LENGTH_RANGES[token][0] && px <= LENGTH_RANGES[token][1];
    }
    return own(KEYWORDS, token) && KEYWORDS[token].indexOf(value) >= 0;
  }

  /** The paint record for `mode`, or null unless every field passes (plan decisions P18, P22). */
  function readPaintRecord(storage, mode) {
    const raw = storage.getItem("bibcode:theme-paint:v1");
    const slotsRaw = storage.getItem("bibcode:theme-slots:v1");
    if (typeof raw !== "string" || typeof slotsRaw !== "string" || raw.length > MAX_RECORD_LENGTH) {
      return null;
    }
    const slots = JSON.parse(slotsRaw);
    const records = JSON.parse(raw);
    const record = records && typeof records === "object" ? records[mode] : null;
    if (
      !slots ||
      typeof slots !== "object" ||
      !record ||
      typeof record !== "object" ||
      typeof record.stamp !== "string" ||
      record.stamp === "" ||
      record.stamp !== slots.paintStamp ||
      record.base !== mode ||
      typeof record.background !== "string" ||
      !OPAQUE_HEX.test(record.background) ||
      !record.vars ||
      typeof record.vars !== "object"
    ) {
      return null;
    }
    const names = Object.keys(record.vars);
    for (const name of names) {
      if (!allowed(name, record.vars[name])) return null;
    }
    return record;
  }

  const root = document.documentElement;
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  try {
    const storage = window.localStorage;
    const storedTheme = storage.getItem("bibcode:theme");
    const theme =
      storedTheme === "light" || storedTheme === "dark" || storedTheme === "system"
        ? storedTheme
        : "system";
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = theme === "dark" || (theme === "system" && prefersDark);
    root.classList.toggle("dark", isDark);
    let chromeColor = isDark ? DARK_BACKGROUND : LIGHT_BACKGROUND;
    let record = null;
    try {
      record = readPaintRecord(storage, isDark ? "dark" : "light");
    } catch {
      record = null;
    }
    if (record) {
      for (const name of Object.keys(record.vars)) root.style.setProperty(name, record.vars[name]);
      if (own(record.vars, "--focus-ring-width") || own(record.vars, "--focus-ring-offset")) {
        root.setAttribute("data-theme-focus-ring", "");
      }
      if (record.vars["--control-shadow"] === "none") {
        root.setAttribute("data-theme-control-shadow", "none");
      }
      chromeColor = record.background;
    }
    root.style.backgroundColor = chromeColor;
    themeColorMeta?.setAttribute("content", chromeColor);
  } catch {
    root.classList.add("dark");
    root.style.backgroundColor = DARK_BACKGROUND;
    themeColorMeta?.setAttribute("content", DARK_BACKGROUND);
  }
})();
