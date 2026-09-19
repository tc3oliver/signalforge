import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * Pi advertises skills lazily: `formatSkillsForPrompt` tells the model where
 * SKILL.md lives and expects it to open the file with `read` or `bash`. A
 * restricted runtime has neither, so that mechanism is inert here.
 *
 * We keep the real skill contract — skills are discovered and validated by Pi's
 * own `loadSkillsFromDir`, frontmatter and all — and replace only the transport:
 * SKILL.md (the workflow, always needed) is inlined into the system prompt, and
 * the reference files stay lazy behind one tool that can read nothing outside the
 * skill directory.
 */

export class SkillAccessError extends Error {
	override name = "SkillAccessError";
}

/** Resolve a caller-supplied path inside `root`, refusing traversal and symlink escapes. */
function resolveWithin(root: string, candidate: string): string {
	if (isAbsolute(candidate)) {
		throw new SkillAccessError(`"${candidate}" must be a name relative to the skill directory.`);
	}
	const rootReal = realpathSync(root);
	const target = realpathSync(resolve(rootReal, candidate));
	const rel = relative(rootReal, target);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
		throw new SkillAccessError(
			`"${candidate}" is outside the skill directory. Use one of the listed reference names.`,
		);
	}
	return target;
}

export interface SkillBundle {
	skill: Skill;
	/** SKILL.md body with frontmatter removed — inlined into the system prompt. */
	body: string;
	/** Reference file names relative to the skill dir, e.g. "references/novelty.md". */
	referenceNames: string[];
}

/**
 * The one directory reference documents may live in. Everything discovered here
 * is advertised to the model in the system prompt and is readable through
 * `read_skill_reference`, so discovery is deliberately narrow.
 */
const REFERENCE_DIR = "references";

export function loadSkillBundle(skill: Skill): SkillBundle {
	const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
	const referenceNames: string[] = [];

	/*
	 * One flat directory, no recursion, no dotfiles, no symlinks.
	 *
	 * This used to walk the whole skill tree for any *.md. That treats the
	 * directory's contents as the allowlist, which makes any tool that writes
	 * markdown into the tree an author of agent-visible policy: a harness
	 * dropping a `.omc/notepad.md` or a `plans/*.md` beside the references got
	 * its own session notes advertised in the system prompt and served by the
	 * read tool. `agent/skills/daily-intelligence/references/.omc/` already
	 * exists for exactly that reason and was non-markdown only by luck, and the
	 * content such a file carries -- plans, evaluation notes, gold fixtures --
	 * is precisely what must never reach the agent.
	 *
	 * `resolveWithin` is not the defence against this: such a file is genuinely
	 * inside the root, so it would be served legitimately. The allowlist has to
	 * be narrow at discovery time.
	 */
	const referenceRoot = resolve(skill.baseDir, REFERENCE_DIR);
	let entries: string[];
	try {
		entries = readdirSync(referenceRoot);
	} catch {
		entries = [];
	}
	for (const entry of entries.sort()) {
		if (entry.startsWith(".")) continue;
		if (!entry.endsWith(".md")) continue;
		const full = resolve(referenceRoot, entry);
		// lstat, not stat: a symlink must not be followed into the tree even if
		// its target happens to resolve back inside the skill directory.
		if (!lstatSync(full).isFile()) continue;
		if (full === resolve(skill.filePath)) continue;
		referenceNames.push(`${REFERENCE_DIR}/${entry}`);
	}

	if (referenceNames.length === 0) {
		throw new SkillAccessError(
			`Skill "${skill.name}" has no reference files under ${referenceRoot}`,
		);
	}
	return { skill, body, referenceNames };
}

/**
 * The one tool that touches the filesystem. Its root is the skill directory and
 * nothing else, so it cannot be turned into a general file reader.
 */
export function createSkillReferenceTool(bundle: SkillBundle): ToolDefinition {
	const allowed = new Set(bundle.referenceNames);
	return defineTool({
		name: "read_skill_reference",
		label: "Read skill reference",
		description: `Load one of the daily-intelligence skill reference documents for detailed policy. Available: ${bundle.referenceNames.join(", ")}. Read the ones relevant to the decision in front of you before making judgement calls.`,
		promptSnippet: "read_skill_reference: load detailed policy for a decision",
		parameters: Type.Object({
			name: Type.String({ minLength: 1 }),
		}),
		execute: async (_id, params) => {
			if (!allowed.has(params.name)) {
				throw new SkillAccessError(
					`Unknown reference "${params.name}". Available: ${bundle.referenceNames.join(", ")}`,
				);
			}
			const path = resolveWithin(bundle.skill.baseDir, params.name);
			return {
				content: [{ type: "text" as const, text: readFileSync(path, "utf8") }],
				details: {},
			};
		},
	});
}

/** Which role's half of the skill body a stage is shown. */
export type SkillRole = "CURATOR" | "EDITOR";

/**
 * The stage's own half of the skill body, plus everything before both halves.
 *
 * SKILL.md documents two roles under `## Role 1 — Curator` and `## Role 2 —
 * Editor`, and it was inlined whole into both system prompts -- so every
 * Curator turn carried the Editor's workflow and every Editor turn carried the
 * Curator's. That is not a rounding error: measured with the gpt-4o tokenizer,
 * the document is 1.94 characters per token because it is written in 正體中文,
 * and the Editor half alone is 1,197 tokens on every one of the Curator's ~47
 * turns a day.
 *
 * Only the body is split. Every reference stays readable by both roles through
 * `read_skill_reference`, because which document answers a question is a
 * judgement the stage makes at the time, and narrowing it to save a listing
 * would trade a real capability for a few dozen tokens.
 */
function roleBody(body: string, role: SkillRole): string {
	const lines = body.split("\n");
	const headings = lines
		.map((line, i) => ({ line, i }))
		.filter(({ line }) => /^##\s+Role\s+\d/.test(line));
	// No role headings, or not the two this expects: render what is there rather
	// than silently dropping the instructions.
	if (headings.length !== 2) return body;
	const first = headings[0]!.i;
	const second = headings[1]!.i;
	const shared = lines.slice(0, first);
	const own = role === "CURATOR" ? lines.slice(first, second) : lines.slice(second);
	return [...shared, ...own].join("\n").trimEnd();
}

/** The skill section injected into the system prompt, replacing Pi's read-tool advertisement. */
export function renderSkillSection(bundle: SkillBundle, role?: SkillRole): string {
	return [
		"<skill>",
		`<name>${bundle.skill.name}</name>`,
		`<description>${bundle.skill.description}</description>`,
		"",
		role ? roleBody(bundle.body, role) : bundle.body,
		"",
		"<references>",
		"Load any of these with read_skill_reference when you need the detailed policy:",
		...bundle.referenceNames.map((n) => `- ${n}`),
		"</references>",
		"</skill>",
	].join("\n");
}
