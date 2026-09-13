import type { DailyManifest, GoldEvent, GoldTruth, NormalizedItem, StructuredFact } from "../schemas/index.ts";
import { DailyManifest as DailyManifestSchema, GoldTruth as GoldTruthSchema } from "../schemas/index.ts";
import type { DateKey, EventSpec, Role, RoleSpec } from "./scenarios.ts";
import {
	CRYPTO_ASSETS,
	DATES,
	EMERGING_SIGNALS,
	EVENTS,
	NOISE_TEMPLATES,
	ROLE_SOURCE_TYPE,
} from "./scenarios.ts";

export const DEFAULT_SEED = 20260910;

/* ------------------------------------------------------------------ PRNG */

/** mulberry32 - 32-bit, seedable, no dependency, identical across platforms. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

interface Rng {
	next(): number;
	int(min: number, max: number): number;
	pick<T>(items: readonly T[]): T;
	round(value: number, decimals: number): number;
}

function makeRng(seed: number): Rng {
	const next = mulberry32(seed);
	const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
	return {
		next,
		int,
		pick: <T,>(items: readonly T[]): T => {
			const chosen = items[int(0, items.length - 1)];
			if (chosen === undefined) throw new Error("pick() from empty list");
			return chosen;
		},
		round: (value: number, decimals: number) => {
			const f = 10 ** decimals;
			return Math.round(value * f) / f;
		},
	};
}

/* --------------------------------------------------------------- drafting */

interface DraftFact {
	kind: StructuredFact["kind"];
	label: string;
	value: number;
	unit: string;
	previousValue?: number;
	changePct?: number;
}

interface DraftItem {
	/** Internal only. Never serialized. */
	sortKey: string;
	eventKey: string | null;
	isNoise: boolean;
	isPrimary: boolean;
	sourceType: NormalizedItem["sourceType"];
	sourceName: string;
	title: string;
	summary: string;
	content?: string;
	url?: string;
	publishedAt: string;
	metadata: Record<string, unknown>;
	facts: DraftFact[];
}

const slug = (text: string): string =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 48);

