// Entry point: load settings, open + migrate the database, start the HTTP server.
import fs from "node:fs";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate, openDb } from "./db/index.js";
import { loadEnv } from "./env.js";
import { resolveSecretKey } from "./secretKey.js";

async function main() {
  const env = loadEnv();

  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  try {
    fs.accessSync(env.DATA_DIR, fs.constants.W_OK);
  } catch {
    throw new Error(
      `DATA_DIR ${env.DATA_DIR} is not writable by uid ${process.getuid?.()}. ` +
        `The container fixes this itself unless it was started with a fixed user ("user:" / --user) ` +
        `or the folder is on a network share; then run on the host: sudo chown -R <PUID>:<PGID> <your data folder>`,
    );
  }

  const secret = resolveSecretKey(env.FA_SECRET_KEY, env.DATA_DIR);
  const { config, fromFile } = loadConfig(env.configFile);
  const db = openDb({ databaseUrl: env.DATABASE_URL, dataDir: env.DATA_DIR });
  const applied = await migrate(db);

  const { fastify, auth } = await buildApp({ env, secretKey: secret.key, config, db });
  const log = fastify.log;
  if (secret.source === "generated") {
    log.warn({ file: secret.file }, "generated a new encryption key; keep it with your backups of the data folder");
  } else {
    log.info({ source: secret.source }, "encryption key loaded");
  }
  log.info({ database: db.location, kind: db.kind, migrationsApplied: applied }, "database ready");
  log.info({ file: env.configFile, fromFile, sites: config.sites.length }, fromFile ? "config loaded" : "no config file, using defaults");

  const setupCode = await auth.initSetup(env.FA_SETUP_CODE);
  if (setupCode) {
    log.warn(`FIRST RUN: open the app in your browser and create your account with setup code ${setupCode}`);
    // Also print a plain banner: easier to spot in `docker logs` than a JSON line.
    console.log(
      [
        "",
        "  ┌──────────────────────────────────────────────────────────┐",
        "  │  ForumAggregator first-run setup                         │",
        `  │  Setup code: ${setupCode.padEnd(44)}│`,
        "  │  Open the app in your browser and enter this code.       │",
        "  └──────────────────────────────────────────────────────────┘",
        "",
      ].join("\n"),
    );
  }

  const purge = setInterval(() => {
    auth.purgeExpiredSessions().catch((err) => log.error({ err }, "session purge failed"));
  }, 60 * 60 * 1000);
  purge.unref();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, "shutting down");
    clearInterval(purge);
    await fastify.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await fastify.listen({ port: env.PORT, host: env.HOST });
}

main().catch((err: Error) => {
  // Config/env errors are user-facing; print them plainly rather than as a stack trace.
  console.error(`ForumAggregator failed to start: ${err.message}`);
  process.exit(1);
});
