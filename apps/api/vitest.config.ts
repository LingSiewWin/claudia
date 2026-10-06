import { defineConfig } from 'vitest/config';

// Each test boots an in-process Postgres (PGlite) and a Mesh wallet; allow for that on a loaded machine.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
