import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // Each beforeEach opens a fresh PGlite (WASM Postgres) and runs the full migration
    // set. Under file parallelism that genuinely exceeds vitest's 10s hook default, and
    // it surfaced as ~13 scattered "Hook timed out" failures across unrelated files as
    // the suite grew past ~50 files. Not flakiness — real work that needs real time.
    hookTimeout: 60_000,
    // Cap the number of concurrent PGlite instances. Each one is a WASM Postgres, so
    // unbounded parallelism thrashes memory rather than going faster.
    poolOptions: { threads: { maxThreads: 4 } },
  },
});
