import { describe, it, expect, beforeEach } from "vitest";
import {
  appendTokenToUrl,
  authHeaders,
  clearToken,
  readToken,
  storeToken,
} from "./auth";

describe("token storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when no token stored", () => {
    expect(readToken()).toBeNull();
  });

  it("round-trips a token via store/read", () => {
    storeToken("abc.def.ghi");
    expect(readToken()).toBe("abc.def.ghi");
  });

  it("clearToken removes the stored token", () => {
    storeToken("abc");
    clearToken();
    expect(readToken()).toBeNull();
  });
});

describe("authHeaders", () => {
  beforeEach(() => localStorage.clear());

  it("returns empty headers when no token is set", () => {
    const headers = authHeaders();
    expect(headers.has("Authorization")).toBe(false);
  });

  it("attaches Authorization header when a token exists", () => {
    storeToken("my-token");
    const headers = authHeaders();
    expect(headers.get("Authorization")).toBe("Bearer my-token");
  });

  it("preserves caller-provided headers", () => {
    storeToken("tok");
    const headers = authHeaders({ "X-Custom": "yes" });
    expect(headers.get("X-Custom")).toBe("yes");
    expect(headers.get("Authorization")).toBe("Bearer tok");
  });
});

describe("appendTokenToUrl", () => {
  beforeEach(() => localStorage.clear());

  it("returns the original url when no token is set", () => {
    expect(appendTokenToUrl("http://x/y.png")).toBe("http://x/y.png");
  });

  it("appends token query parameter", () => {
    storeToken("jwt-token");
    const result = appendTokenToUrl("http://api/file.stl");
    expect(result).toContain("token=jwt-token");
  });

  it("preserves existing query string", () => {
    storeToken("jwt");
    const result = appendTokenToUrl("http://api/file?inline=1");
    expect(result).toMatch(/inline=1/);
    expect(result).toMatch(/token=jwt/);
  });

  it("handles malformed URLs by falling back to string concatenation", () => {
    storeToken("jwt");
    const result = appendTokenToUrl("not a url with spaces and special &chars?");
    // Fallback uses ? or & based on whether the URL already has a ?
    expect(result).toMatch(/token=jwt/);
  });
});
