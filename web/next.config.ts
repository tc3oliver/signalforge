import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { NextConfig } from "next";

/*
 * `externalDir` lets the app import the repo's existing typed query layer in
 * `../src/db` directly. The alternative — a second copy of the data access code
 * inside web/ — would let the reader and the pipeline drift apart on what a
 * story or a fact is, which is exactly the failure this project cannot afford.
 */
// The app reads source files from ../src, so file tracing is rooted at the repo,
// not at web/ — otherwise Next guesses from whichever lockfile it finds first.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const config: NextConfig = {
	experimental: { externalDir: true },
	outputFileTracingRoot: repoRoot,
	// The reader publishes nothing and embeds nothing third-party.
	poweredByHeader: false,
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "Referrer-Policy", value: "no-referrer" },
					// Stored source content is untrusted. No inline script, no remote
					// origin of any kind: nothing here phones home, and a stray script
					// tag in a feed title cannot execute even if escaping regressed.
					{
						key: "Content-Security-Policy",
						value: [
							"default-src 'self'",
							"img-src 'self' data:",
							"style-src 'self' 'unsafe-inline'",
							"script-src 'self' 'unsafe-inline'",
							"connect-src 'self'",
							"frame-ancestors 'none'",
							"base-uri 'none'",
							"form-action 'self'",
						].join("; "),
					},
				],
			},
		];
	},
};

export default config;
