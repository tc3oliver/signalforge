import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GoldTruth } from "../src/schemas/gold.ts";
import { DailyManifest } from "../src/schemas/manifest.ts";

const ROOT = join(import.meta.dirname, "..");
const SKILL_DIR = join(ROOT, "agent", "skills", "daily-intelligence");
const REF_DIR = join(SKILL_DIR, "references");
const DATES = ["2026-09-10", "2026-09-11", "2026-09-12"];

function ref(name: string): string {
	return readFileSync(join(REF_DIR, name), "utf8");
}

/**
 * The two Phase 1.1 gate failures were policy gaps, not code defects: the model was
 * never told that trend evidence is not automatically publishable, nor that causation
 * is not identity. These assertions pin the corrected rules into place so a later
 * edit cannot quietly drop them and re-open the same failure.
 */
describe("editorial policy: trend evidence is not automatically publishable", () => {
	const doc = ref("editorial-policy.md");

	it("states the non-qualification rule", () => {
		expect(doc).toContain("Standalone Value Test");
		expect(doc).toMatch(/不因此自動具備獨立刊登資格/);
		expect(doc).toMatch(/supporting evidence|支撐證據/);
	});

	it("frames standalone publication as the exception requiring justification", () => {
		expect(doc).toMatch(/只有在[^。]*不依賴[^。]*aggregate|不依賴那條 aggregate trend/);
	});

	it("poses the counterfactual question the test is named after", () => {
		expect(doc).toMatch(/如果[^。]*(signal|訊號)[^。]*不存在/);
	});

	it("carries a worked example", () => {
		const idx = doc.indexOf("Worked example");
		expect(idx).toBeGreaterThan(-1);
		expect(doc.slice(idx).length).toBeGreaterThan(400);
	});
});

describe("emerging signals: constituents are evidence, not final stories", () => {
	const doc = ref("emerging-signals.md");

	it("says signal storyIds need not become brief stories", () => {
		expect(doc).toMatch(/不代表它們每一則都要成為 brief 的 final story/);
	});

	it("cross-references the Standalone Value Test rather than restating it", () => {
		expect(doc).toContain("Standalone Value Test");
		expect(doc).toContain("editorial-policy.md");
	});
});

describe("deduplication: the three relationship kinds", () => {
	const doc = ref("deduplication.md");

	it("names SAME_EVENT / RELATED_EVENT / BACKGROUND_CONTEXT explicitly", () => {
		for (const kind of ["SAME_EVENT", "RELATED_EVENT", "BACKGROUND_CONTEXT"]) {
			expect(doc).toContain(kind);
		}
	});

	it("states that causation does not imply event identity", () => {
		expect(doc).toMatch(/因果關係不等於事件同一性/);
		expect(doc).toMatch(/不會讓 A 和 B 變成同一件事/);
	});

	it("lists all six identity dimensions before a merge", () => {
		for (const axis of [
			"Principal Actor",
			"Core Action",
			"Object / Subject",
			"Decision or occurrence",
			"Time",
			"Primary Source",
		]) {
			expect(doc).toContain(axis);
		}
	});

	it("poses the five Event Identity Test questions", () => {
		const idx = doc.indexOf("Event Identity Test");
		expect(idx).toBeGreaterThan(-1);
		const section = doc.slice(idx, idx + 2000);
		for (const n of ["1.", "2.", "3.", "4.", "5."]) expect(section).toContain(n);
	});

	it("enumerates the four insufficient reasons to merge", () => {
		const idx = doc.indexOf("不要僅僅因為");
		expect(idx).toBeGreaterThan(-1);
		const section = doc.slice(idx, idx + 400);
		expect(section).toMatch(/造成/);
		expect(section).toMatch(/回應/);
		expect(section).toMatch(/敘事線/);
		expect(section).toMatch(/新聞週期/);
	});

	it("carries a worked example for each of the three kinds", () => {
		const idx = doc.indexOf("Worked examples");
		expect(idx).toBeGreaterThan(-1);
		const section = doc.slice(idx);
		expect(section).toContain("SAME_EVENT");
		expect(section).toContain("RELATED_EVENT");
		expect(section).toContain("BACKGROUND_CONTEXT");
	});
});

describe("story clustering: the correction must not become never-merge", () => {
	const doc = ref("story-clustering.md");

	it("gates merging on the Event Identity Test", () => {
		expect(doc).toContain("Event Identity Test");
		expect(doc).toContain("deduplication.md");
	});

	it("keeps an explicit anti-over-splitting guard", () => {
		expect(doc).toMatch(/不要矯枉過正/);
		expect(doc).toMatch(/\*\*仍然必須\*\*併成一則/);
	});

	it("names the symptoms of both failure directions", () => {
		expect(doc).toMatch(/過度合併/);
		expect(doc).toMatch(/過度拆分/);
	});
});

