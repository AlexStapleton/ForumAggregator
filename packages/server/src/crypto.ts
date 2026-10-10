// Encryption at rest for stored secrets (forum passwords, sessions, TOTP secret).
// AES-256-GCM with a key derived from FA_SECRET_KEY via HKDF.
import crypto from "node:crypto";

const VERSION = "v1";

export interface SecretBox {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export function createSecretBox(secretKey: string): SecretBox {
  const key = Buffer.from(
    crypto.hkdfSync("sha256", secretKey, "forumaggregator", "secret-box-v1", 32),
  );
  return {
    encrypt(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VERSION}:${Buffer.concat([iv, tag, body]).toString("base64")}`;
    },
    decrypt(ciphertext) {
      const [version, payload] = ciphertext.split(":", 2);
      if (version !== VERSION || !payload) throw new Error("Unsupported secret format");
      const raw = Buffer.from(payload, "base64");
      if (raw.length < 28) throw new Error("Secret is truncated");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      // Throws if the data was tampered with or FA_SECRET_KEY changed.
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
