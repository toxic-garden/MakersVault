import { describe, it, expect, beforeEach } from "vitest";
import {
  loadSettings,
  saveSettings,
  resolveTheme,
  type AppSettings,
} from "./settings";

const KEY = "makersvault_settings";

describe("loadSettings", () => {
  beforeEach(() => localStorage.clear());

  it("returns DEFAULT_SETTINGS when localStorage is empty", () => {
    const s = loadSettings();
    expect(s.theme.selected).toBe("system");
  });

  it("returns DEFAULT_SETTINGS when JSON is malformed", () => {
    localStorage.setItem(KEY, "{not json");
    const s = loadSettings();
    expect(s.theme.selected).toBe("system");
  });

  it("persists and reloads settings", () => {
    saveSettings({ ...loadSettings(), theme: { selected: "neon" } });
    const s = loadSettings();
    expect(s.theme.selected).toBe("neon");
  });

  it("falls back to legacy theme key when new theme is invalid", () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: { selected: "bogus" } }));
    localStorage.setItem("makersvault_theme", "dark");
    const s = loadSettings();
    expect(s.theme.selected).toBe("dark");
  });

  it("falls back to default when both new and legacy theme are invalid", () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: { selected: "bogus" } }));
    localStorage.setItem("makersvault_theme", "rainbow");
    const s = loadSettings();
    expect(s.theme.selected).toBe("system");
  });

  it("merges partial settings with defaults", () => {
    localStorage.setItem(KEY, JSON.stringify({ network: { publicUrl: "https://x" } }));
    const s = loadSettings();
    expect(s.network.publicUrl).toBe("https://x");
    expect(s.theme.selected).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("returns the explicit theme id when not 'system'", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("neon")).toBe("neon");
    expect(resolveTheme("purple")).toBe("purple");
    expect(resolveTheme("blue")).toBe("blue");
  });

  it("resolves 'system' based on matchMedia when window is defined", () => {
    // jsdom defaults to light scheme (no dark preference match)
    expect(resolveTheme("system")).toBe("light");
  });
});

describe("saveSettings", () => {
  beforeEach(() => localStorage.clear());

  it("writes JSON to localStorage", () => {
    const settings: AppSettings = loadSettings();
    settings.theme.selected = "purple";
    saveSettings(settings);
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    expect(raw.theme.selected).toBe("purple");
  });

  it("does not throw on storage errors", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceeded");
    };
    try {
      expect(() => saveSettings(loadSettings())).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
