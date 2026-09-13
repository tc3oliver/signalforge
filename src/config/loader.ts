import { readFileSync } from "node:fs";
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

/** Parses one YAML file against its schema, throwing an error naming file + field path on failure. */
function loadYamlFile<Schema extends z.ZodType>(root: string, file: string, schema: Schema): z.infer<Schema> {
	const path = configPath(root, file);
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
		interests: loadYamlFile(root, "interests.yaml", InterestsConfig),
		watchlists: loadYamlFile(root, "watchlists.yaml", WatchlistsConfig),
		sources: loadYamlFile(root, "sources.yaml", SourcesConfig),
		discovery: loadYamlFile(root, "discovery.yaml", DiscoveryConfig),
		agent: loadYamlFile(root, "agent.yaml", AgentConfig),
	};
	return cached;
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
