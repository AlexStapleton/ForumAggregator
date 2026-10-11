import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";
import { loadEnv } from "../src/env.js";

describe("loadEnv", () => {
  const base = { FA_SECRET_KEY: "x".repeat(32) };

  it("applies defaults", () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(8080);
    expect(env.AUTH_MODE).toBe("local");
    expect(env.configFile).toBe(path.join("/data", "config.yaml"));
  });

  it("requires a long secret key", () => {
    expect(() => loadEnv({})).toThrow(/FA_SECRET_KEY/);
    expect(() => loadEnv({ FA_SECRET_KEY: "short" })).toThrow(/at least 32/);
  });

  it("treats empty values as unset", () => {
    expect(loadEnv({ ...base, DATABASE_URL: "", PORT: "" }).PORT).toBe(8080);
  });

  it("requires trusted proxies for proxy auth", () => {
    expect(() => loadEnv({ ...base, AUTH_MODE: "proxy" })).toThrow(/AUTH_PROXY_TRUSTED/);
    expect(loadEnv({ ...base, AUTH_MODE: "both", AUTH_PROXY_TRUSTED: "172.18.0.0/16" }).AUTH_MODE).toBe("both");
  });
});

describe("config.yaml", () => {
  it("uses defaults when the file is missing", () => {
    const { config, fromFile } = loadConfig(path.join(os.tmpdir(), "does-not-exist.yaml"));
    expect(fromFile).toBe(false);
    expect(config.polling.minDelaySeconds).toBe(5);
    expect(config.sites).toEqual([]);
  });

  it("merges partial settings with defaults", () => {
    const cfg = parseConfig("polling:\n  intervalMinutes: 60\n");
    expect(cfg.polling.intervalMinutes).toBe(60);
    expect(cfg.polling.maxPagesPerPoll).toBe(3);
  });

  it("parses an empty file", () => {
    expect(parseConfig("").polling.intervalMinutes).toBe(30);
  });

  it("reports typos and bad values with their path", () => {
    expect(() => parseConfig("poling: {}\n")).toThrow(/poling/);
    expect(() => parseConfig("polling:\n  minDelaySeconds: -1\n")).toThrow(/polling\.minDelaySeconds/);
  });

  it("rejects duplicate site ids", () => {
    const yaml = `sites:\n  - {id: a, type: xenforo, url: "https://a.example"}\n  - {id: a, type: youtube, url: "https://b.example"}\n`;
    expect(() => parseConfig(yaml)).toThrow(/duplicate site id/);
  });

  it("parses the example config shipped in the repo", () => {
    const file = path.resolve(import.meta.dirname, "../../../config.example.yaml");
    expect(() => parseConfig(fs.readFileSync(file, "utf8"), file)).not.toThrow();
  });
});
