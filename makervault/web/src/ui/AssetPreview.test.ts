import { describe, it, expect } from "vitest";
import { extOf } from "./AssetPreview";

describe("extOf", () => {
  it("returns lowercase extension without dot", () => {
    expect(extOf("model.STL")).toBe("stl");
    expect(extOf("file.stl")).toBe("stl");
  });

  it("returns empty string for files without extension", () => {
    expect(extOf("README")).toBe("");
    expect(extOf("")).toBe("");
  });

  it("handles filenames with multiple dots", () => {
    expect(extOf("archive.tar.gz")).toBe("gz");
    expect(extOf("model.v2.stl")).toBe("stl");
  });

  it("handles filenames with directories", () => {
    expect(extOf("folder/sub/model.stl")).toBe("stl");
  });

  it("handles filenames starting with a dot", () => {
    // ".gitignore" → capture is "gitignore", which is the right behavior
    expect(extOf(".gitignore")).toBe("gitignore");
  });
});
