import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { reloadConfig } from "../src/config/loader.ts";
import { DEFAULT_STAGE_TUNING, loadStageTuning } from "../src/config/stage-tuning.ts";

/**
 * The stage bounds are what stop a hung turn: the editor once spent 114 minutes
 * on one attempt because `timeoutMs` was declared in config/agent.yaml and read
 * by nobody. Both the production pipeline and the fixture orchestrator resolve
 * them through this one loader, so its failure mode matters more than its happy
 * path.
 *
 * The failure mode used to be `undefined`, and every call site spread it away
 * with `...(stages ? … : {})` — so a typo in any of the five config files, a
 * gitignored `*.local.yaml` included, quietly restored the unbounded turn the
 * timeout exists to prevent. An unreadable config must still leave every stage
 * bounded; that, not "must not throw", is the contract under test.
 */
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("loadStageTuning", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
		reloadConfig();
	});

	/**
	 * A full copy of the shipped config with one file replaced, so the loader
	 * fails for the reason under test rather than on the first missing file.
	 */
	function configRootWithAgentYaml(agentYaml: string): string {
		const root = mkdtempSync(join(tmpdir(), "stage-tuning-"));
		roots.push(root);
		cpSync(join(PROJECT_ROOT, "config"), join(root, "config"), { recursive: true });
		rmSync(join(root, "config", "agent.local.yaml"), { force: true });
		writeFileSync(join(root, "config", "agent.yaml"), agentYaml, "utf8");
		return root;
	}

	function expectBounded(tuning: ReturnType<typeof loadStageTuning>): void {
		for (const stage of ["CURATOR", "EDITOR"] as const) {
			expect(tuning[stage].timeoutMs).toBeGreaterThan(0);
			expect(Number.isFinite(tuning[stage].timeoutMs)).toBe(true);
			expect(tuning[stage].maxAttemptsPerModel).toBeGreaterThan(0);
		}
	}

	it("falls back to the built-in bounds on a malformed agent.yaml", () => {
		const root = configRootWithAgentYaml(": this is not valid yaml :\n\t- [\n");

		expect(() => loadStageTuning(root)).not.toThrow();
		expect(loadStageTuning(root)).toEqual(DEFAULT_STAGE_TUNING);
	});

	it("falls back when agent.yaml parses but fails validation", () => {
		const root = configRootWithAgentYaml("stages:\n  CURATOR: not-an-object\n");

		expect(loadStageTuning(root)).toEqual(DEFAULT_STAGE_TUNING);
	});

	it("falls back when the config root does not exist at all", () => {
		const absent = join(tmpdir(), `stage-tuning-absent-${String(process.hrtime.bigint())}`);

		expect(loadStageTuning(absent)).toEqual(DEFAULT_STAGE_TUNING);
	});

	/**
	 * The defect this replaces: an unreadable config yielded `undefined`, call
	 * sites spread nothing, and the stage ran with no deadline at all.
	 */
	it("still gives every stage a finite turn deadline when the config cannot be read", () => {
		const root = configRootWithAgentYaml("stages:\n  CURATOR: not-an-object\n");

		expectBounded(loadStageTuning(root));
		expectBounded(loadStageTuning(join(tmpdir(), "stage-tuning-nowhere")));
	});

	it("reads the stage block when the config is valid", () => {
		expectBounded(loadStageTuning());
	});

	/**
	 * The code default is a copy of the shipped config, and a copy drifts. An
	 * operator editing `config/agent.yaml` should not silently leave a different
	 * bound behind for the case where their own config stops loading.
	 */
	it("keeps DEFAULT_STAGE_TUNING in agreement with config/agent.yaml", () => {
		const shipped = parseYaml(readFileSync(join(PROJECT_ROOT, "config", "agent.yaml"), "utf8")) as {
			stages: unknown;
		};

		expect(shipped.stages).toEqual(DEFAULT_STAGE_TUNING);
	});
});
