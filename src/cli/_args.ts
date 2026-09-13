/** Minimal flag parser: `--date 2026-09-12 --run-id abc --json`. No dependency needed. */
export function parseFlags(argv: string[]): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			out[key] = next;
			i++;
		} else {
			out[key] = true;
		}
	}
	return out;
}

export function requireString(flags: Record<string, string | boolean>, name: string): string {
	const v = flags[name];
	if (typeof v !== "string" || v.length === 0) {
		throw new Error(`Missing required flag --${name}`);
	}
	return v;
}

export function projectRoot(): string {
	return new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
}
