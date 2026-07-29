import { describe, it, expect } from "vitest";
import { isZipFile } from "./zipUtils";

describe("isZipFile", () => {
  it("returns true for .zip extension", () => {
    expect(isZipFile("archive.zip")).toBe(true);
  });

  it("returns true for uppercase extension", () => {
    expect(isZipFile("ARCHIVE.ZIP")).toBe(true);
  });

  it("returns true for mixed case", () => {
    expect(isZipFile("Mixed.Zip")).toBe(true);
  });

  it("returns false for non-zip extensions", () => {
    expect(isZipFile("model.stl")).toBe(false);
    expect(isZipFile("image.png")).toBe(false);
    expect(isZipFile("model.zipx")).toBe(false);
  });

  it("handles filenames with directories", () => {
    expect(isZipFile("folder/sub/archive.zip")).toBe(true);
    expect(isZipFile("/abs/path/file.stl")).toBe(false);
  });

  it("returns false for empty strings", () => {
    expect(isZipFile("")).toBe(false);
  });
});
