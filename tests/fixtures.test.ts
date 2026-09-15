import { describe, expect, it } from "vitest";
import { DailyManifest, GoldTruth } from "../src/schemas/index.ts";
import { DATES } from "../src/fixtures/scenarios.ts";
import { generateAll } from "../src/fixtures/generator.ts";

const SEED = 4242;
const days = generateAll(SEED);

/** Field names that would leak gold truth into the agent-visible manifest. */
const FORBIDDEN_KEYS = [
	"goldEventId",
	"expectedImportance",
	"expectedImportant",
	"expectedTier",
	"expectedChangeType",
	"expectedSection",
	"expectedCluster",
	"isNoise",
	"noiseItemIds",
	"primaryItemIds",
	"eventId",
	"canonicalTitle",
	"sortKey",
	"eventKey",
	"isPrimary",
];

describe("synthetic fixtures", () => {
	it("covers the three required dates", () => {
		expect(days.map((d) => d.date)).toEqual([...DATES]);
	});

	it("produces manifests that parse against the strict schema", () => {
		for (const day of days) {
			expect(() => DailyManifest.parse(day.manifest)).not.toThrow();
			expect(() => GoldTruth.parse(day.gold)).not.toThrow();
		}
	});

	it("produces 70-100 items per day and at least 210 in total", () => {
		let total = 0;
		for (const day of days) {
			expect(day.manifest.items.length).toBeGreaterThanOrEqual(70);
			expect(day.manifest.items.length).toBeLessThanOrEqual(100);
			total += day.manifest.items.length;
		}
		expect(total).toBeGreaterThanOrEqual(210);
	});

	it("is deterministic for a given seed", () => {
		expect(generateAll(SEED)).toEqual(generateAll(SEED));
	});

	it("changes output when the seed changes", () => {
		expect(generateAll(SEED)).not.toEqual(generateAll(SEED + 1));
	});

	it("never leaks a gold field name into the manifest", () => {
		for (const day of days) {
			const serialized = JSON.stringify(day.manifest);
			for (const key of FORBIDDEN_KEYS) {
				expect(serialized, `${day.date} leaked ${key}`).not.toContain(key);
			}
		}
	});

	it("never leaks a gold eventId substring into the manifest", () => {
		for (const day of days) {
			const serialized = JSON.stringify(day.manifest);
			for (const event of day.gold.events) {
				expect(serialized, `${day.date} leaked ${event.eventId}`).not.toContain(event.eventId);
			}
		}
	});

	it("never leaks a canonical gold title into the manifest", () => {
		for (const day of days) {
			const titles = new Set(day.manifest.items.map((i) => i.title));
			for (const event of day.gold.events) {
				expect(titles.has(event.canonicalTitle)).toBe(false);
			}
		}
	});

	it("references only real item ids from gold truth", () => {
		for (const day of days) {
			const ids = new Set(day.manifest.items.map((i) => i.id));
			for (const event of day.gold.events) {
				for (const id of [...event.itemIds, ...event.primaryItemIds]) {
					expect(ids.has(id), `${day.date} ${event.eventId} -> ${id}`).toBe(true);
				}
				for (const id of event.primaryItemIds) {
					expect(event.itemIds).toContain(id);
				}
			}
			for (const id of day.gold.noiseItemIds) {
				expect(ids.has(id), `${day.date} noise -> ${id}`).toBe(true);
			}
		}
	});

	it("keeps gold events and noise disjoint", () => {
		for (const day of days) {
			const noise = new Set(day.gold.noiseItemIds);
			for (const event of day.gold.events) {
				for (const id of event.itemIds) {
					expect(noise.has(id), `${day.date} ${id} is both event and noise`).toBe(false);
				}
			}
		}
	});

	it("references only real item ids from structured facts", () => {
		for (const day of days) {
			const ids = new Set(day.manifest.items.map((i) => i.id));
			expect(day.manifest.facts.length).toBeGreaterThanOrEqual(8);
			for (const fact of day.manifest.facts) {
				expect(ids.has(fact.sourceItemId), `${day.date} fact ${fact.factId}`).toBe(true);
			}
			const kinds = new Set(day.manifest.facts.map((f) => f.kind));
			expect(kinds).toEqual(new Set(["crypto", "macro", "filing"]));
		}
	});

	it("uses unique item ids within and across days", () => {
		const seen = new Set<string>();
		for (const day of days) {
			const ids = day.manifest.items.map((i) => i.id);
			expect(new Set(ids).size).toBe(ids.length);
			for (const id of ids) {
				expect(seen.has(id), `duplicate id ${id}`).toBe(false);
				seen.add(id);
			}
		}
	});

	it("uses unique fact ids and gold event ids", () => {
		for (const day of days) {
			const factIds = day.manifest.facts.map((f) => f.factId);
			expect(new Set(factIds).size).toBe(factIds.length);
			const eventIds = day.gold.events.map((e) => e.eventId);
			expect(new Set(eventIds).size).toBe(eventIds.length);
		}
	});

	it("has 9-13 important events per day", () => {
		for (const day of days) {
			const important = day.gold.events.filter((e) => e.expectedImportant).length;
			expect(important, `${day.date} important=${important}`).toBeGreaterThanOrEqual(9);
			expect(important).toBeLessThanOrEqual(13);
		}
	});

	it("spans at least three source types for every multi-source event", () => {
		for (const day of days) {
			const byId = new Map(day.manifest.items.map((i) => [i.id, i]));
			for (const event of day.gold.events) {
				if (event.itemIds.length < 3) continue;
				const types = new Set(event.itemIds.map((id) => byId.get(id)?.sourceType));
				expect(types.size, `${day.date} ${event.eventId} types=${[...types].join(",")}`).toBeGreaterThanOrEqual(3);
			}
		}
	});

	it("gives every important event 3-6 items", () => {
		for (const day of days) {
			for (const event of day.gold.events.filter((e) => e.expectedImportant)) {
				expect(event.itemIds.length, `${day.date} ${event.eventId}`).toBeGreaterThanOrEqual(3);
				expect(event.itemIds.length).toBeLessThanOrEqual(6);
			}
		}
	});

	it("does not make an event's items near-identical in title", () => {
		for (const day of days) {
			const byId = new Map(day.manifest.items.map((i) => [i.id, i]));
			for (const event of day.gold.events) {
				const titles = event.itemIds.map((id) => byId.get(id)?.title ?? "");
				expect(new Set(titles).size).toBe(titles.length);
				for (let i = 0; i < titles.length; i += 1) {
					for (let j = i + 1; j < titles.length; j += 1) {
						expect(
							jaccard(titles[i] ?? "", titles[j] ?? ""),
							`${day.date} ${event.eventId}: "${titles[i]}" vs "${titles[j]}"`,
						).toBeLessThan(0.6);
					}
				}
			}
		}
	});

	it("keeps noise between 25% and 35% of each day", () => {
		for (const day of days) {
			const ratio = day.gold.noiseItemIds.length / day.manifest.items.length;
			expect(ratio, `${day.date} ratio=${ratio}`).toBeGreaterThanOrEqual(0.25);
			expect(ratio).toBeLessThanOrEqual(0.35);
		}
	});

	it("declares an emerging signal per day whose events exist", () => {
		for (const day of days) {
			expect(day.gold.expectedEmergingSignals.length).toBeGreaterThanOrEqual(1);
			const eventIds = new Set(day.gold.events.map((e) => e.eventId));
			for (const signal of day.gold.expectedEmergingSignals) {
				expect(signal.eventIds.length).toBeGreaterThanOrEqual(1);
				for (const id of signal.eventIds) {
					expect(eventIds.has(id), `${day.date} signal -> ${id}`).toBe(true);
				}
			}
		}
	});

	it("covers the declared cross-day arcs", () => {
		const keysFor = (date: string) =>
			days
				.find((d) => d.date === date)
				?.gold.events.map((e) => e.eventId)
				.join("|") ?? "";
		expect(keysFor("2026-09-10")).toContain("arc-model-rumor-d1");
		expect(keysFor("2026-09-11")).toContain("arc-model-rumor-d2");
		expect(keysFor("2026-09-12")).toContain("arc-model-rumor-d3");
		expect(keysFor("2026-09-10")).toContain("arc-gh-regression-d1");
		expect(keysFor("2026-09-11")).toContain("arc-gh-regression-d2");
		expect(keysFor("2026-09-12")).toContain("arc-gh-regression-d3");
		expect(keysFor("2026-09-11")).toContain("arc-release-d2");
		expect(keysFor("2026-09-12")).toContain("arc-release-d3");
		expect(keysFor("2026-09-11")).toContain("arc-paper-d2");
		expect(keysFor("2026-09-12")).toContain("arc-paper-d3");
		expect(keysFor("2026-09-11")).toContain("arc-conflict-d2");
		expect(keysFor("2026-09-12")).toContain("arc-conflict-d3");
		expect(keysFor("2026-09-12")).toContain("arc-macro-cpi-d3");
		expect(keysFor("2026-09-11")).toContain("arc-filing-d2");
		for (const date of DATES) expect(keysFor(date)).toContain("arc-community-rumor");
	});

	it("assigns the expected change types along the model-rumor arc", () => {
		const change = (date: string, key: string) =>
			days
				.find((d) => d.date === date)
				?.gold.events.find((e) => e.eventId.endsWith(key))?.expectedChangeType;
		expect(change("2026-09-10", "arc-model-rumor-d1")).toBe("RUMOR");
		expect(change("2026-09-11", "arc-model-rumor-d2")).toBe("NO_MATERIAL_CHANGE");
		expect(change("2026-09-12", "arc-model-rumor-d3")).toBe("CONFIRMATION");
		expect(change("2026-09-10", "arc-gh-regression-d1")).toBe("NEW");
		expect(change("2026-09-11", "arc-gh-regression-d2")).toBe("ESCALATION");
		expect(change("2026-09-12", "arc-gh-regression-d3")).toBe("RESOLUTION");
		expect(change("2026-09-12", "arc-conflict-d3")).toBe("REVERSAL");
		expect(change("2026-09-12", "arc-paper-d3")).toBe("UPDATE");
	});

	it("orders items chronologically within a day", () => {
		for (const day of days) {
			const stamps = day.manifest.items.map((i) => i.publishedAt);
			expect([...stamps].sort()).toEqual(stamps);
			for (const stamp of stamps) expect(stamp.startsWith(day.date)).toBe(true);
		}
	});
});

