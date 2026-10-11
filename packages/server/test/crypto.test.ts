import { describe, expect, it } from "vitest";
import { createSecretBox, safeEqual } from "../src/crypto.js";

describe("SecretBox", () => {
  const box = createSecretBox("a".repeat(40));

  it("round-trips and uses a fresh IV each time", () => {
    const a = box.encrypt("hunter2 ✓");
    const b = box.encrypt("hunter2 ✓");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(box.decrypt(a)).toBe("hunter2 ✓");
  });

  it("rejects tampered data", () => {
    const enc = box.encrypt("secret");
    const raw = Buffer.from(enc.slice(3), "base64");
    raw[raw.length - 1]! ^= 1;
    expect(() => box.decrypt(`v1:${raw.toString("base64")}`)).toThrow();
  });

  it("can't decrypt with a different key", () => {
    const other = createSecretBox("b".repeat(40));
    expect(() => other.decrypt(box.encrypt("secret"))).toThrow();
  });

  it("rejects unknown formats", () => {
    expect(() => box.decrypt("v0:abc")).toThrow(/Unsupported/);
    expect(() => box.decrypt("v1:AAAA")).toThrow(/truncated/);
  });
});

describe("safeEqual", () => {
  it("compares strings of any length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
