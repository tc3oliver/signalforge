import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadSkillBundle,
	createSkillReferenceTool,
	renderSkillSection,
	SkillAccessError,
} from "../src/runtime/skill-access.ts";
import { loadProjectSkills } from "../src/runtime/pi-runtime.ts";
import { REPO_ROOT } from "./support/fake-agent.ts";

/**
 * `read_skill_reference` is the only filesystem read in the restricted runtime,
 * and whatever `loadSkillBundle` discovers is both advertised in the system
 * prompt and served by that tool. So discovery *is* the trust boundary: the
 * allowlist must come from a narrow rule, never from "whatever markdown happens
 * to be under this directory".
 *
 * That distinction is not theoretical here. Agent harnesses write their own
 * state into the tree they run in -- this repository already grew an
 * `agent/skills/daily-intelligence/references/.omc/` holding session notes --
 * and the earlier recursive walk would have published any `.md` among them to
 * the model as project policy. Session notes are exactly where evaluation
 * details and gold truth would appear, which AGENTS.md says must never reach
 * the agent.
 */

interface FakeSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
}

describe("skill reference discovery", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
	});

	/** A skill directory with one legitimate reference, plus whatever else is asked for. */
	function skillDir(extra: (refs: string, base: string) => void = () => {}): FakeSkill {
		const base = mkdtempSync(join(tmpdir(), "skill-access-"));
		roots.push(base);
		writeFileSync(join(base, "SKILL.md"), "---\nname: t\ndescription: d\n---\n\nbody\n", "utf8");
		const refs = join(base, "references");
		mkdirSync(refs, { recursive: true });
		writeFileSync(join(refs, "curation.md"), "real policy\n", "utf8");
		extra(refs, base);
		return { name: "t", description: "d", filePath: join(base, "SKILL.md"), baseDir: base };
	}

	function load(skill: FakeSkill) {
		return loadSkillBundle(skill as unknown as Parameters<typeof loadSkillBundle>[0]);
	}

	it("advertises the reference documents", () => {
		expect(load(skillDir()).referenceNames).toEqual(["references/curation.md"]);
	});

	it("ignores markdown a tool wrote into a dotfolder", () => {
		const skill = skillDir((refs) => {
			const omc = join(refs, ".omc");
			mkdirSync(omc, { recursive: true });
			writeFileSync(join(omc, "notepad.md"), "session notes about gold fixtures\n", "utf8");
		});
		expect(load(skill).referenceNames).toEqual(["references/curation.md"]);
	});

	it("ignores markdown elsewhere in the skill tree", () => {
		const skill = skillDir((_refs, base) => {
			const plans = join(base, "plans");
			mkdirSync(plans, { recursive: true });
			writeFileSync(join(plans, "plan.md"), "a plan\n", "utf8");
			writeFileSync(join(base, "NOTES.md"), "notes\n", "utf8");
		});
		expect(load(skill).referenceNames).toEqual(["references/curation.md"]);
	});

	it("does not descend into subdirectories of references", () => {
		const skill = skillDir((refs) => {
			const nested = join(refs, "nested");
			mkdirSync(nested, { recursive: true });
			writeFileSync(join(nested, "deep.md"), "deep\n", "utf8");
		});
		expect(load(skill).referenceNames).toEqual(["references/curation.md"]);
	});

	it("does not follow a symlink, even one pointing back inside the tree", () => {
		const skill = skillDir((refs, base) => {
			writeFileSync(join(base, "outside.md"), "outside\n", "utf8");
			symlinkSync(join(base, "outside.md"), join(refs, "linked.md"));
		});
		expect(load(skill).referenceNames).toEqual(["references/curation.md"]);
	});

	it("refuses to read a name it did not advertise", async () => {
		const skill = skillDir((refs) => {
			const omc = join(refs, ".omc");
			mkdirSync(omc, { recursive: true });
			writeFileSync(join(omc, "notepad.md"), "session notes\n", "utf8");
		});
		const tool = createSkillReferenceTool(load(skill));
		// The SDK hands execute several context arguments this assertion does not
		// exercise; only the name matters for the allowlist check.
		const execute = tool.execute as unknown as (
			id: string,
			params: { name: string },
		) => Promise<unknown>;
		await expect(execute("1", { name: "references/.omc/notepad.md" })).rejects.toThrow(
			SkillAccessError,
		);
	});

	it("fails loudly when a skill has no references at all", () => {
		const base = mkdtempSync(join(tmpdir(), "skill-access-"));
		roots.push(base);
		writeFileSync(join(base, "SKILL.md"), "---\nname: t\ndescription: d\n---\n\nbody\n", "utf8");
		expect(() => load({ name: "t", description: "d", filePath: join(base, "SKILL.md"), baseDir: base })).toThrow(
			SkillAccessError,
		);
	});
});

describe("each stage is shown its own half of the skill", () => {
	/*
	 * SKILL.md documents two roles and was inlined whole into both system
	 * prompts, so every Curator turn carried the Editor's workflow and vice
	 * versa. That is not a rounding error: measured with the gpt-4o tokenizer the
	 * document runs 1.94 characters per token because it is written in 正體中文,
	 * and the Editor half alone is ~1,200 tokens on every one of the Curator's
	 * ~47 turns a day.
	 */
	const bundle = loadSkillBundle(loadProjectSkills(join(REPO_ROOT, "agent", "skills"))[0]!);

	it("gives the curator the shared preamble and Role 1, not Role 2", () => {
		const text = renderSkillSection(bundle, "CURATOR");
		expect(text).toContain("Role 1");
		expect(text).not.toContain("Role 2");
		// The preamble, which belongs to neither role, survives.
		expect(text).toContain("references/");
	});

	it("gives the editor the shared preamble and Role 2, not Role 1", () => {
		const text = renderSkillSection(bundle, "EDITOR");
		expect(text).toContain("Role 2");
		expect(text).not.toContain("Role 1");
		expect(text).toContain("references/");
	});

	it("is materially smaller than the whole body for both roles", () => {
		const whole = renderSkillSection(bundle).length;
		expect(renderSkillSection(bundle, "CURATOR").length).toBeLessThan(whole);
		expect(renderSkillSection(bundle, "EDITOR").length).toBeLessThan(whole);
	});

	it("still advertises every reference to both roles", () => {
		// Which document answers a question is a judgement the stage makes at the
		// time; narrowing the list would trade a capability for a few dozen tokens.
		for (const role of ["CURATOR", "EDITOR"] as const) {
			const text = renderSkillSection(bundle, role);
			for (const name of bundle.referenceNames) expect(text).toContain(name);
		}
	});

	it("renders the whole body when the headings are not the two it expects", () => {
		// A skill that does not use this two-role shape must not lose its
		// instructions to a silent split.
		const odd = { ...bundle, body: "# One role only\n\nDo the thing." };
		expect(renderSkillSection(odd, "CURATOR")).toContain("Do the thing.");
		expect(renderSkillSection(odd, "EDITOR")).toContain("Do the thing.");
	});
});
