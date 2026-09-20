import { describe, expect, it } from "vitest";
import type { BriefAppearance } from "../src/db/briefs.ts";
import type { StoryLedgerEntry } from "../src/schemas/index.ts";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
	resolveDisplayTitles,
	storyDisplayDescription,
	storyDisplayTitle,
	timelineDisplayTitle,
} from "../web/lib/story-title.ts";

/*
 * The defect these cover, observed on production on 2026-09-20: the story page
 * for `us-military-ai-hallucination-aborted-china-operation` rendered its <h1>,
 * its <title> and its share card as "AI-hallucinated intelligence nearly
 * triggered a US operation against China" -- the curator's internal handle --
 * while every brief that published it, and the dashboard link the reader
 * followed to get there, read "AI 幻覺情報險觸發美軍對中行動".
 */

function appearance(over: Partial<BriefAppearance> = {}): BriefAppearance {
	return {
		date: "2026-09-20",
		section: "AI_LLM",
		mustKnow: true,
		title: "AI 幻覺情報險觸發美軍對中行動",
		whatHappened: "未標示不確定性的模型輸出進入正式決策流程，險些觸發行動。",
		whyItMatters: "這不是一般回答錯誤。",
		whatChanged: "首次公開。",
		impact: "決策鏈需要獨立驗證。",
		confidence: "HIGH",
		sourceItemIds: ["itm-1"],
		factRefs: [],
		...over,
	};
}

const LEDGER = {
	canonicalTitle: "AI-hallucinated intelligence nearly triggered a US operation against China",
	reason: "Cluster kept: model output reached a decision chain without an uncertainty marker.",
} satisfies Pick<StoryLedgerEntry, "canonicalTitle" | "reason">;

describe("storyDisplayTitle", () => {
	it("prefers the published editorial title over the ledger handle", () => {
		expect(storyDisplayTitle([appearance()], LEDGER)).toBe("AI 幻覺情報險觸發美軍對中行動");
	});

	it("uses the newest appearance when the framing changed across days", () => {
		// briefAppearancesForStory orders by date desc, so [0] is the newest.
		const newest = appearance({ date: "2026-09-20", title: "第四天的說法" });
		const oldest = appearance({ date: "2026-09-17", title: "第一天的說法" });
		expect(storyDisplayTitle([newest, oldest], LEDGER)).toBe("第四天的說法");
	});

	it("falls back to the ledger handle for a story no brief ever published", () => {
		expect(storyDisplayTitle([], LEDGER)).toBe(LEDGER.canonicalTitle);
	});
});

describe("storyDisplayDescription", () => {
	it("prefers the brief's account of the event over the curator's note", () => {
		expect(storyDisplayDescription([appearance()], LEDGER)).toBe(
			"未標示不確定性的模型輸出進入正式決策流程，險些觸發行動。",
		);
	});

	it("falls back to the ledger reason when the story was never published", () => {
		expect(storyDisplayDescription([], LEDGER)).toBe(LEDGER.reason);
	});
});

describe("timelineDisplayTitle", () => {
	it("shows how each day was published, not how the story reads now", () => {
		const dayOne = appearance({ date: "2026-09-17", title: "第一天的說法" });
		expect(timelineDisplayTitle(dayOne, LEDGER)).toBe("第一天的說法");
	});

	it("keeps the ledger handle for a day the story was tracked but not published", () => {
		expect(timelineDisplayTitle(undefined, LEDGER)).toBe(LEDGER.canonicalTitle);
	});
});

describe("identity is not presentation", () => {
	it("never lets a display title stand in for the id a URL is built from", async () => {
		const source = await import("node:fs/promises").then((fs) =>
			fs.readFile(new URL("../web/app/story/[id]/page.tsx", import.meta.url), "utf8"),
		);
		// The canonical URL and every story link must be built from the id.
		expect(source).toContain("canonical: `/story/${encodeURIComponent(storyId)}`");
		expect(source).toContain("href={`/story/${encodeURIComponent(entry.storyId)}`}");
		// And the raw ledger handle must no longer be rendered as the page heading.
		expect(source).not.toContain("<h1>{latest.canonicalTitle}</h1>");
	});
});