function isoAt(date: DateKey, minuteOfDay: number): string {
	const hour = Math.floor(minuteOfDay / 60);
	const minute = minuteOfDay % 60;
	return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

const ROLE_VOICE: Record<Role, (e: EventSpec) => string> = {
	official: (e) => `${e.org} published this as a primary source document.`,
	github: (e) => `Repository activity on ${e.repo ?? e.org}.`,
	hackernews: () => "Front page discussion thread.",
	reddit: (e) => `Community thread in r/${e.sub ?? "technology"}.`,
	media: (e) => `Reporting from ${e.outlet ?? "TechCrunch"}.`,
	analysis: (e) => `Analysis from ${e.analyst ?? "Stratechery"}.`,
	arxiv: () => "Preprint posted to arXiv.",
	semanticScholar: () => "Indexed bibliographic record.",
	youtube: (e) => `Video explainer from ${e.channel ?? "The Changelog"}.`,
	sec: () => "Filing text from EDGAR.",
	fred: () => "Series release from the FRED economic data service.",
};

const SOURCE_NAME: Record<Role, (e: EventSpec) => string> = {
	official: (e) => `${e.org} Newsroom`,
	github: (e) => `github.com/${e.repo ?? slug(e.org)}`,
	hackernews: () => "Hacker News",
	reddit: (e) => `r/${e.sub ?? "technology"}`,
	media: (e) => e.outlet ?? "TechCrunch",
	analysis: (e) => e.analyst ?? "Stratechery",
	arxiv: () => "arXiv cs.LG",
	semanticScholar: () => "Semantic Scholar",
	youtube: () => "YouTube",
	sec: () => "SEC EDGAR",
	fred: () => "FRED",
};

/** Roles whose items carry full multi-paragraph bodies. */
const SUBSTANTIVE: ReadonlySet<Role> = new Set<Role>([
	"official",
	"github",
	"media",
	"analysis",
	"arxiv",
	"sec",
	"fred",
]);

function buildContent(role: Role, event: EventSpec): string {
	const lead = ROLE_VOICE[role](event);
	const closing =
		role === "official" || role === "sec" || role === "fred"
			? "The document above is the authoritative record for this item; downstream coverage should be read against it."
			: `Further reporting is expected as ${event.org} and the affected downstream projects respond.`;
	return [
		`${lead} ${event.detail}`,
		event.context ?? `Context reported alongside the item is limited to what ${event.org} has said publicly so far.`,
		`${event.impact} ${closing}`,
	].join("\n\n");
}

function buildSummary(role: Role, event: EventSpec): string {
	const body = role === "analysis" || role === "youtube" ? event.impact : event.detail;
	const trimmed = body.length > 230 ? `${body.slice(0, 227).trimEnd()}...` : body;
	return `${ROLE_VOICE[role](event)} ${trimmed}`;
}

function buildUrl(role: Role, event: EventSpec, spec: RoleSpec, rng: Rng): string {
	const path = slug(spec.title);
	switch (role) {
		case "github":
			return `https://github.com/${event.repo ?? slug(event.org)}/issues/${rng.int(1200, 9800)}`;
		case "hackernews":
			return `https://news.ycombinator.com/item?id=${rng.int(41000000, 44999999)}`;
		case "reddit":
			return `https://reddit.com/r/${event.sub ?? "technology"}/comments/${rng.int(100000, 999999).toString(36)}/${path}`;
		case "arxiv":
			return `https://arxiv.org/abs/2609.${String(rng.int(1000, 19999)).padStart(5, "0")}`;
		case "semanticScholar":
			return `https://semanticscholar.org/paper/${rng.int(100000000, 999999999).toString(16)}`;
		case "youtube":
			return `https://youtube.com/watch?v=${rng.int(100000000, 999999999).toString(36)}`;
		case "sec":
			return `https://sec.gov/Archives/edgar/data/${rng.int(1000000, 1999999)}/${path}.htm`;
		case "fred":
			return `https://fred.stlouisfed.org/release?rid=${rng.int(10, 499)}`;
		default:
			return `https://${slug(SOURCE_NAME[role](event)).replace(/-/g, "")}.example.com/${path}`;
	}
}

function buildMetadata(role: Role, event: EventSpec, rng: Rng): Record<string, unknown> {
	switch (role) {
		case "github":
			return {
				repo: event.repo ?? slug(event.org),
				number: rng.int(1200, 9800),
				stars: rng.int(1800, 96000),
				openIssues: rng.int(40, 1400),
				labels: [rng.pick(["bug", "enhancement", "release", "regression", "needs-triage"])],
				state: rng.pick(["open", "closed"]),
			};
		case "hackernews":
			return {
				score: rng.int(48, 1420),
				commentCount: rng.int(12, 640),
				hnId: rng.int(41000000, 44999999),
				domain: `${slug(event.org).replace(/-/g, "")}.example.com`,
			};
		case "reddit":
			return {
				subreddit: event.sub ?? "technology",
				upvotes: rng.int(40, 9200),
				commentCount: rng.int(8, 720),
				flair: rng.pick(["Discussion", "News", "Question", "Resource"]),
			};
		case "media":
		case "analysis":
			return {
				author: rng.pick([
					"J. Okonkwo",
					"M. Lindqvist",
					"A. Ferreira",
					"S. Nakamura",
					"R. Delacroix",
					"T. Abadi",
				]),
				wordCount: rng.int(480, 2400),
				section: rng.pick(["technology", "business", "markets", "policy"]),
			};
		case "official":
			return { author: `${event.org} Communications`, wordCount: rng.int(320, 1600) };
		case "arxiv":
			return {
				arxivId: `2609.${String(rng.int(1000, 19999)).padStart(5, "0")}`,
				primaryCategory: rng.pick(["cs.LG", "cs.CL", "quant-ph", "cs.RO"]),
				authorCount: rng.int(3, 14),
				version: rng.int(1, 2),
			};
		case "semanticScholar":
			return { citationCount: rng.int(0, 18), influentialCitationCount: rng.int(0, 4), fieldsOfStudy: ["Computer Science"] };
		case "youtube":
			return {
				channel: event.channel ?? "The Changelog",
				viewCount: rng.int(4000, 480000),
				durationSec: rng.int(320, 2400),
			};
		case "sec":
			return {
				cik: String(rng.int(1000000, 1999999)),
				formType: rng.pick(["8-K", "8-K", "10-Q"]),
				ticker: event.org.slice(0, 4).toUpperCase().replace(/[^A-Z]/g, ""),
			};
		case "fred":
			return {
				seriesId: rng.pick(["CPILFESL", "ICSA", "PAYEMS", "UNRATE"]),
				releaseName: `${event.org} scheduled release`,
				frequency: rng.pick(["Monthly", "Weekly"]),
			};
	}
}

function draftEventItems(event: EventSpec, rng: Rng): DraftItem[] {
	const primary = new Set(event.primary);
	return event.roles.map((spec, index) => {
		const role = spec.role;
		const minute = rng.int(6 * 60, 21 * 60 + 59);
		return {
			sortKey: `${event.key}:${role}:${index}`,
			eventKey: event.key,
			isNoise: false,
			isPrimary: primary.has(role),
			sourceType: ROLE_SOURCE_TYPE[role],
			sourceName: SOURCE_NAME[role](event),
			title: spec.title,
			summary: buildSummary(role, event),
			content: SUBSTANTIVE.has(role) ? buildContent(role, event) : undefined,
			url: buildUrl(role, event, spec, rng),
			publishedAt: isoAt(event.date, minute),
			metadata: buildMetadata(role, event, rng),
			facts:
				event.factRole === role && event.facts
					? event.facts.map((f) => ({
							kind: f.kind,
							label: f.label,
							value: f.value,
							unit: f.unit,
							...(f.previousValue === undefined ? {} : { previousValue: f.previousValue }),
							...(f.changePct === undefined ? {} : { changePct: f.changePct }),
						}))
					: [],
		};
	});
}

function draftCryptoNoise(date: DateKey, rng: Rng): DraftItem[] {
	return CRYPTO_ASSETS.map((asset, index) => {
		const drift = rng.round((rng.next() - 0.5) * 6.4, 2);
		const price = rng.round(asset.basePrice * (1 + drift / 100), asset.basePrice < 1 ? 4 : 2);
		const previous = rng.round(asset.basePrice, asset.basePrice < 1 ? 4 : 2);
		const direction = drift >= 0 ? "edges up" : "slips";
		const minute = rng.int(6 * 60, 21 * 60 + 59);
		return {
			sortKey: `crypto:${asset.symbol}:${index}`,
			eventKey: null,
			isNoise: true,
			isPrimary: false,
			sourceType: "coingecko" as const,
			sourceName: "CoinGecko",
			title: `${asset.name} ${direction} ${Math.abs(drift).toFixed(2)}% in quiet trading`,
			summary: `${asset.name} changed ${drift.toFixed(2)}% over twenty-four hours on volume in line with its thirty-day average. No catalyst reported.`,
			url: `https://coingecko.com/coins/${slug(asset.name)}`,
			publishedAt: isoAt(date, minute),
			metadata: {
				symbol: asset.symbol,
				priceUsd: price,
				change24hPct: drift,
				marketCapUsd: rng.int(400000000, 1400000000000),
				volume24hUsd: rng.int(90000000, 42000000000),
			},
			facts: [
				{
					kind: "crypto" as const,
					label: `${asset.name} spot price`,
					value: price,
					unit: "usd",
					previousValue: previous,
					changePct: drift,
				},
			],
		};
	});
}

function draftIrrelevantNoise(date: DateKey, count: number, rng: Rng): DraftItem[] {
	const pool = [...NOISE_TEMPLATES];
	// Deterministic Fisher-Yates so each day draws a different, repeatable subset.
	for (let i = pool.length - 1; i > 0; i -= 1) {
		const j = rng.int(0, i);
		const a = pool[i];
		const b = pool[j];
		if (a === undefined || b === undefined) continue;
		pool[i] = b;
		pool[j] = a;
	}
	return pool.slice(0, count).map((template, index) => {
		const minute = rng.int(5 * 60, 22 * 60 + 59);
		const metadata: Record<string, unknown> =
			template.sourceType === "reddit"
				? { subreddit: template.sourceName.replace(/^r\//, ""), upvotes: rng.int(20, 24000), commentCount: rng.int(3, 1900) }
				: template.sourceType === "hackernews"
					? { score: rng.int(3, 220), commentCount: rng.int(0, 180), hnId: rng.int(41000000, 44999999) }
					: template.sourceType === "youtube"
						? { channel: template.sourceName, viewCount: rng.int(1200, 920000), durationSec: rng.int(180, 1800) }
						: { author: rng.pick(["K. Mensah", "P. Andersson", "L. Rossi", "D. Moreau", "H. Yilmaz"]), wordCount: rng.int(300, 1400) };
		return {
			sortKey: `noise:${index}:${slug(template.title)}`,
			eventKey: null,
			isNoise: true,
			isPrimary: false,
			sourceType: template.sourceType,
			sourceName: template.sourceName,
			title: template.title,
			summary: template.summary,
			url: `https://${slug(template.sourceName).replace(/-/g, "")}.example.com/${slug(template.title)}`,
			publishedAt: isoAt(date, minute),
			metadata,
			facts: [],
		};
	});
}

/* -------------------------------------------------------------- assembly */

export interface GeneratedDay {
	date: DateKey;
	manifest: DailyManifest;
	gold: GoldTruth;
}

const IRRELEVANT_NOISE_PER_DAY = 20;

export function generateDay(date: DateKey, seed: number = DEFAULT_SEED): GeneratedDay {
	const rng = makeRng((fnv1a(`${seed}:${date}`) ^ (seed >>> 0)) >>> 0);
	const events = EVENTS.filter((e) => e.date === date);

	const drafts: DraftItem[] = [
		...events.flatMap((event) => draftEventItems(event, rng)),
		...draftCryptoNoise(date, rng),
		...draftIrrelevantNoise(date, IRRELEVANT_NOISE_PER_DAY, rng),
	];

	// Chronological order with a stable tiebreak: items from one event end up
	// scattered through the day exactly as a real feed would deliver them.
	drafts.sort((a, b) =>
		a.publishedAt === b.publishedAt ? (a.sortKey < b.sortKey ? -1 : 1) : a.publishedAt < b.publishedAt ? -1 : 1,
	);

	const compact = date.replace(/-/g, "");
	const idBySortKey = new Map<string, string>();
	const items: NormalizedItem[] = drafts.map((draft, index) => {
		const id = `itm-${compact}-${String(index + 1).padStart(4, "0")}`;
		idBySortKey.set(draft.sortKey, id);
		return {
			id,
			sourceType: draft.sourceType,
			sourceName: draft.sourceName,
			title: draft.title,
			summary: draft.summary,
			...(draft.content === undefined ? {} : { content: draft.content }),
			...(draft.url === undefined ? {} : { url: draft.url }),
			publishedAt: draft.publishedAt,
			metadata: draft.metadata,
		};
	});

	const facts: StructuredFact[] = [];
	for (const draft of drafts) {
		const sourceItemId = idBySortKey.get(draft.sortKey);
		if (sourceItemId === undefined) continue;
		for (const fact of draft.facts) {
			facts.push({
				factId: `fct-${compact}-${String(facts.length + 1).padStart(3, "0")}`,
				kind: fact.kind,
				label: fact.label,
				value: fact.value,
				unit: fact.unit,
				asOf: draft.publishedAt,
				sourceItemId,
				...(fact.previousValue === undefined ? {} : { previousValue: fact.previousValue }),
				...(fact.changePct === undefined ? {} : { changePct: fact.changePct }),
			});
		}
	}

	const manifest = DailyManifestSchema.parse({
		date,
		generatedAt: `${date}T23:59:00.000Z`,
		items,
		facts,
	} satisfies DailyManifest);

	// ---- gold truth, built from the same drafts but written elsewhere -----
	const idsByEvent = new Map<string, { all: string[]; primary: string[] }>();
	for (const draft of drafts) {
		if (draft.eventKey === null) continue;
		const id = idBySortKey.get(draft.sortKey);
		if (id === undefined) continue;
		const bucket = idsByEvent.get(draft.eventKey) ?? { all: [], primary: [] };
		bucket.all.push(id);
		if (draft.isPrimary) bucket.primary.push(id);
		idsByEvent.set(draft.eventKey, bucket);
	}

	const goldEvents: GoldEvent[] = events.map((event) => {
		const bucket = idsByEvent.get(event.key);
		if (bucket === undefined || bucket.all.length === 0) {
			throw new Error(`event ${event.key} produced no items`);
		}
		if (bucket.primary.length === 0) {
			throw new Error(`event ${event.key} declares primary roles that produced no items`);
		}
		return {
			eventId: `evt-${compact}-${event.key}`,
			canonicalTitle: event.canonicalTitle,
			itemIds: bucket.all,
			primaryItemIds: bucket.primary,
			expectedChangeType: event.changeType,
			expectedImportant: event.important,
			expectedSection: event.section,
		};
	});

	const noiseItemIds = drafts
		.filter((d) => d.isNoise)
		.map((d) => idBySortKey.get(d.sortKey))
		.filter((id): id is string => id !== undefined);

	const gold = GoldTruthSchema.parse({
		date,
		events: goldEvents,
		noiseItemIds,
		expectedEmergingSignals: EMERGING_SIGNALS.filter((s) => s.date === date).map((s) => ({
			label: s.label,
			eventIds: s.eventKeys.map((key) => `evt-${compact}-${key}`),
		})),
	} satisfies GoldTruth);

	return { date, manifest, gold };
}

export function generateAll(seed: number = DEFAULT_SEED): GeneratedDay[] {
	return DATES.map((date) => generateDay(date, seed));
}
