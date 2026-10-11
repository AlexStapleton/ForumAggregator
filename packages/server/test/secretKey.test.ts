import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY_FILE, resolveSecretKey } from "../src/secretKey.js";

describe("resolveSecretKey", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-key-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("prefers FA_SECRET_KEY and writes nothing", () => {
    const r = resolveSecretKey("e".repeat(40), dir);
    expect(r).toEqual({ key: "e".repeat(40), source: "env" });
    expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false);
  });

  it("generates a private key file once, then reuses it", () => {
    const first = resolveSecretKey(undefined, dir);
    expect(first.source).toBe("generated");
    expect(first.key.length).toBeGreaterThanOrEqual(32);
    const file = path.join(dir, KEY_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const second = resolveSecretKey(undefined, dir);
    expect(second).toMatchObject({ source: "file", key: first.key });
  });

  it("refuses a truncated key file instead of silently replacing it", () => {
    fs.writeFileSync(path.join(dir, KEY_FILE), "too-short\n");
    expect(() => resolveSecretKey(undefined, dir)).toThrow(/shorter than 32/);
  });
});
