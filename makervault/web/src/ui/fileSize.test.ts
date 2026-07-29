import { describe, it, expect } from "vitest";
import { formatFileSize } from "./fileSize";

describe("formatFileSize", () => {
  it("returns empty string for nullish bytes", () => {
    expect(formatFileSize(0 as unknown as number)).toBe("");
  });

  it("formats bytes (< 1024) as integer", () => {
    expect(formatFileSize(512)).toBe("512 B");
  });

  it("formats kilobytes with one decimal", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatFileSize(5.5 * 1024 * 1024)).toBe("5.5 MB");
  });

  it("formats gigabytes", () => {
    expect(formatFileSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("caps unit at GB", () => {
    expect(formatFileSize(2048 * 1024 * 1024 * 1024)).toMatch(/GB/);
  });

  it("handles 0 bytes", () => {
    // 0 is a valid input that falls through the !bytes check
    expect(formatFileSize(0)).toBe("0 B");
  });
});
