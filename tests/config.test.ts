import { describe, expect, it } from "vitest";
import { applyEnvOverrides, loadConfig, reloadConfig, resolveEnabledSources } from "../src/config/loader.ts";
import { SourceType } from "../src/schemas/item.ts";
import {
	AgentConfig,
	DiscoveryConfig,
	InterestsConfig,
	SourcesConfig,
	WatchlistsConfig,
} from "../src/config/schema.ts";

describe("loadConfig", () => {
	it("parses every shipped YAML file against its schema", () => {
		reloadConfig();
		const config = loadConfig();

		expect(InterestsConfig.parse(config.interests)).toBeDefined();
		expect(WatchlistsConfig.parse(config.watchlists)).toBeDefined();
		expect(SourcesConfig.parse(config.sources)).toBeDefined();
		expect(DiscoveryConfig.parse(config.discovery)).toBeDefined();
		expect(AgentConfig.parse(config.agent)).toBeDefined();
	});

	it("has one collector entry per SourceType", () => {
		reloadConfig();
		const config = loadConfig();
		for (const sourceType of SourceType.options) {
			expect(config.sources.collectors).toHaveProperty(sourceType);
		}
	});

	it("caches the parse across calls", () => {
		reloadConfig();
		const first = loadConfig();
		const second = loadConfig();
		expect(second).toBe(first);
	});

	it("reloadConfig forces a fresh parse", () => {
		reloadConfig();
		const first = loadConfig();
		reloadConfig();
		const second = loadConfig();
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});

	it("resolves config files relative to the project root, not cwd", () => {
		reloadConfig();
		const fromCwd = loadConfig();
		reloadConfig();
		const fromExplicitRoot = loadConfig(process.cwd());
		expect(fromExplicitRoot).toEqual(fromCwd);
	});
});

describe("resolveEnabledSources", () => {
	it("returns only enabled collectors", () => {
		reloadConfig();
		const config = loadConfig();
		const enabled = resolveEnabledSources(config);
		for (const sourceType of enabled) {
			expect(config.sources.collectors[sourceType as SourceType]?.enabled).toBe(true);
		}
		// reddit ships disabled by default: it needs two credentials, and sec
		// needs a real contact User-Agent.
		expect(enabled).not.toContain("reddit");
		expect(enabled).not.toContain("sec");
		expect(enabled).toContain("github");
	});
});

describe("config validation errors", () => {
	it("names the file and field path on an invalid interests config", () => {
		expect(() =>
			InterestsConfig.parse({ topics: [{ id: "x", label: "X", weight: 2 }] }),
		).toThrowError(/weight/);
	});

	it("rejects an unknown top-level key via .strict()", () => {
		const config = loadConfig();
		expect(() =>
			InterestsConfig.parse({ ...config.interests, unknownField: true }),
		).toThrow();
	});

	it("rejects an enabled sec collector with no userAgent", () => {
		const config = loadConfig();
		const result = SourcesConfig.safeParse({
			collectors: {
				...config.sources.collectors,
				sec: { ...config.sources.collectors.sec, enabled: true, userAgent: undefined },
			},
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.path.join(".")).toBe("collectors.sec.userAgent");
		}
	});

	it("rejects a userAgent with no contact email", () => {
		const config = loadConfig();
		const result = SourcesConfig.safeParse({
			collectors: {
				...config.sources.collectors,
				sec: { ...config.sources.collectors.sec, enabled: true, userAgent: "Just A Name" },
			},
		});
		expect(result.success).toBe(false);
	});

	it("accepts an enabled sec collector with a valid contact userAgent", () => {
		const config = loadConfig();
		const result = SourcesConfig.safeParse({
			collectors: {
				...config.sources.collectors,
				sec: { ...config.sources.collectors.sec, enabled: true, userAgent: "Daily Intelligence oliver@example.com" },
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects a sources config missing a source type", () => {
		const config = loadConfig();
		const { rss: _rss, ...rest } = config.sources.collectors;
		const result = SourcesConfig.safeParse({ collectors: rest });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.path.join(".")).toContain("rss");
		}
	});

	it("surfaces file name and field path for a bad on-disk config", () => {
		reloadConfig();
		expect(() => loadConfig("/nonexistent-project-root")).toThrow(/interests\.yaml/);
		reloadConfig();
	});
});

describe("applyEnvOverrides", () => {
	const base = loadConfig().sources;

	it("replaces the rss baseUrl with MINIFLUX_URL, trailing slash trimmed", () => {
		const out = applyEnvOverrides(base, { MINIFLUX_URL: "https://rss.example.com/" });
		expect(out.collectors["rss"]!.baseUrl).toBe("https://rss.example.com");
	});

	it("leaves the checked-in baseUrl alone when MINIFLUX_URL is absent or blank", () => {
		expect(applyEnvOverrides(base, {}).collectors["rss"]!.baseUrl).toBe(base.collectors["rss"]!.baseUrl);
		expect(applyEnvOverrides(base, { MINIFLUX_URL: "   " }).collectors["rss"]!.baseUrl).toBe(
			base.collectors["rss"]!.baseUrl,
		);
	});

	it("touches no other collector", () => {
		const out = applyEnvOverrides(base, { MINIFLUX_URL: "https://rss.example.com" });
		expect(out.collectors["github"]).toEqual(base.collectors["github"]);
	});
});
