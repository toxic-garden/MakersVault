import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UnauthorizedError, assertOk } from "./api";

describe("UnauthorizedError", () => {
  it("is an Error subclass with the correct name", () => {
    const e = new UnauthorizedError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("UnauthorizedError");
  });

  it("accepts a custom message", () => {
    const e = new UnauthorizedError("custom");
    expect(e.message).toBe("custom");
  });
});

describe("assertOk", () => {
  it("throws UnauthorizedError on 401", () => {
    const res = { status: 401, ok: false } as Response;
    expect(() => assertOk(res, "ignored")).toThrow(UnauthorizedError);
  });

  it("throws generic Error on non-ok non-401", () => {
    const res = { status: 500, ok: false } as Response;
    expect(() => assertOk(res, "boom")).toThrow("boom");
  });

  it("does not throw on ok responses", () => {
    const res = { status: 200, ok: true } as Response;
    expect(() => assertOk(res, "ignored")).not.toThrow();
  });

  it("does not throw on 2xx", () => {
    const res = { status: 204, ok: true } as Response;
    expect(() => assertOk(res, "ignored")).not.toThrow();
  });
});