describe("SKILL.md routes both roles into the new rules", () => {
	const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");

	it("tells the curator to classify the relationship before merging", () => {
		expect(skill).toContain("Event Identity Test");
		expect(skill).toContain("SAME_EVENT");
	});

	it("tells the editor to decide signals before final stories", () => {
		expect(skill).toContain("Standalone Value Test");
		expect(skill).toMatch(/先決定 `emergingSignals`,再決定 final stories/);
	});

	it("stays a workflow document rather than absorbing the references", () => {
		// SKILL.md is inlined into every system prompt; the references are lazy.
		expect(skill.split("\n").length).toBeLessThan(160);
	});
});

/**
 * The policy must generalise. A rule that only works because it names an entity from
 * the evaluation fixture would pass the gates without teaching the model anything, so
 * the skill is checked against the actual fixture and gold vocabulary.
 */
describe("policy documents do not encode fixture answers", () => {
	const docs = readdirSync(REF_DIR)
		.filter((f) => f.endsWith(".md"))
		.map((f) => [f, ref(f)] as const)
		.concat([["SKILL.md", readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8")]]);

	const goldEventIds: string[] = [];
	const goldTitles: string[] = [];
	const itemIds: string[] = [];
	const manifestTitles: string[] = [];

	for (const date of DATES) {
		const gold = GoldTruth.parse(
			JSON.parse(readFileSync(join(ROOT, "eval", "gold", `${date}.json`), "utf8")),
		);
		for (const e of gold.events) {
			goldEventIds.push(e.eventId);
			goldTitles.push(e.canonicalTitle);
		}
		const manifest = DailyManifest.parse(
			JSON.parse(
				readFileSync(join(ROOT, "fixtures", "generated", date, "manifest.json"), "utf8"),
			),
		);
		for (const item of manifest.items) {
			itemIds.push(item.id);
			manifestTitles.push(item.title);
		}
	}

	it("has a non-trivial vocabulary to check against", () => {
		expect(goldEventIds.length).toBeGreaterThanOrEqual(50);
		expect(itemIds.length).toBeGreaterThan(200);
	});

	it("mentions no gold eventId and no fixture itemId", () => {
		for (const [name, doc] of docs) {
			for (const id of goldEventIds) expect(doc, `${name} leaks ${id}`).not.toContain(id);
			for (const id of itemIds) expect(doc, `${name} leaks ${id}`).not.toContain(id);
		}
	});

	it("reproduces no gold canonical title and no fixture item title", () => {
		for (const [name, doc] of docs) {
			for (const t of [...goldTitles, ...manifestTitles]) {
				if (t.length < 12) continue;
				expect(doc, `${name} reproduces "${t}"`).not.toContain(t);
			}
		}
	});

	/**
	 * Distinctive proper nouns invented by the fixture generator. Any of these in the
	 * skill would mean the policy was tuned to the answer key rather than generalised.
	 */
	it("names no entity invented by the fixture world", () => {
		const entities = new Set<string>();
		for (const t of [...goldTitles, ...manifestTitles]) {
			for (const word of t.match(/\b[A-Z][A-Za-z0-9]{3,}\b/g) ?? []) entities.add(word);
		}
		expect(entities.size).toBeGreaterThan(20);
		// Generic technical vocabulary the policy is entitled to use.
		const allowed = new Set([
			"GitHub", "HackerNews", "Reddit", "YouTube", "OpenAI", "Anthropic", "Claude",
			"Meta", "Llama", "Redis", "HuggingFace", "OpenSSL", "Show", "Introducing",
			"Scout", "Finally", "This", "The", "API", "JSON", "SSPL",
			// The six event-identity axes are mandated policy vocabulary.
			"Principal", "Actor", "Core", "Action", "Object", "Subject",
			"Decision", "Time", "Primary", "Source",
			// The project's own vocabulary.
			"Daily", "Intelligence", "Curator", "Editor", "Story", "Signal",
		]);
		for (const [name, doc] of docs) {
			for (const entity of entities) {
				if (allowed.has(entity)) continue;
				// Whole-word only: the fixture's "Final..." must not flag an unrelated "Finally".
				const whole = new RegExp(`\\b${entity}\\b`);
				expect(whole.test(doc), `${name} names fixture entity "${entity}"`).toBe(false);
			}
		}
	});
});
