import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import {
	AgentConfig,
	type AppConfig,
	DiscoveryConfig,
	InterestsConfig,
	SourcesConfig,
	WatchlistsConfig,
} from "./schema.ts";

// Project root, resolved from this file's own location rather than cwd — the
// caller may be invoked via tsx/vitest/a compiled dist/ from anywhere.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function configPath(root: string, file: string): string {
	return join(root, "config", file);
}

/**
 * The local override for a config file: `interests.yaml` -> `interests.local.yaml`.
 *
 * Every `config/*.yaml` in the repository is a shipped default that anyone can
 * read and nobody has to keep. The operator's real configuration -- which
 * topics they care about, which repositories they watch, which models they pay
 * for -- is theirs, is often the most personal thing in the checkout, and has
 * no business being tracked. `*.local.yaml` is gitignored and wins outright
 * when present.
 *
 * Outright, not merged. A deep merge would mean the effective configuration
 * lived in neither file and could not be read off disk, and the failure mode is
 * ugly: a default topic the operator thought they had deleted quietly steering
 * the brief. One file answers for each concern.
 */
export function localConfigName(file: string): string {
	const dot = file.lastIndexOf(".");
	return `${file.slice(0, dot)}.local${file.slice(dot)}`;
}

/** Parses one YAML file against its schema, throwing an error naming file + field path on failure. */
function loadYamlFile<Schema extends z.ZodType>(root: string, file: string, schema: Schema): z.infer<Schema> {
	const local = configPath(root, localConfigName(file));
	const shipped = configPath(root, file);
	const path = existsSync(local) ? local : shipped;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(`Config file not found or unreadable: ${path}`, { cause: err });
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		throw new Error(`Failed to parse YAML in ${path}: ${(err as Error).message}`, { cause: err });
	}

	const result = schema.safeParse(parsed);
	if (!result.success) {
		const details = result.error.issues
			.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new Error(`Invalid config in ${path}:\n${details}`);
	}
	return result.data;
}

let cached: AppConfig | undefined;

/**
 * Loads and validates all config files under `<root>/config/`, caching the
 * result. `root` defaults to the project root (not cwd) so a shell alias or
 * an invocation from a subdirectory can't silently pick up the wrong files.
 */
export function loadConfig(root: string = PROJECT_ROOT): AppConfig {
	if (cached) return cached;
	cached = {
		// Order matters only for which file an invalid-config error names first;
		// keep it the on-disk reading order.
		interests: loadYamlFile(root, "interests.yaml", InterestsConfig),
		watchlists: loadYamlFile(root, "watchlists.yaml", WatchlistsConfig),
		sources: applyEnvOverrides(loadYamlFile(root, "sources.yaml", SourcesConfig), process.env),
		discovery: loadYamlFile(root, "discovery.yaml", DiscoveryConfig),
		agent: loadYamlFile(root, "agent.yaml", AgentConfig),
	};
	return cached;
}

/**
 * A Miniflux instance lives at a different address on every machine, so its URL
 * belongs with the operator's other per-machine settings rather than in a
 * tracked config file. It is not a credential, but it arrives beside one — the
 * API key is useless without it — so `MINIFLUX_URL` from the environment (which
 * is where secrets.env lands) wins over the `rss.baseUrl` checked in here.
 *
 * Deliberately narrow: this is not a general "every config key is also an env
 * var" mechanism, which would make the effective configuration unreadable.
 */
export function applyEnvOverrides(
	sources: AppConfig["sources"],
	env: NodeJS.ProcessEnv,
): AppConfig["sources"] {
	const minifluxUrl = env["MINIFLUX_URL"]?.trim();
	if (minifluxUrl === undefined || minifluxUrl === "") return sources;
	return {
		...sources,
		collectors: {
			...sources.collectors,
			rss: { ...sources.collectors["rss"]!, baseUrl: minifluxUrl.replace(/\/$/, "") },
		},
	};
}

/** Test-only: clears the cache so a fresh {@link loadConfig} call re-reads disk. */
export function reloadConfig(): void {
	cached = undefined;
}

/** Returns the source types whose collector is enabled in `config/sources.yaml`. */
export function resolveEnabledSources(config: AppConfig): string[] {
	return Object.entries(config.sources.collectors)
		.filter(([, cfg]) => cfg.enabled)
		.map(([sourceType]) => sourceType);
}
