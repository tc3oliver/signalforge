import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const web = (p: string) => fileURLToPath(new URL(`./web/node_modules/${p}`, import.meta.url));

export default defineConfig({
	resolve: {
		// The reader's React lives in web/node_modules (web/ installs on its own,
		// see web/README.md). Tests under tests/ render its components, so React
		// and its JSX runtime resolve there rather than at the repo root, and
		// next/link -- which needs a Next router context -- becomes a plain <a>.
		alias: {
			"react-dom/server": web("react-dom/server.js"),
			"react-dom": web("react-dom/index.js"),
			"react/jsx-runtime": web("react/jsx-runtime.js"),
			"react/jsx-dev-runtime": web("react/jsx-dev-runtime.js"),
			react: web("react/index.js"),
			"next/link": fileURLToPath(new URL("./tests/support/next-link-stub.ts", import.meta.url)),
		},
	},
	esbuild: { jsx: "automatic", jsxImportSource: "react" },
	test: {
		include: ["tests/**/*.test.ts"],
		// Loads .env before any test module, so the Postgres-backed suites run
		// instead of skipping themselves into a green summary.
		setupFiles: ["tests/support/load-env.ts"],
		testTimeout: 20_000,
	},
});
