export type ThemeId = "system" | "light" | "dark" | "neon" | "purple" | "blue";
export type ResolvedTheme = "light" | "dark" | "neon" | "purple" | "blue";
export type ThemeOption = { id: ThemeId; label: string; description: string };

export const THEME_OPTIONS: ThemeOption[] = [
  { id: "system", label: "System", description: "Match your device preference." },
  { id: "light", label: "Light", description: "Bright backgrounds, dark text." },
  { id: "dark", label: "Dark", description: "Dimmed panels for low light." },
  { id: "neon", label: "Neon Green", description: "Black UI with neon green accents." },
  { id: "purple", label: "Neon Purple", description: "Black UI with purple glow highlights." },
  { id: "blue", label: "Neon Blue", description: "Black UI with blue glow highlights." },
];

export type ThemeSettings = {
  selected: ThemeId;
};

export type MakerWorldSettings = {
  cookie: string;
};

export type ThingiverseSettings = {
  cookie: string;
};

export type NetworkSettings = {
  publicUrl: string;
};

export type AppSettings = {
  theme: ThemeSettings;
  makerworld: MakerWorldSettings;
  thingiverse: ThingiverseSettings;
  network: NetworkSettings;
};

const STORAGE_KEY = "makersvault_settings";
const LEGACY_THEME_KEY = "makersvault_theme";

const DEFAULT_SETTINGS: AppSettings = {
  theme: {
    selected: "system",
  },
  makerworld: {
    cookie: "",
  },
  thingiverse: {
    cookie: "",
  },
  network: {
    publicUrl: "",
  },
};

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) || {} : {};
    const theme = parsed.theme || {};
    let themeSelected = typeof theme.selected === "string" ? theme.selected : DEFAULT_SETTINGS.theme.selected;
    const themeValid = THEME_OPTIONS.some(opt => opt.id === themeSelected);
    const makerworld = parsed.makerworld || {};
    const cookie = typeof makerworld.cookie === "string" ? makerworld.cookie : DEFAULT_SETTINGS.makerworld.cookie;
    const thingiverse = parsed.thingiverse || {};
    const thingiverseCookie = typeof thingiverse.cookie === "string"
      ? thingiverse.cookie
      : DEFAULT_SETTINGS.thingiverse.cookie;
    const network = parsed.network || {};
    const publicUrl = typeof network.publicUrl === "string" ? network.publicUrl : DEFAULT_SETTINGS.network.publicUrl;
    if (!themeValid) {
      const legacy = window.localStorage.getItem(LEGACY_THEME_KEY);
      if (legacy === "light" || legacy === "dark") {
        themeSelected = legacy;
      } else {
        themeSelected = DEFAULT_SETTINGS.theme.selected;
      }
    }
    return {
      theme: {
        selected: themeSelected as ThemeId,
      },
      makerworld: {
        cookie,
      },
      thingiverse: {
        cookie: thingiverseCookie,
      },
      network: {
        publicUrl,
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage errors
  }
}

export function resolveTheme(selected: ThemeId): ResolvedTheme {
  if (selected === "system") {
    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "light";
  }
  return selected;
}
