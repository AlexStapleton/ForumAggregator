// Zod schemas for API request bodies. Kept separate from index.ts so the web bundle,
// which only needs types and constants, doesn't pull in zod.
import { z } from "zod";
import { MAX_TAGS, normaliseTag, PASSWORD_MIN_LENGTH, USERNAME_RE } from "./index.js";

const tags = z
  .array(z.string().max(60))
  .max(MAX_TAGS * 2)
  .transform((list) => [...new Set(list.map(normaliseTag).filter(Boolean))].slice(0, MAX_TAGS));

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_RE, "3–32 characters: letters, digits, _ . -");
const newPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `At least ${PASSWORD_MIN_LENGTH} characters`)
  .max(256);
const totpCode = z.string().regex(/^\d{6}$/, "6-digit code");

export const SetupRequest = z.object({
  setupCode: z.string().min(1),
  username,
  password: newPassword,
});
export type SetupRequest = z.infer<typeof SetupRequest>;

export const LoginRequest = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(256),
  totpCode: totpCode.optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const TotpEnableRequest = z.object({ code: totpCode });
export type TotpEnableRequest = z.infer<typeof TotpEnableRequest>;

export const TotpDisableRequest = z.object({
  password: z.string().min(1).max(256),
  code: totpCode,
});
export type TotpDisableRequest = z.infer<typeof TotpDisableRequest>;

export const AddSourceRequest = z.object({
  /** A feed URL, a website (its feed is discovered), or a YouTube channel URL / @handle. */
  url: z.string().trim().min(1, "Enter a URL").max(2000),
  title: z.string().trim().max(200).optional(),
  tags: tags.optional(),
});
export type AddSourceRequest = z.infer<typeof AddSourceRequest>;

export const UpdateSourceRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  pollIntervalMinutes: z.number().int().min(5).max(7 * 24 * 60).nullable().optional(),
  /** Changing the address re-checks it before saving; existing items are kept. */
  url: z.string().trim().min(1).max(2000).optional(),
  tags: tags.optional(),
  /** null = global default, 0 = keep forever. */
  retentionDays: z.number().int().min(0).max(3650).nullable().optional(),
});
export type UpdateSourceRequest = z.infer<typeof UpdateSourceRequest>;

export const UpdateItemRequest = z.object({
  read: z.boolean().optional(),
  saved: z.boolean().optional(),
});
export type UpdateItemRequest = z.infer<typeof UpdateItemRequest>;

export const MarkReadRequest = z.object({
  sourceId: z.string().optional(),
  /** Only sources with this tag (matches the feed's tag filter). */
  tag: z.string().optional(),
  /** Only items published at or before this time (what the user was looking at). */
  upTo: z.number().int().optional(),
});
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;