function jaccard(a: string, b: string): number {
	const tok = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
	const sa = tok(a);
	const sb = tok(b);
	if (sa.size === 0 || sb.size === 0) return 0;
	let shared = 0;
	for (const w of sa) if (sb.has(w)) shared += 1;
	return shared / (sa.size + sb.size - shared);
}

/*
 * The leak guards above check gold *field names*, eventId substrings and
 * canonical titles. None of them looks at prose, and prose is where the leak
 * actually was: the generator gave official/sec/fred items -- exactly the roles
 * gold names in `primaryItemIds` -- a closing sentence calling the document "the
 * authoritative record for this item", and gave every `expectedImportant: false`
 * event an impact sentence stating that verdict in editorial language. Measured
 * against the committed gold, a regex for either recovered half its class with
 * ZERO false positives. `selected_story_precision` and `important_story_recall`
 * are scored against those two fields, so half of each was solvable by string
 * match rather than judgement.
 *
 * The guard is a vocabulary list rather than a statistical precision test, and
 * that is deliberate. A pure "no phrase may predict gold membership" test would
 * fire on legitimate signal: "Filing text from EDGAR" appears only on sec items,
 * and sec items really are primary sources. Channel identity correlating with
 * gold is the fixture being realistic. What must never appear is the system's
 * own vocabulary for the answer, or a sentence that states the conclusion a
 * curator is supposed to reach.
 */
