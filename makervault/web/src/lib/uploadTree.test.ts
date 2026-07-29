import { describe, it, expect } from "vitest";
import { entriesFromFileList } from "./uploadTree";

class FakeFile extends File {
  constructor(parts: BlobPart[], name: string, options?: FilePropertyBag) {
    super(parts, name, options);
  }
  // Older browsers / jsdom may not provide webkitRelativePath
  override get webkitRelativePath(): string {
    return "";
  }
}

function makeFile(name: string, content = "x"): File {
  return new FakeFile([content], name, { type: "application/octet-stream" });
}

describe("entriesFromFileList", () => {
  it("returns an entry per file", () => {
    const files = [makeFile("a.stl"), makeFile("b.stl")];
    const entries = entriesFromFileList(files);
    expect(entries).toHaveLength(2);
    expect(entries[0].file.name).toBe("a.stl");
    expect(entries[1].file.name).toBe("b.stl");
  });

  it("uses webkitRelativePath when present", () => {
    const file = Object.defineProperty(makeFile("a.stl"), "webkitRelativePath", {
      value: "folder/a.stl",
    });
    const entries = entriesFromFileList([file]);
    expect(entries[0].relativePath).toBe("folder/a.stl");
  });

  it("falls back to file.name when no webkitRelativePath", () => {
    const entries = entriesFromFileList([makeFile("a.stl")]);
    expect(entries[0].relativePath).toBe("a.stl");
  });

  it("normalizes Windows-style backslashes to forward slashes", () => {
    const file = Object.defineProperty(makeFile("a.stl"), "webkitRelativePath", {
      value: "folder\\sub\\a.stl",
    });
    const entries = entriesFromFileList([file]);
    expect(entries[0].relativePath).toBe("folder/sub/a.stl");
  });

  it("strips leading slashes", () => {
    const file = Object.defineProperty(makeFile("a.stl"), "webkitRelativePath", {
      value: "/abs/path/a.stl",
    });
    const entries = entriesFromFileList([file]);
    expect(entries[0].relativePath).toBe("abs/path/a.stl");
  });

  it("handles empty input", () => {
    expect(entriesFromFileList([])).toEqual([]);
  });
});
