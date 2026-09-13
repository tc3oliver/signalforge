/*
 * Read-only preflight for a fresh checkout: tells you what is ready, what is
 * missing, and what each missing thing would cost you.
 *
 * It changes nothing. It starts no container, writes no config, applies no
 * migration and contacts no provider. Every check either reports a fact about
 * the local machine or reports that it could not.
 *
 * It never prints a secret. Credential checks report a name and whether some
 * value is present, never a value, never a prefix, never a length.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSql, dbConfigFromEnv } from "../db/client.ts";
import { loadConfig, localConfigName } from "../config/loader.ts";
import { loadSecretsFile } from "../config/secrets-file.ts";
import { resolveEnabledSources } from "../config/loader.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

type Status = "ok" | "warn" | "fail";
type Check = { name: string; status: Status; detail: string; fix?: string };

const results: Check[] = [];
function record(name: string, status: Status, detail: string, fix?: string): void {
	results.push(fix === undefined ? { name, status, detail } : { name, status, detail, fix });
}

// ------------------------------------------------------------------ runtime

function checkNode(): void {
	const major = Number(process.versions.node.split(".")[0]);
	if (major >= 24) record("Node", "ok", `v${process.versions.node}`);
	else
		record("Node", "fail", `v${process.versions.node}, need >= 24`, "Install Node 24+ (see package.json engines)");
}

// ------------------------------------------------------------------- config

const CONFIG_FILES = ["interests.yaml", "watchlists.yaml", "sources.yaml", "discovery.yaml", "agent.yaml"];

function checkConfig(): void {
	const missing = CONFIG_FILES.filter((f) => !existsSync(join(ROOT, "config", f)));
	if (missing.length > 0) {
		record("Config files", "fail", `missing: ${missing.join(", ")}`, "These ship with the repository; re-clone it");
		return;
	}

	const overridden = CONFIG_FILES.filter((f) => existsSync(join(ROOT, "config", localConfigName(f))));
	const personal = ["interests.yaml", "watchlists.yaml"];
	const usingShipped = personal.filter((f) => !overridden.includes(f));

	record(
		"Config files",
		usingShipped.length > 0 ? "warn" : "ok",
		overridden.length > 0 ? `local overrides: ${overridden.map(localConfigName).join(", ")}` : "all shipped defaults",
		usingShipped.length > 0
			? `Still on the shipped example for ${usingShipped.join(" and ")}. Copy to ${usingShipped
					.map(localConfigName)
					.join(" / ")} and put your own topics in -- otherwise the brief reflects an example, not you.`
			: undefined,
	);

	try {
		const config = loadConfig(ROOT);
		const enabled = resolveEnabledSources(config);
		record("Config validity", "ok", `parses; ${config.interests.topics.length} topics, ${enabled.length} sources enabled`);
	} catch (err) {
		record("Config validity", "fail", (err as Error).message.split("\n")[0] ?? "invalid", "Fix the file named above");
	}
}

// -------------------------------------------------------------- credentials

/**
 * Names only. `loadSecretsFile` returns which names were set; this never asks
 * it for a value, so no value can reach the terminal even by accident.
 */
function checkSecrets(): void {
	let setNames: string[] = [];
	let path = "(none)";
	try {
		// A copy, not process.env itself: loadSecretsFile sets what it reads into
		// whatever env it is handed, and a preflight advertised as read-only must
		// not quietly populate this process's environment. It has to be a copy
		// rather than an empty object, because the path of the file is itself
		// taken from the environment -- with `{}` the override is invisible and
		// the check silently reports on the default location instead of the one
		// actually in use.
		const result = loadSecretsFile({ env: { ...process.env } });
		setNames = result.loaded;
		path = result.found ? result.path : "(none)";
	} catch {
		// A missing or unreadable file is a normal state, not an error: the
		// product is expected to run with no credentials at all.
	}

	const fromEnv = ["GITHUB_TOKEN", "TAVILY_API_KEY", "FRED_API_KEY", "MINIFLUX_API_KEY", "YOUTUBE_API_KEY"].filter(
		(n) => (process.env[n] ?? "").trim() !== "",
	);
	const present = new Set([...setNames, ...fromEnv]);

	if (present.size === 0) {
		record(
			"Credentials",
			"warn",
			"none configured",
			"Everything still runs; sources needing a key report DISABLED. See README -> Data Sources.",
		);
		return;
	}
	record("Credentials", "ok", `${present.size} configured: ${[...present].sort().join(", ")}`, undefined);
	if (path !== "(none)") record("Secrets file", "ok", path);
}