const FORBIDDEN_PHRASES = [
	// The evaluator's and the ledger's own terms.
	"primary source",
	"primary artifact",
	"authoritative record",
	"the ledger",
	"change type",
	"changetype",
	"material change",
	"no material change",
	"emerging signal",
	"scan coverage",
	// Verdict language: stating the conclusion instead of the evidence for it.
	"nothing has changed",
	"no new information",
	"not informative",
	"not actionable",
	"should not advance",
	"is not important",
	"is not newsworthy",
	/*
	 * Anything that would tell a model it is being graded. Deliberately narrow:
	 * "benchmark", "score", "metric" and "threshold" are ordinary words in
	 * technology and economics reporting -- one generated item legitimately
	 * discusses "the revised density threshold" -- so banning them would be
	 * banning realism. Only phrasings that make no sense except as grading are
	 * listed.
	 */
	"gold truth",
	"the correct answer",
	"expected important",
	"being graded",
	"acceptance harness",
];

describe("fixture prose does not carry the answer", () => {
	it("never uses the system's own verdict vocabulary in item text", () => {
		for (const day of days) {
			for (const item of day.manifest.items) {
				const text = `${item.title} ${item.summary} ${item.content ?? ""}`.toLowerCase();
				for (const phrase of FORBIDDEN_PHRASES) {
					expect(text, `${day.date} ${item.id} contains "${phrase}"`).not.toContain(phrase);
				}
			}
		}
	});

	it("closes every item the same way, so the closing carries no role", () => {
		/*
		 * The specific regression: the closing branched on role, and the roles it
		 * singled out (official, sec, fred) are the ones gold names in
		 * primaryItemIds -- so the sentence identified the primary sources exactly.
		 * Asserting one shared closing is what makes that unrepeatable; the org
		 * name inside it varies per event and carries nothing about primacy.
		 */
		const CLOSING = /and the affected downstream projects respond\.$/;
		for (const day of days) {
			const primary = new Set(day.gold.events.flatMap((e) => e.primaryItemIds));
			let checkedPrimary = 0;
			for (const item of day.manifest.items) {
				if (!item.content) continue;
				expect(item.content.trim(), `${day.date} ${item.id}`).toMatch(CLOSING);
				if (primary.has(item.id)) checkedPrimary++;
			}
			// The assertion is only worth anything if primary items were in scope.
			expect(checkedPrimary, `${day.date} had no primary item with content`).toBeGreaterThan(0);
		}
	});

	it("does not label the unimportant events as unimportant", () => {
		// Each of these six events used to carry its own verdict in `impact`.
		for (const day of days) {
			const unimportant = new Set(
				day.gold.events.filter((e) => !e.expectedImportant).flatMap((e) => e.itemIds),
			);
			expect(unimportant.size).toBeGreaterThan(0);
			for (const item of day.manifest.items) {
				if (!unimportant.has(item.id)) continue;
				const text = `${item.title} ${item.summary} ${item.content ?? ""}`.toLowerCase();
				for (const phrase of ["nothing has changed", "no new information", "not informative", "not actionable"]) {
					expect(text, `${day.date} ${item.id} states its own verdict`).not.toContain(phrase);
				}
			}
		}
	});
});
