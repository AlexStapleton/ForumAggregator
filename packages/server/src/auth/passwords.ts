import { hash, verify } from "@node-rs/argon2";

// Argon2id with the library defaults (19 MiB, 2 passes): OWASP's recommended minimum,
// and still well under a second on a Raspberry Pi 4.
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Hash to verify against when the user doesn't exist, so timing doesn't reveal usernames. */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hash("not-a-real-password-just-for-timing");
  return dummyHash;
}
