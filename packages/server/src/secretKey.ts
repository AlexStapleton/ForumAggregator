// Where the encryption key comes from, in order:
//   1. FA_SECRET_KEY (environment), for people who manage secrets themselves;
//   2. $DATA_DIR/secret.key, written on a previous start;
//   3. a new random key, written to $DATA_DIR/secret.key (mode 0600).
// Option 3 means a fresh install needs no configuration at all. The key then lives next to
// the database it protects, so backups of the data folder include it automatically.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const KEY_FILE = "secret.key";

export interface ResolvedKey {
  key: string;
  source: "env" | "file" | "generated";
  file?: string;
}

export function resolveSecretKey(envKey: string | undefined, dataDir: string): ResolvedKey {
  const file = path.join(dataDir, KEY_FILE);
  if (envKey) return { key: envKey, source: "env" };

  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, "utf8").trim();
    if (key.length < 32) {
      throw new Error(`${file} is shorter than 32 characters. Restore it from a backup or set FA_SECRET_KEY.`);
    }
    return { key, source: "file", file };
  }

  const key = crypto.randomBytes(48).toString("base64");
  // "wx" fails if another process created the file in the meantime, so we never overwrite a key.
  fs.writeFileSync(file, `${key}\n`, { mode: 0o600, flag: "wx" });
  return { key, source: "generated", file };
}
