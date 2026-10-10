// Zod schemas for API request bodies. Kept separate from index.ts so the web bundle,
// which only needs types and constants, doesn't pull in zod.
import { z } from "zod";
import { PASSWORD_MIN_LENGTH, USERNAME_RE } from "./index.js";

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
