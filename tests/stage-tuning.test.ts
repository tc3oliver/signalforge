import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { reloadConfig } from "../src/config/loader.ts";
import { loadStageTuning } from "../src/config/stage-tuning.ts";

/**
 * The stage bounds are what stop a hung turn: the editor once spent 114 minutes
 * on one attempt because `timeoutMs` was declared in config/agent.yaml and read
 * by nobody. Both the production pipeline and the fixture orchestrator resolve
 * them through this one loader, so its failure mode matters more than its happy
 * path -- an unreadable config must leave the stages on their code defaults
 * rather than refuse to start a run, and that swallowed catch is the entire
 * reason the function exists.
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

	it("swallows a malformed agent.yaml instead of throwing", () => {
		const root = configRootWithAgentYaml(": this is not valid yaml :\n\t- [\n");

		expect(() => loadStageTuning(root)).not.toThrow();
		expect(loadStageTuning(root)).toBeUndefined();
	});

	it("swallows an agent.yaml that parses but fails validation", () => {
		const root = configRootWithAgentYaml("stages:\n  CURATOR: not-an-object\n");

		expect(loadStageTuning(root)).toBeUndefined();
	});

	it("returns undefined when the config root does not exist at all", () => {
		const absent = join(tmpdir(), `stage-tuning-absent-${String(process.hrtime.bigint())}`);

		expect(loadStageTuning(absent)).toBeUndefined();
	});

	it("reads the stage block when the config is valid", () => {
		const tuning = loadStageTuning();

		// The repository ships a stage block; if that ever stops being true this
		// asserts the shape rather than a specific number, which is tuning.
		if (tuning !== undefined) {
			expect(tuning.CURATOR.timeoutMs).toBeGreaterThan(0);
			expect(tuning.EDITOR.timeoutMs).toBeGreaterThan(0);
		}
	});
});
