import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// Loads .env before any test module, so the Postgres-backed suites run
		// instead of skipping themselves into a green summary.
		setupFiles: ["tests/support/load-env.ts"],
		testTimeout: 20_000,
	},
});