// ------------------------------------------------------------------- models

function checkModels(): void {
	try {
		const chain = loadConfig(ROOT).agent.modelChain;
		const first = chain[0];
		if (!first) {
			record("Model chain", "fail", "empty", "Add at least one provider/model to config/agent.yaml");
			return;
		}
		record(
			"Model chain",
			"ok",
			`${chain.length} entries, primary ${first.provider}/${first.model}`,
			"Whether you can authenticate as these providers is checked by `pi auth check`, not here.",
		);
	} catch {
		record("Model chain", "fail", "config/agent.yaml did not parse");
	}
}

// ---------------------------------------------------------------- database

/**
 * Where we tried to connect, with no credential in it. DATABASE_URL carries a
 * password, so it is parsed for host/port/database and the userinfo is dropped
 * rather than the string being printed. An unparseable URL yields a constant,
 * never a fragment of the original.
 */
function describeTarget(cfg: ReturnType<typeof dbConfigFromEnv>): string {
	if (cfg.url) {
		try {
			const u = new URL(cfg.url);
			return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
		} catch {
			return "the configured DATABASE_URL";
		}
	}
	return `${cfg.host ?? "localhost"}:${cfg.port ?? 5432}`;
}

async function checkDatabase(): Promise<void> {
	const cfg = dbConfigFromEnv();
	const sql = createSql(cfg);
	try {
		const rows = await sql<{ n: number }[]>`select 1 as n`;
		if (rows[0]?.n !== 1) throw new Error("unexpected response");

		const applied = await sql<{ name: string }[]>`
			select name from schema_migrations order by name
		`.catch(() => []);
		const onDisk = readdirSync(join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql"));
		if (applied.length === 0) {
			record("Database", "warn", "reachable, no migrations applied", "Run: pnpm db:migrate");
		} else if (applied.length < onDisk.length) {
			record(
				"Database",
				"warn",
				`reachable, ${applied.length} of ${onDisk.length} migrations applied`,
				"Run: pnpm db:migrate",
			);
		} else {
			record("Database", "ok", `reachable, ${applied.length} migrations applied`);
		}
	} catch (err) {
		// postgres.js reports a connection refusal with an empty message and the
		// detail only on `code`, which produced a uselessly blank "not reachable
		// ()". Prefer whichever of the three actually says something.
		const e = err as NodeJS.ErrnoException & { code?: string };
		const why = [e.message?.split("\n")[0], e.code, (e.cause as Error | undefined)?.message]
			.filter((x): x is string => typeof x === "string" && x.trim() !== "")
			.join(" ")
			.trim();
		record(
			"Database",
			"fail",
			`not reachable at ${describeTarget(cfg)}${why ? ` (${why})` : ""}`,
			"Start it with: docker compose up -d   (then: pnpm db:migrate)",
		);
	} finally {
		await sql.end({ timeout: 5 }).catch(() => {});
	}
}

// ------------------------------------------------------------------- output

function report(): number {
	const width = Math.max(...results.map((r) => r.name.length));
	const mark: Record<Status, string> = { ok: "  OK  ", warn: " WARN ", fail: " FAIL " };

	console.log("\nSignalForge setup check\n");
	for (const r of results) {
		console.log(`[${mark[r.status]}] ${r.name.padEnd(width)}  ${r.detail}`);
		if (r.fix) console.log(`${" ".repeat(width + 11)}${r.fix}`);
	}

	const failed = results.filter((r) => r.status === "fail");
	const warned = results.filter((r) => r.status === "warn");
	console.log("");
	if (failed.length > 0) {
		console.log(`${failed.length} check(s) failed. SignalForge will not run until those are fixed.`);
		return 1;
	}
	if (warned.length > 0) {
		console.log(`Ready to run, with ${warned.length} thing(s) worth reading above.`);
		return 0;
	}
	console.log("Ready.");
	return 0;
}

checkNode();
checkConfig();
checkSecrets();
checkModels();
await checkDatabase();
process.exit(report());
