import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Postgres-backed suites share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
