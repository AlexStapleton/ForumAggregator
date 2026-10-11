// config.yaml: what to follow and how politely to fetch it (DESIGN §7).
// M0 only defines the global defaults; sites/subscriptions are filled in from M1 on,
// and the settings screen (M4) will read/write the same structure.
import fs from "node:fs";
import YAML from "yaml";
import { z } from "zod";

export const PollingSchema = z
  .object({
    /** How often a site- or board-level subscription is checked. */
    intervalMinutes: z.number().int().min(1).default(30),
    /** How often a followed thread is checked. */
    threadIntervalMinutes: z.number().int().min(1).default(15),
    /** Minimum gap between two requests to the same host. */
    minDelaySeconds: z.number().min(0).default(5),
    /** Random extra delay (0..jitter) added to every request. */
    jitterSeconds: z.number().min(0).default(3),
    maxConcurrentPerHost: z.number().int().min(1).max(4).default(1),
    /** How far back to page through a busy thread or board per poll. */
    maxPagesPerPoll: z.number().int().min(1).max(50).default(3),
    /** Upper bound for exponential backoff after 429/503 responses. */
    backoffMaxHours: z.number().min(0.1).default(6),
    /** Consecutive failures before a site is paused and flagged in the UI. */
    circuitBreakerFailures: z.number().int().min(1).default(5),
  })
  .strict();

export const SiteSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes"),
    type: z.enum(["xenforo", "youtube", "reddit"]),
    url: z.url(),
    polling: PollingSchema.partial().optional(),
  })
  // Adapter-specific keys are added in later milestones; don't reject them yet.
  .passthrough();

export const ConfigSchema = z
  .object({
    polling: PollingSchema.default(PollingSchema.parse({})),
    retention: z
      .object({
        /** Delete unsaved items older than this. 0 keeps everything. */
        keepDays: z.number().int().min(0).default(0),
      })
      .strict()
      .default({ keepDays: 0 }),
    sites: z.array(SiteSchema).default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.sites.forEach((site, i) => {
      if (seen.has(site.id)) {
        ctx.addIssue({ code: "custom", path: ["sites", i, "id"], message: `duplicate site id "${site.id}"` });
      }
      seen.add(site.id);
    });
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: AppConfig;
  /** false when the file did not exist and defaults were used. */
  fromFile: boolean;
}

export function parseConfig(text: string, source = "config"): AppConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(text) ?? {};
  } catch (err) {
    throw new Error(`${source}: not valid YAML: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`,
    );
    throw new Error(`${source} is invalid:\n${lines.join("\n")}`);
  }
  return result.data;
}

export function loadConfig(file: string): LoadedConfig {
  if (!fs.existsSync(file)) {
    return { config: ConfigSchema.parse({}), fromFile: false };
  }
  return { config: parseConfig(fs.readFileSync(file, "utf8"), file), fromFile: true };
}
