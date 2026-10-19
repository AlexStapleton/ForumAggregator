// When to check a source next (DESIGN §7). Pure, so it's easy to test.
import type { AppConfig } from "../config.js";

export interface NextCheckInput {
  now: number;
  intervalMinutes: number;
  /** Consecutive failures *including* the one just recorded (0 after a success). */
  failures: number;
  polling: AppConfig["polling"];
  retryAfterMs?: number;
  random?: () => number;
}

export interface NextCheck {
  /** null = paused by the circuit breaker; needs a manual retry. */
  at: number | null;
  paused: boolean;
}

export function nextCheck({ now, intervalMinutes, failures, polling, retryAfterMs, random = Math.random }: NextCheckInput): NextCheck {
  const interval = intervalMinutes * 60_000;
  if (failures === 0) {
    // ±10 % jitter so sources added together don't stay in lockstep.
    return { at: now + Math.round(interval * (0.9 + random() * 0.2)), paused: false };
  }
  if (failures >= polling.circuitBreakerFailures) return { at: null, paused: true };
  const cap = polling.backoffMaxHours * 3_600_000;
  const backoff = Math.min(interval * 2 ** (failures - 1), cap);
  return { at: now + Math.max(backoff, Math.min(retryAfterMs ?? 0, cap)), paused: false };
}