describe("resolveDisplayTitles", () => {
	const ledger = new Map([
		["published-story", "Published story, English handle"],
		["tracked-but-unpublished", "Tracked but never published"],
	]);
	const published = new Map([["published-story", "已發布的中文標題"]]);

	it("prefers the published wording", () => {
		const out = resolveDisplayTitles(["published-story"], published, ledger);
		expect(out.get("published-story")).toBe("已發布的中文標題");
	});

	it("keeps a real story that no brief published, rather than dropping it", () => {
		// The /signals page flags an absent title as a dangling reference. A story
		// the curator tracked but never published is not dangling, and must not be
		// reported as one.
		const out = resolveDisplayTitles(["tracked-but-unpublished"], published, ledger);
		expect(out.get("tracked-but-unpublished")).toBe("Tracked but never published");
	});

	it("omits an id that exists in neither, which is a genuine broken reference", () => {
		const out = resolveDisplayTitles(["ghost-story"], published, ledger);
		expect(out.has("ghost-story")).toBe(false);
	});
});

describe("no reader-facing page reads the ledger handle directly", () => {
	/*
	 * The leak this guards against is subtle: `canonicalTitle` is a legitimate
	 * field that identity code must keep using, so it cannot simply be banned.
	 * What must not happen is a reader-facing route rendering it without going
	 * through the display helpers.
	 *
	 * `web/lib/trace.ts` is exempt and stays exempt: it builds the admin item
	 * trace, where naming the ledger entry is the point.
	 */
	const EXEMPT = new Set(["lib/story-title.ts", "lib/trace.ts", "scripts/seed-dev.ts"]);

	async function walk(dir: string, root: string): Promise<string[]> {
		const out: string[] = [];
		for (const e of await readdir(dir, { withFileTypes: true })) {
			if (e.name === "node_modules" || e.name === ".next") continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) out.push(...(await walk(full, root)));
			else if (/\.tsx?$/.test(e.name)) out.push(full);
		}
		return out;
	}

	it("uses a display helper wherever a story title reaches a reader", async () => {
		const root = new URL("../web/", import.meta.url).pathname;
		const files = await walk(root, root);
		expect(files.length).toBeGreaterThan(10);
		const offenders: string[] = [];
		for (const file of files) {
			const rel = relative(root, file);
			if (EXEMPT.has(rel)) continue;
			const source = await readFile(file, "utf8");
			for (const line of source.split("\n")) {
				if (!line.includes("canonicalTitle")) continue;
				// A fallback inside JSX is allowed only as the tail of a `??` chain
				// whose head is a display lookup.
				if (/\?\?\s*[a-zA-Z.]*canonicalTitle/.test(line)) continue;
				offenders.push(`${rel}: ${line.trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("the ledger title lookup cannot reach a reader unresolved", () => {
	/*
	 * How /signals leaked despite the guard above: it never wrote
	 * `canonicalTitle` at all. It called `latestStoryTitles`, whose rows ARE
	 * ledger handles, and rendered the map. The name of the field never appeared,
	 * so a text search for it found nothing.
	 *
	 * `latestStoryTitles` is still the right query for the integrity half of that
	 * page -- it answers "does this story exist" -- so it stays. What must hold is
	 * that nothing hands its output straight to a page.
	 */
	it("is only called in the query layer, and always paired with the published lookup", async () => {
		const root = new URL("../web/", import.meta.url).pathname;
		const callers: string[] = [];
		async function walk(dir: string): Promise<void> {
			for (const e of await readdir(dir, { withFileTypes: true })) {
				if (e.name === "node_modules" || e.name === ".next") continue;
				const full = join(dir, e.name);
				if (e.isDirectory()) await walk(full);
				else if (/\.tsx?$/.test(e.name)) {
					const src = await readFile(full, "utf8");
					if (src.includes("latestStoryTitles")) callers.push(relative(root, full));
				}
			}
		}
		await walk(root);
		expect(callers).toEqual(["lib/queries.ts"]);

		const queries = await readFile(join(root, "lib/queries.ts"), "utf8");
		// Every use of the ledger lookup must be resolved against the published one.
		expect(queries).toContain("publishedStoryTitles");
		expect(queries).toContain("resolveDisplayTitles");
	});

	it("no app route renders a raw title map from the ledger", async () => {
		const appDir = new URL("../web/app/", import.meta.url).pathname;
		const offenders: string[] = [];
		async function walk(dir: string): Promise<void> {
			for (const e of await readdir(dir, { withFileTypes: true })) {
				if (e.name === ".next") continue;
				const full = join(dir, e.name);
				if (e.isDirectory()) await walk(full);
				else if (/\.tsx?$/.test(e.name)) {
					const src = await readFile(full, "utf8");
					if (src.includes("latestStoryTitles")) offenders.push(relative(appDir, full));
				}
			}
		}
		await walk(appDir);
		expect(offenders).toEqual([]);
	});
});
