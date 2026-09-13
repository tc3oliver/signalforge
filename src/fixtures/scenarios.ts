import type { BriefSection } from "../schemas/brief.ts";
import type { ChangeType } from "../schemas/story.ts";
import type { FactKind, SourceType } from "../schemas/index.ts";

/**
 * Declarative description of the synthetic world. Nothing here is written into a
 * manifest verbatim except titles/prose: the generator owns ids, timestamps and
 * numeric metadata so that the agent-visible artifact carries no structural hint
 * of which event an item belongs to.
 */

export const DATES = ["2026-09-10", "2026-09-11", "2026-09-12"] as const;
export type DateKey = (typeof DATES)[number];

/** How a single outlet frames an event. Determines sourceType and prose voice. */
export type Role =
	| "official"
	| "github"
	| "hackernews"
	| "reddit"
	| "media"
	| "analysis"
	| "arxiv"
	| "semanticScholar"
	| "youtube"
	| "sec"
	| "fred";

export const ROLE_SOURCE_TYPE: Record<Role, SourceType> = {
	official: "web",
	github: "github",
	hackernews: "hackernews",
	reddit: "reddit",
	media: "rss",
	analysis: "rss",
	arxiv: "arxiv",
	semanticScholar: "semantic-scholar",
	youtube: "youtube",
	sec: "sec",
	fred: "fred",
};

export interface FactSpec {
	key: string;
	kind: FactKind;
	label: string;
	value: number;
	unit: string;
	previousValue?: number;
	changePct?: number;
}

export interface RoleSpec {
	role: Role;
	title: string;
}

export interface EventSpec {
	/** Stable per-date key. The gold eventId is derived from it; items never are. */
	key: string;
	date: DateKey;
	changeType: ChangeType;
	important: boolean;
	section: BriefSection;
	canonicalTitle: string;
	org: string;
	repo?: string;
	sub?: string;
	outlet?: string;
	analyst?: string;
	channel?: string;
	/** One factual sentence reused, re-voiced, across every outlet. */
	detail: string;
	/** One consequence sentence. */
	impact: string;
	context?: string;
	roles: RoleSpec[];
	primary: Role[];
	facts?: FactSpec[];
	factRole?: Role;
}

const r = (role: Role, title: string): RoleSpec => ({ role, title });

/** Cross-day arcs: the same real-world thread evolving over two or three days. */
const ARC_EVENTS: EventSpec[] = [
	// ---- Arc 1: AI model rumor -> nothing new -> official confirmation -------
	{
		key: "arc-model-rumor-d1",
		date: "2026-09-10",
		changeType: "RUMOR",
		important: true,
		section: "AI_LLM",
		canonicalTitle: "Unconfirmed reports of a Meridian 3 Opus long-context model",
		org: "Meridian Labs",
		sub: "LocalLLaMA",
		outlet: "The Information",
		detail:
			"Three people with knowledge of the roadmap describe an unreleased Meridian model with a two-million-token context window and a retrieval-free long-document mode, targeted at enterprise document review.",
		impact:
			"If accurate, it would reset the practical ceiling for single-pass document analysis and put pressure on retrieval-augmented vendors whose value rests on context scarcity.",
		context:
			"Meridian Labs has declined to comment, and no model card, pricing page or API changelog entry exists yet.",
		roles: [
			r("media", "Meridian is said to be testing a two-million-token model with enterprise customers"),
			r("hackernews", "Ask HN: is the Meridian long-context rumour credible, or a pricing trial balloon?"),
			r("reddit", "Someone in my org got early access to something that is not Meridian 2.5"),
			r("analysis", "Reading the tea leaves on context-window escalation"),
		],
		primary: ["media"],
	},
	{
		key: "arc-model-rumor-d2",
		date: "2026-09-11",
		changeType: "NO_MATERIAL_CHANGE",
		important: false,
		section: "AI_LLM",
		canonicalTitle: "Second-hand coverage of the Meridian long-context rumor adds nothing",
		org: "Meridian Labs",
		sub: "LocalLLaMA",
		outlet: "VentureBeat",
		detail:
			"A follow-up write-up restates yesterday's sourcing without adding a named source, a benchmark, a date or a price, and the aggregator threads simply relink the original report.",
		impact:
			"The state of knowledge is unchanged: there is still no primary artifact, so the story should not advance in the ledger.",
		context: "Meridian Labs again declined to comment when contacted for this piece.",
		roles: [
			r("media", "What we know so far about Meridian's rumoured flagship"),
			r("hackernews", "Meridian long-context rumour roundup (mostly recycled)"),
			r("reddit", "Daily discussion: still no Meridian 3 announcement"),
		],
		primary: ["media"],
	},
	{
		key: "arc-model-rumor-d3",
		date: "2026-09-12",
		changeType: "CONFIRMATION",
		important: true,
		section: "AI_LLM",
		canonicalTitle: "Meridian Labs confirms Meridian 3 Opus with a two-million-token context window",
		org: "Meridian Labs",
		repo: "meridian-labs/meridian-sdk",
		sub: "LocalLLaMA",
		outlet: "The Information",
		detail:
			"Meridian Labs published a model card for Meridian 3 Opus confirming a two-million-token context window, a 4x price reduction per output token against Meridian 2.5, and general availability in three regions.",
		impact:
			"The rumour reported two days ago is now a primary-source fact, and the pricing move is the part the earlier coverage got wrong.",
		context:
			"Third-party long-context evaluations are not yet published, so quality at full context length remains unverified.",
		roles: [
			r("official", "Introducing Meridian 3 Opus"),
			r("github", "meridian-sdk v9.0.0: add meridian-3-opus, raise max_context to 2097152"),
			r("hackernews", "Meridian 3 Opus is live, and the price cut is the real story"),
			r("reddit", "Meridian 3 Opus is out - here is what the model card actually says"),
			r("media", "Meridian confirms the long-context model it would not discuss last week"),
		],
		primary: ["official", "github"],
	},

	// ---- Arc 2: GitHub issue NEW -> escalation -> resolution -----------------
	{
		key: "arc-gh-regression-d1",
		date: "2026-09-10",
		changeType: "NEW",
		important: true,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Sable ORM 6.2 reported to drop rows during batched upserts",
		org: "Sable",
		repo: "sable-data/sable-orm",
		sub: "node",
		outlet: "InfoQ",
		detail:
			"An issue filed against sable-orm 6.2.0 reports that batched upserts silently discard rows when the batch exceeds the connection pool size, with a 40-line reproduction against PostgreSQL 17.",
		impact:
			"Silent data loss in a widely used ORM is the failure class teams discover weeks later in reconciliation, not at deploy time.",
		context: "The issue has not yet been triaged or labelled by a maintainer.",
		roles: [
			r("github", "sable-orm 6.2.0: batched upsert silently drops rows past pool size"),
			r("hackernews", "Silent row loss in Sable ORM 6.2 batched upserts"),
			r("reddit", "Has anyone else lost rows after upgrading Sable ORM?"),
			r("media", "Report of data loss in Sable ORM batch writes"),
		],
		primary: ["github"],
	},
	{
		key: "arc-gh-regression-d2",
		date: "2026-09-11",
		changeType: "ESCALATION",
		important: true,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Sable ORM maintainers confirm the upsert data-loss regression",
		org: "Sable",
		repo: "sable-data/sable-orm",
		sub: "node",
		outlet: "InfoQ",
		detail:
			"A maintainer reproduced the fault, bisected it to a connection-release change shipped in 6.2.0, and eleven further organisations reported matching symptoms including two with confirmed production data loss.",
		impact:
			"The blast radius is now every 6.2.x deployment using batched writes, not a single misconfigured pool, and there is no workaround other than pinning to 6.1.9.",
		context: "A CVE request is open and the maintainers have advised against upgrading until a patch lands.",
		roles: [
			r("github", "Maintainer confirmation + bisect: regression introduced by #7741 connection release"),
			r("reddit", "Update: Sable ORM row loss is confirmed, we lost three days of ledger writes"),
			r("hackernews", "Sable ORM data loss is confirmed and bisected to a 6.2.0 pool change"),
			r("media", "Sable ORM data-loss bug widens as maintainers confirm regression"),
		],
		primary: ["github"],
	},
	{
		key: "arc-gh-regression-d3",
		date: "2026-09-12",
		changeType: "RESOLUTION",
		important: true,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Sable ORM 6.2.4 patches the batched-upsert data-loss regression",
		org: "Sable",
		repo: "sable-data/sable-orm",
		sub: "node",
		outlet: "InfoQ",
		detail:
			"Sable ORM 6.2.4 restores the pre-6.2 connection release ordering, adds a regression test that runs batch sizes above pool size in CI, and ships a detection script that reports whether a database is missing rows.",
		impact:
			"The immediate risk is closed for anyone who upgrades, but affected teams still have to audit writes made while running 6.2.0 through 6.2.3.",
		context: "The maintainers published a post-mortem describing why the original change passed review.",
		roles: [
			r("github", "Release 6.2.4: fix connection release ordering, add batch>pool regression suite"),
			r("hackernews", "Sable ORM 6.2.4 and the post-mortem on how the row loss shipped"),
			r("media", "Patch released for Sable ORM data-loss bug"),
		],
		primary: ["github"],
	},

	// ---- Arc 3: release -> media echo ---------------------------------------
	{
		key: "arc-release-d2",
		date: "2026-09-11",
		changeType: "NEW",
		important: true,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Halyard 2.0 ships a rewritten scheduler and a stable plugin ABI",
		org: "Halyard",
		repo: "halyard/halyard",
		sub: "devops",
		outlet: "The New Stack",
		detail:
			"Halyard 2.0 replaces the cooperative scheduler with a work-stealing runtime, freezes the plugin ABI for the 2.x line, and removes the deprecated YAML v1 pipeline format.",
		impact:
			"The ABI freeze is what unblocks third-party plugin authors who have been rebuilding against every minor release for two years.",
		context: "Migration from v1 pipelines requires a one-way conversion tool shipped alongside the release.",
		roles: [
			r("official", "Halyard 2.0 is available today"),
			r("github", "halyard v2.0.0 release notes: work-stealing scheduler, frozen plugin ABI"),
			r("hackernews", "Show HN: we rewrote Halyard's scheduler and the p99 dropped 70%"),
			r("reddit", "Halyard 2.0 migration: the YAML v1 removal is going to hurt"),
			r("media", "Halyard 2.0 lands with a stable plugin interface"),
		],
		primary: ["official", "github"],
	},
	{
		key: "arc-release-d3",
		date: "2026-09-12",
		changeType: "NO_MATERIAL_CHANGE",
		important: false,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Downstream coverage repeats the Halyard 2.0 release notes",
		org: "Halyard",
		sub: "devops",
		outlet: "SD Times",
		channel: "The Changelog",
		detail:
			"Follow-on coverage summarises yesterday's release notes without new benchmarks, adoption numbers or migration reports from real deployments.",
		impact: "Nothing has changed about what Halyard 2.0 is or what upgrading costs.",
		roles: [
			r("media", "Halyard 2.0: what is new for pipeline authors"),
			r("reddit", "Anyone actually migrated off YAML v1 yet? Asking for a Friday deploy"),
			r("youtube", "Halyard 2.0 walkthrough and upgrade demo"),
		],
		primary: ["media"],
	},

	// ---- Arc 4: research publication -> secondary discussion ----------------
	{
		key: "arc-paper-d2",
		date: "2026-09-11",
		changeType: "NEW",
		important: true,
		section: "RESEARCH",
		canonicalTitle: "Preprint reports stable training at 1-bit optimizer state",
		org: "Kestrel Institute",
		sub: "MachineLearning",
		outlet: "Quanta",
		detail:
			"A preprint reports that a sign-based optimizer with per-tensor error feedback matches AdamW loss curves on a 13B-parameter run while holding optimizer state at one bit per parameter.",
		impact:
			"If it replicates at larger scale, it removes roughly two thirds of optimizer memory and changes how much model fits on a fixed accelerator budget.",
		context: "The largest reported run is 13B parameters over 400B tokens; no 70B result is included.",
		roles: [
			r("arxiv", "Sign-SGD with per-tensor error feedback matches AdamW at 1-bit optimizer state"),
			r("hackernews", "1-bit optimizer state that actually trains (paper)"),
			r("reddit", "Paper discussion: is the 1-bit optimizer result going to survive 70B?"),
			r("semanticScholar", "Low-precision optimizer state for large-scale pretraining"),
		],
		primary: ["arxiv"],
	},
	{
		key: "arc-paper-d3",
		date: "2026-09-12",
		changeType: "UPDATE",
		important: true,
		section: "RESEARCH",
		canonicalTitle: "Independent reproductions qualify the 1-bit optimizer result",
		org: "Kestrel Institute",
		repo: "kestrel-inst/onebit-opt",
		sub: "MachineLearning",
		outlet: "Quanta",
		channel: "Yannic Kilcher",
		detail:
			"Two independent groups reproduced the 13B result within 0.4% loss but report divergence above 30B parameters unless error feedback is kept in bf16, which returns part of the claimed memory saving.",
		impact:
			"The headline claim survives at the tested scale but the memory saving at frontier scale is roughly half what the abstract implies.",
		context: "The authors have acknowledged the scale caveat and say a revised version is in preparation.",
		roles: [
			r("github", "onebit-opt: reproduction results and the bf16 error-feedback caveat"),
			r("hackernews", "The 1-bit optimizer paper does not hold above 30B without bf16 error feedback"),
			r("reddit", "Reproduction thread: 1-bit optimizer at 30B diverges"),
			r("youtube", "Walking through the 1-bit optimizer paper and its reproductions"),
		],
		primary: ["github"],
	},

	// ---- Arc 5: conflicting reports -> reversal -----------------------------
	{
		key: "arc-conflict-d2",
		date: "2026-09-11",
		changeType: "RUMOR",
		important: true,
		section: "COMPANIES",
		canonicalTitle: "Outlets contradict each other on a Corvid Robotics acquisition",
		org: "Corvid Robotics",
		sub: "investing",
		outlet: "Bloomberg",
		detail:
			"One outlet reports that Corvid Robotics has agreed to be acquired by Talos Industrial for about 4.1 billion dollars, while a second reports on its own sourcing that talks collapsed over indemnity terms three weeks ago.",
		impact:
			"Both reports cannot be true, and the disagreement is about the present state of the deal rather than about details.",
		context: "Neither company has filed or commented, and the two reports do not share a source.",
		roles: [
			r("media", "Talos Industrial nears 4.1 billion dollar deal for Corvid Robotics"),
			r("analysis", "Corvid Robotics talks with Talos fell apart weeks ago, people familiar say"),
			r("hackernews", "Two outlets, two opposite stories about Corvid Robotics"),
			r("reddit", "Which Corvid Robotics report do we believe?"),
		],
		primary: ["media", "analysis"],
	},
	{
		key: "arc-conflict-d3",
		date: "2026-09-12",
		changeType: "REVERSAL",
		important: true,
		section: "COMPANIES",
		canonicalTitle: "Corvid Robotics says no acquisition talks are active, reversing the deal report",
		org: "Corvid Robotics",
		sub: "investing",
		outlet: "Bloomberg",
		detail:
			"Corvid Robotics issued a statement saying no acquisition agreement exists and that discussions with any counterparty ended in August, and the outlet that reported an imminent deal appended a correction.",
		impact:
			"The primary-source statement reverses yesterday's leading report; the contradicting account was the accurate one.",
		context: "Talos Industrial declined to comment beyond confirming it is not in active discussions.",
		roles: [
			r("official", "Statement regarding market speculation"),
			r("media", "Correction: Corvid Robotics deal report retracted"),
			r("hackernews", "Corvid Robotics denies the acquisition, outlet issues correction"),
			r("reddit", "Told you so: Corvid denies the Talos deal"),
		],
		primary: ["official"],
	},

	// ---- Arc 6: macro release with structured facts (day 3) -----------------
	{
		key: "arc-macro-cpi-d3",
		date: "2026-09-12",
		changeType: "NEW",
		important: true,
		section: "MACRO",
		canonicalTitle: "August core CPI comes in below consensus at 2.4% year over year",
		org: "Bureau of Labor Statistics",
		sub: "economics",
		outlet: "Reuters",
		detail:
			"Core CPI rose 0.14% on the month and 2.4% year over year in August, below the 2.6% consensus, with shelter decelerating for a fourth consecutive month.",
		impact:
			"A fourth month of shelter deceleration is the component that moves rate expectations, and futures repriced the next meeting within minutes.",
		context: "Headline CPI was 2.7% year over year; the goods component turned negative.",
		roles: [
			r("fred", "CPILFESL: Core CPI for All Urban Consumers, August 2026 release"),
			r("media", "Core inflation cools to 2.4%, below forecasts"),
			r("analysis", "The shelter component is finally doing what the models said it would"),
			r("reddit", "CPI print is in and the shelter lag is breaking"),
		],
		primary: ["fred"],
		factRole: "fred",
		facts: [
			{
				key: "core-cpi-yoy",
				kind: "macro",
				label: "Core CPI year over year",
				value: 2.4,
				unit: "percent",
				previousValue: 2.7,
				changePct: -11.11,
			},
			{
				key: "core-cpi-mom",
				kind: "macro",
				label: "Core CPI month over month",
				value: 0.14,
				unit: "percent",
				previousValue: 0.21,
				changePct: -33.33,
			},
			{
				key: "shelter-yoy",
				kind: "macro",
				label: "Shelter CPI year over year",
				value: 3.1,
				unit: "percent",
				previousValue: 3.6,
				changePct: -13.89,
			},
		],
	},

	// ---- Arc 7: company filing with structured facts (day 2) ----------------
	{
		key: "arc-filing-d2",
		date: "2026-09-11",
		changeType: "NEW",
		important: true,
		section: "COMPANIES",
		canonicalTitle: "Lumen Fabrication discloses a 1.8 billion dollar capacity write-down",
		org: "Lumen Fabrication",
		sub: "investing",
		outlet: "Reuters",
		detail:
			"Lumen Fabrication filed an 8-K disclosing a 1.8 billion dollar impairment against its 3nm capacity expansion and cut full-year capital expenditure guidance to 6.2 billion dollars from 8.4 billion.",
		impact:
			"A capex cut of that size from a leading-edge foundry is a demand signal for everyone downstream of it, not just a Lumen story.",
		context: "The filing attributes the impairment to a single customer's cancelled multi-year commitment.",
		roles: [
			r("sec", "Lumen Fabrication Inc. Form 8-K, Item 2.06 material impairment"),
			r("media", "Lumen takes 1.8 billion dollar hit, slashes capex guidance"),
			r("hackernews", "Lumen's 8-K reads like a demand warning for the whole node"),
			r("analysis", "What Lumen's capex cut says about leading-edge demand"),
		],
		primary: ["sec"],
		factRole: "sec",
		facts: [
			{
				key: "impairment",
				kind: "filing",
				label: "Lumen Fabrication impairment charge",
				value: 1800000000,
				unit: "usd",
			},
			{
				key: "capex-guide",
				kind: "filing",
				label: "Lumen Fabrication FY capex guidance",
				value: 6200000000,
				unit: "usd",
				previousValue: 8400000000,
				changePct: -26.19,
			},
		],
	},

	// ---- Arc 8: community rumor that never resolves -------------------------
	{
		key: "arc-community-rumor-d1",
		date: "2026-09-10",
		changeType: "RUMOR",
		important: false,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Unsourced claim that Basalt Engine is changing its licence",
		org: "Basalt",
		sub: "gamedev",
		detail:
			"A thread claims without evidence that Basalt Engine will move to a revenue-share licence at the next major version, citing an unnamed partner call.",
		impact: "No primary artifact exists, so the claim is not actionable.",
		roles: [
			r("reddit", "Heard from a partner that Basalt is going revenue-share in v7"),
			r("hackernews", "Basalt licence change rumour (single unnamed source)"),
		],
		primary: ["reddit"],
	},
	{
		key: "arc-community-rumor-d2",
		date: "2026-09-11",
		changeType: "RUMOR",
		important: false,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Basalt licence rumor recirculates without new evidence",
		org: "Basalt",
		sub: "gamedev",
		detail:
			"The licence claim recirculates in a new thread, still sourced to the same unnamed partner call and still contradicted by nobody on the record.",
		impact: "Still no primary artifact; the rumour has gained volume but not evidence.",
		roles: [
			r("reddit", "Basalt revenue-share licence: gathering what we actually know"),
			r("hackernews", "The Basalt licence rumour is back"),
		],
		primary: ["reddit"],
	},
	{
		key: "arc-community-rumor-d3",
		date: "2026-09-12",
		changeType: "RUMOR",
		important: false,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Basalt licence rumor persists into a third day",
		org: "Basalt",
		sub: "gamedev",
		detail:
			"A third thread repeats the licence claim and adds a screenshot that cannot be verified and does not name a version or a date.",
		impact: "The claim remains unverified and Basalt has still not been asked on the record.",
		roles: [
			r("reddit", "Screenshot allegedly showing the Basalt v7 licence terms"),
			r("hackernews", "Basalt licence screenshot looks fabricated"),
		],
		primary: ["reddit"],
	},
];

/**
 * Arc 9 - the emerging trend. No single item names the pattern; it only exists
 * once six loosely related items across three days and five sources are read
 * together. Each item is its own tiny event so gold can reference it.
 */
const TREND_EVENTS: EventSpec[] = [
	{
		key: "trend-power-a",
		date: "2026-09-10",
		changeType: "NEW",
		important: false,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Datacentre operator defers two campus builds over substation queue",
		org: "Anvil Data Centres",
		outlet: "Datacenter Dynamics",
		detail:
			"Anvil Data Centres told investors it is deferring two campus builds because the local utility cannot energise the substations before 2029.",
		impact: "Interconnection queue length, not capital, is now the binding constraint on the build.",
		roles: [r("media", "Anvil defers two campuses, blames substation interconnection queue")],
		primary: ["media"],
	},
	{
		key: "trend-power-b",
		date: "2026-09-10",
		changeType: "NEW",
		important: false,
		section: "RESEARCH",
		canonicalTitle: "Paper measures accelerator idle time caused by power capping",
		org: "Ridgeway University",
		detail:
			"A measurement study across four clusters finds accelerators idling 11% of wall-clock time because of rack-level power capping rather than scheduling.",
		impact: "Utilisation losses are being mis-attributed to schedulers when the cause is upstream of the rack.",
		roles: [r("arxiv", "Power-capping-induced idle time in production accelerator clusters")],
		primary: ["arxiv"],
	},
	{
		key: "trend-power-c",
		date: "2026-09-11",
		changeType: "NEW",
		important: false,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Scheduler gains a power-budget-aware placement plugin",
		org: "Halyard",
		repo: "halyard/halyard-power",
		detail:
			"A new placement plugin lets operators express a rack power budget as a first-class scheduling constraint alongside CPU and memory.",
		impact: "Power is being promoted from a facilities concern to a scheduling primitive.",
		roles: [r("github", "halyard-power: rack power budget as a schedulable resource")],
		primary: ["github"],
	},
	{
		key: "trend-power-d",
		date: "2026-09-11",
		changeType: "NEW",
		important: false,
		section: "COMPANIES",
		canonicalTitle: "Utility opens a dedicated large-load interconnection tariff",
		org: "Northern Grid",
		sub: "energy",
		detail:
			"Northern Grid filed a tariff creating a separate interconnection track for loads above 200 megawatts, with curtailment obligations attached.",
		impact: "Large compute loads are being regulated as a distinct customer class for the first time in this region.",
		roles: [r("reddit", "Northern Grid's new 200MW+ tariff has curtailment clauses buried in it")],
		primary: ["reddit"],
	},
	{
		key: "trend-power-e",
		date: "2026-09-12",
		changeType: "NEW",
		important: false,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Inference runtime adds a watts-per-token reporting mode",
		org: "Tessellate",
		repo: "tessellate/tessellate-runtime",
		detail:
			"The runtime can now report joules per generated token per device, sampled from the on-board power telemetry rather than estimated.",
		impact: "Energy per token becomes a measurable service-level quantity rather than a modelling assumption.",
		roles: [r("github", "tessellate-runtime: report measured joules per token per device")],
		primary: ["github"],
	},
	{
		key: "trend-power-f",
		date: "2026-09-12",
		changeType: "NEW",
		important: false,
		section: "COMPANIES",
		canonicalTitle: "Cloud provider begins pricing an instance class by power envelope",
		org: "Northbridge Cloud",
		outlet: "The Register",
		detail:
			"Northbridge Cloud introduced an instance family whose price varies with a committed power envelope rather than with instance hours alone.",
		impact: "Metering compute by watts rather than by time changes the unit economics customers optimise against.",
		roles: [r("media", "Northbridge starts selling compute by the watt")],
		primary: ["media"],
	},
];

/** Routine macro and filing releases so every day carries structured facts. */
const ROUTINE_EVENTS: EventSpec[] = DATES.flatMap((date, i): EventSpec[] => {
	const claims = [214000, 221000, 208000][i] ?? 214000;
	const prevClaims = [219000, 214000, 221000][i] ?? 219000;
	const payout = [0.42, 0.44, 0.44][i] ?? 0.42;
	return [
		{
			key: `routine-claims-${date}`,
			date,
			changeType: "NEW",
			important: false,
			section: "MACRO",
			canonicalTitle: `Weekly initial jobless claims, ${date}`,
			org: "Department of Labor",
			outlet: "MarketWatch",
			detail: `Initial jobless claims printed at ${claims.toLocaleString("en-US")}, inside the range of the past six weeks and consistent with an unchanged labour market.`,
			impact: "A print inside the recent range carries no new information for policy.",
			roles: [
				r("fred", `ICSA: Initial Claims, week ending ${date}`),
				r("media", `Jobless claims little changed at ${claims.toLocaleString("en-US")}`),
			],
			primary: ["fred"],
			factRole: "fred",
			facts: [
				{
					key: "claims",
					kind: "macro",
					label: "Initial jobless claims",
					value: claims,
					unit: "persons",
					previousValue: prevClaims,
					changePct: Number((((claims - prevClaims) / prevClaims) * 100).toFixed(2)),
				},
				{
					key: "claims-ma4",
					kind: "macro",
					label: "Initial jobless claims, four-week moving average",
					value: Math.round((claims + prevClaims) / 2),
					unit: "persons",
				},
			],
		},
		{
			key: `routine-filing-${date}`,
			date,
			changeType: "NEW",
			important: false,
			section: "COMPANIES",
			canonicalTitle: `Ashgrove Utilities routine dividend declaration, ${date}`,
			org: "Ashgrove Utilities",
			outlet: "PR Newswire",
			detail: `Ashgrove Utilities filed an 8-K declaring a quarterly dividend of ${payout.toFixed(2)} dollars per share, payable next quarter to holders of record at month end.`,
			impact: "A dividend declaration in line with the prior quarter is administrative, not informative.",
			roles: [
				r("sec", `Ashgrove Utilities Corp. Form 8-K, Item 8.01 dividend declaration`),
				r("media", `Ashgrove Utilities declares quarterly dividend of ${payout.toFixed(2)} dollars`),
			],
			primary: ["sec"],
			factRole: "sec",
			facts: [
				{
					key: "dividend",
					kind: "filing",
					label: "Ashgrove Utilities quarterly dividend per share",
					value: payout,
					unit: "usd",
					previousValue: 0.42,
				},
				{
					key: "shares-outstanding",
					kind: "filing",
					label: "Ashgrove Utilities shares outstanding",
					value: 412300000,
					unit: "shares",
				},
			],
		},
	];
});

/** Single-day events that carry the bulk of each day's importance budget. */
const STANDALONE_EVENTS: EventSpec[] = [
	// ------------------------------- 2026-09-10 -----------------------------
	{
		key: "std-cloud-outage",
		date: "2026-09-10",
		changeType: "NEW",
		important: true,
		section: "MUST_KNOW",
		canonicalTitle: "Northbridge Cloud us-east-2 control plane outage lasts six hours",
		org: "Northbridge Cloud",
		repo: "northbridge/status",
		sub: "devops",
		outlet: "The Register",
		detail:
			"A failed certificate rotation in the us-east-2 control plane blocked all new instance launches, autoscaling and load balancer changes for six hours and eleven minutes, while running workloads were unaffected.",
		impact:
			"Any customer whose failover plan depends on launching capacity discovered that the control plane is the single point of failure, not the data plane.",
		context: "Northbridge has committed to a public post-mortem within five business days.",
		roles: [
			r("official", "Service disruption in us-east-2: preliminary summary"),
			r("github", "status: us-east-2 control plane degraded - launches and scaling unavailable"),
			r("hackernews", "Northbridge us-east-2 is down and nothing can scale"),
			r("reddit", "Six hours in and our autoscaling is still frozen in us-east-2"),
			r("media", "Northbridge outage freezes scaling for six hours"),
		],
		primary: ["official"],
	},
	{
		key: "std-open-weights",
		date: "2026-09-10",
		changeType: "NEW",
		important: true,
		section: "AI_LLM",
		canonicalTitle: "Aperture releases Nimbus-7 weights under a restricted commercial licence",
		org: "Aperture Research",
		repo: "aperture/nimbus-7",
		sub: "LocalLLaMA",
		outlet: "TechCrunch",
		detail:
			"Aperture published Nimbus-7 weights for a 72B mixture-of-experts model under a licence that permits research and internal commercial use but forbids serving the model to third parties.",
		impact:
			"The weights are strong enough to matter and the licence is restrictive enough that hosting providers cannot use them, which is the whole point of the clause.",
		context: "The licence is not OSI-approved and the term open is used in the announcement anyway.",
		roles: [
			r("official", "Nimbus-7: weights, evaluations and licence"),
			r("github", "nimbus-7: initial weight release, 72B MoE, 8 active experts"),
			r("hackernews", "Nimbus-7 weights are out, and the licence forbids serving them"),
			r("reddit", "Nimbus-7 runs on two consumer cards but read clause 4 before you deploy it"),
		],
		primary: ["official", "github"],
	},
	{
		key: "std-rust-release",
		date: "2026-09-10",
		changeType: "NEW",
		important: true,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Rust 1.94 enables the parallel front end by default",
		org: "Rust Project",
		repo: "rust-lang/rust",
		sub: "rust",
		outlet: "InfoWorld",
		detail:
			"Rust 1.94 turns on the parallel compiler front end by default, reporting a 22% median reduction in cold check time across the crater run, and stabilises three long-pending const APIs.",
		impact:
			"Front-end parallelism is the first compile-time improvement in years that helps incremental workflows rather than only clean builds.",
		context: "Crates relying on front-end ordering side effects may see new diagnostics ordering in CI logs.",
		roles: [
			r("official", "Announcing Rust 1.94.0"),
			r("github", "rust: stabilize parallel front end by default for 1.94"),
			r("hackernews", "Rust 1.94 makes the parallel front end the default"),
			r("reddit", "Measured Rust 1.94 on our workspace: cold check went from 94s to 71s"),
		],
		primary: ["official"],
	},
	{
		key: "std-export-rule",
		date: "2026-09-10",
		changeType: "NEW",
		important: true,
		section: "MACRO",
		canonicalTitle: "Regulator widens accelerator export licensing to mid-tier parts",
		org: "Bureau of Industry and Security",
		sub: "hardware",
		outlet: "Reuters",
		detail:
			"An interim final rule extends licence requirements to accelerators above a revised performance-density threshold, capturing several mid-tier parts that were previously exempt.",
		impact:
			"Vendors that engineered products to sit just under the old threshold now need licences for inventory that is already built.",
		context: "The rule takes effect in thirty days with no general licence for existing orders.",
		roles: [
			r("official", "Interim final rule: revised performance-density thresholds"),
			r("media", "Export rules widen to cover mid-tier accelerators"),
			r("hackernews", "The new export threshold catches the parts built to dodge the old one"),
			r("analysis", "How the revised density threshold reshapes the mid-tier market"),
		],
		primary: ["official"],
	},
	{
		key: "std-db-cve",
		date: "2026-09-10",
		changeType: "NEW",
		important: true,
		section: "MUST_KNOW",
		canonicalTitle: "Critical authentication bypass disclosed in Quarrystone logical replication",
		org: "Quarrystone",
		repo: "quarrystone/quarrystone",
		sub: "netsec",
		outlet: "BleepingComputer",
		detail:
			"CVE-2026-41882 allows an unauthenticated client to open a logical replication slot on Quarrystone 16 and 17 when scram channel binding is disabled, exposing the full write-ahead log.",
		impact:
			"Reading the write-ahead log is equivalent to reading every table, and the vulnerable configuration is the default in two popular container images.",
		context: "Patched releases are available and a configuration-only mitigation exists.",
		roles: [
			r("official", "Security release: 17.4, 16.8 address CVE-2026-41882"),
			r("github", "quarrystone: reject replication slot creation without channel binding"),
			r("hackernews", "Unauthenticated WAL access in Quarrystone 16 and 17"),
			r("media", "Critical Quarrystone flaw exposes write-ahead logs"),
		],
		primary: ["official"],
	},
	{
		key: "std-quantum",
		date: "2026-09-10",
		changeType: "NEW",
		important: true,
		section: "RESEARCH",
		canonicalTitle: "Below-threshold logical qubit sustained for one million cycles",
		org: "Fenwick Quantum",
		sub: "Physics",
		outlet: "Nature News",
		detail:
			"A distance-9 surface code logical qubit held a logical error rate of 1.1e-7 per cycle across one million cycles, the first published run to stay below threshold for that duration.",
		impact:
			"Duration, not instantaneous error rate, was the open question, and this is the first result that addresses it directly.",
		context: "The experiment uses a single logical qubit; two-qubit logical gate results are not included.",
		roles: [
			r("arxiv", "Sustained below-threshold operation of a distance-9 surface code logical qubit"),
			r("media", "Logical qubit stays below threshold for a million cycles"),
			r("hackernews", "The surface code duration result is the one that mattered"),
			r("semanticScholar", "Fenwick Quantum group: million-cycle error-corrected memory experiment"),
		],
		primary: ["arxiv"],
	},
	{
		key: "std-stablecoin-rule",
		date: "2026-09-10",
		changeType: "NEW",
		important: true,
		section: "CRYPTO_MARKET",
		canonicalTitle: "Final rule requires daily attested reserves for payment stablecoins",
		org: "Financial Stability Board",
		sub: "CryptoCurrency",
		outlet: "CoinDesk",
		detail:
			"The final rule requires payment stablecoin issuers above 10 billion dollars in circulation to publish daily third-party attested reserve composition and to hold at least 80% in overnight instruments.",
		impact:
			"Two of the three largest issuers currently publish monthly and hold longer-duration paper, so this forces a portfolio change, not just a reporting change.",
		context: "Compliance is required within one hundred and eighty days of publication.",
		roles: [
			r("official", "Final rule on payment stablecoin reserve disclosure"),
			r("media", "Stablecoin issuers face daily reserve attestation"),
			r("hackernews", "The 80% overnight requirement is the binding part of the stablecoin rule"),
			r("reddit", "Daily attestation is going to hurt the second-largest issuer"),
		],
		primary: ["official"],
	},
	{
		key: "std-guidance-cut",
		date: "2026-09-10",
		changeType: "NEW",
		important: true,
		section: "COMPANIES",
		canonicalTitle: "Vantiq Systems cuts full-year guidance on enterprise renewal slippage",
		org: "Vantiq Systems",
		sub: "investing",
		outlet: "CNBC",
		detail:
			"Vantiq Systems cut full-year revenue guidance by 9% and said the shortfall is concentrated in multi-year enterprise renewals slipping out of the quarter rather than in churn.",
		impact:
			"Slippage rather than churn means the revenue may return, but it also means the company cannot predict its own renewal timing.",
		context: "Net revenue retention was disclosed at 104%, down from 112% a year earlier.",
		roles: [
			r("sec", "Vantiq Systems Inc. Form 8-K, Item 2.02 results and revised outlook"),
			r("media", "Vantiq cuts outlook as enterprise renewals slip"),
			r("hackernews", "Vantiq's renewal slippage looks like a sales process problem"),
			r("analysis", "Renewal slippage versus churn: reading the Vantiq disclosure"),
		],
		primary: ["sec"],
	},
	{
		key: "std-kernel-sched",
		date: "2026-09-10",
		changeType: "NEW",
		important: true,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Linux 6.19 merges the deadline-aware scheduler rework",
		org: "Linux Kernel",
		repo: "torvalds/linux",
		sub: "linux",
		outlet: "LWN",
		detail:
			"The 6.19 merge window took the deadline-aware fair scheduler rework, which replaces the vruntime heuristic for latency-sensitive tasks with an explicit per-task deadline.",
		impact:
			"Interactive and audio workloads get bounded latency without the tuning ritual that scheduler-sensitive deployments have relied on.",
		context: "Benchmarks on throughput-bound server workloads show a 1 to 2% regression in some configurations.",
		roles: [
			r("github", "linux: merge deadline-aware fair scheduler for 6.19"),
			r("media", "Deadline-aware scheduling lands in Linux 6.19"),
			r("hackernews", "The 6.19 scheduler rework finally kills vruntime tuning"),
			r("reddit", "Ran the 6.19 scheduler on our audio box and jitter dropped by half"),
		],
		primary: ["github"],
	},
	// ------------------------------- 2026-09-11 -----------------------------
	{
		key: "std-agent-protocol",
		date: "2026-09-11",
		changeType: "NEW",
		important: true,
		section: "AI_LLM",
		canonicalTitle: "Four vendors publish a shared tool-invocation protocol",
		org: "Open Tooling Consortium",
		repo: "open-tooling/otp-spec",
		sub: "LocalLLaMA",
		outlet: "TechCrunch",
		detail:
			"Four model vendors published a common wire format for tool invocation, including a capability negotiation handshake and a mandatory per-call resource budget field.",
		impact:
			"A shared wire format removes the per-vendor adapter layer that every agent framework currently maintains, if the vendors actually ship it.",
		context: "Two of the four have shipped implementations; the other two list it as planned.",
		roles: [
			r("official", "Introducing the Open Tooling Protocol 1.0"),
			r("github", "otp-spec: 1.0 release with capability negotiation and resource budgets"),
			r("hackernews", "Four vendors agreed on a tool-calling format, which is two more than I expected"),
			r("reddit", "OTP 1.0 read-through: the resource budget field is the interesting bit"),
		],
		primary: ["official", "github"],
	},
	{
		key: "std-supply-chain",
		date: "2026-09-11",
		changeType: "NEW",
		important: true,
		section: "MUST_KNOW",
		canonicalTitle: "Credential-stealing payload found in nine popular build plugins",
		org: "Registry Security",
		repo: "registry-sec/advisories",
		sub: "netsec",
		outlet: "BleepingComputer",
		detail:
			"Nine build plugins with a combined 4.2 million weekly downloads shipped a post-install script that exfiltrated CI environment variables to a single collector host for roughly nineteen hours.",
		impact:
			"Any pipeline that installed in that window should treat its CI secrets as disclosed, which is a rotation task, not a patch task.",
		context: "The malicious versions have been unpublished and the collector host is sinkholed.",
		roles: [
			r("official", "Advisory: malicious post-install scripts in nine build plugins"),
			r("github", "advisories: add GHSA entries for the nine affected plugins"),
			r("hackernews", "Nineteen hours of CI secrets went to one collector host"),
			r("media", "Build plugin compromise exposes CI credentials"),
		],
		primary: ["official"],
	},
	{
		key: "std-fusion-round",
		date: "2026-09-11",
		changeType: "NEW",
		important: true,
		section: "COMPANIES",
		canonicalTitle: "Halcyon Fusion raises 1.4 billion dollars against a 2031 grid date",
		org: "Halcyon Fusion",
		sub: "energy",
		outlet: "Financial Times",
		detail:
			"Halcyon Fusion raised 1.4 billion dollars in a round that includes two utilities as strategic investors and a power purchase agreement contingent on delivery by 2031.",
		impact:
			"A contingent power purchase agreement is a harder commitment than a funding round, and it is the first one attached to a fusion programme.",
		context: "The company has not yet demonstrated net facility energy gain.",
		roles: [
			r("official", "Halcyon Fusion closes Series D"),
			r("media", "Utilities back fusion developer with contingent offtake deal"),
			r("hackernews", "The offtake agreement matters more than the 1.4 billion"),
			r("analysis", "Contingent offtake as a discipline device for fusion timelines"),
		],
		primary: ["official"],
	},
	{
		key: "std-exchange-halt",
		date: "2026-09-11",
		changeType: "NEW",
		important: true,
		section: "CRYPTO_MARKET",
		canonicalTitle: "Meridian Exchange halts withdrawals citing a custodian reconciliation gap",
		org: "Meridian Exchange",
		sub: "CryptoCurrency",
		outlet: "CoinDesk",
		detail:
			"Meridian Exchange suspended all withdrawals after a reconciliation against its qualified custodian showed a 340 million dollar discrepancy between internal ledger balances and attested holdings.",
		impact:
			"A reconciliation gap of that size is either an accounting failure or a solvency failure, and the exchange has not said which.",
		context: "Deposits remain open, which several commentators flagged as the wrong sequencing.",
		roles: [
			r("official", "Temporary suspension of withdrawals"),
			r("media", "Meridian Exchange halts withdrawals over 340 million dollar gap"),
			r("hackernews", "Deposits are still open at Meridian Exchange, which tells you something"),
			r("reddit", "Withdrawal queue at Meridian is frozen, mine has been pending 9 hours"),
		],
		primary: ["official"],
	},
	{
		key: "std-ai-act",
		date: "2026-09-11",
		changeType: "NEW",
		important: true,
		section: "MACRO",
		canonicalTitle: "Regulator publishes binding guidance on general-purpose model obligations",
		org: "European Commission",
		sub: "technology",
		outlet: "Politico",
		detail:
			"The guidance sets a compute threshold for systemic-risk classification, requires an incident register with fourteen-day reporting, and defines what counts as a substantial modification by a downstream deployer.",
		impact:
			"The substantial-modification definition is what determines whether a company fine-tuning a model inherits the original provider's obligations.",
		context: "The guidance applies from January and there is no transition period for the incident register.",
		roles: [
			r("official", "Guidance on obligations for providers of general-purpose AI models"),
			r("media", "Brussels sets the line between deployer and provider"),
			r("hackernews", "The substantial modification test is going to catch a lot of fine-tuners"),
			r("analysis", "Reading the systemic-risk compute threshold in practice"),
		],
		primary: ["official"],
	},
	{
		key: "std-robotics-paper",
		date: "2026-09-11",
		changeType: "NEW",
		important: true,
		section: "RESEARCH",
		canonicalTitle: "Manipulation policy transfers across five robot embodiments without retraining",
		org: "Ridgeway University",
		sub: "MachineLearning",
		outlet: "IEEE Spectrum",
		detail:
			"A single policy conditioned on a kinematic description transfers across five distinct arms, retaining 88% of single-embodiment success on unseen hardware with no fine-tuning.",
		impact:
			"Cross-embodiment transfer at that retention rate makes a shared manipulation dataset worth building, which it previously was not.",
		context: "All five arms are 6 or 7 degree-of-freedom; no mobile or bimanual results are reported.",
		roles: [
			r("arxiv", "Kinematics-conditioned policies transfer across robot embodiments zero-shot"),
			r("hackernews", "88% zero-shot transfer across five arms"),
			r("reddit", "Cross-embodiment paper: the kinematic conditioning trick is elegant"),
			r("semanticScholar", "Zero-shot cross-embodiment manipulation transfer"),
		],
		primary: ["arxiv"],
	},
	// ------------------------------- 2026-09-12 -----------------------------
	{
		key: "std-inference-chip",
		date: "2026-09-12",
		changeType: "NEW",
		important: true,
		section: "AI_LLM",
		canonicalTitle: "Tessellate ships an inference part with 6 terabytes per second of memory bandwidth",
		org: "Tessellate",
		repo: "tessellate/tessellate-runtime",
		sub: "hardware",
		outlet: "AnandTech",
		detail:
			"Tessellate announced an inference accelerator with 6 terabytes per second of memory bandwidth and 288 gigabytes of capacity per package, shipping to cloud partners this quarter.",
		impact:
			"Memory bandwidth, not arithmetic, sets decode throughput, so a 1.7x bandwidth step translates almost directly into tokens per second.",
		context: "Independent benchmarks are not yet available and the announced price is per-package, not per-system.",
		roles: [
			r("official", "Announcing the Tessellate T400 inference accelerator"),
			r("github", "tessellate-runtime: add T400 backend and bandwidth-aware kv cache layout"),
			r("hackernews", "6 TB/s is the number that matters for decode"),
			r("reddit", "T400 specs are out and the capacity per package is the surprise"),
		],
		primary: ["official"],
	},
	{
		key: "std-k8s-release",
		date: "2026-09-12",
		changeType: "NEW",
		important: true,
		section: "DEVELOPER_OSS",
		canonicalTitle: "Kubernetes 1.36 graduates in-place pod resize to stable",
		org: "Kubernetes",
		repo: "kubernetes/kubernetes",
		sub: "kubernetes",
		outlet: "The New Stack",
		detail:
			"Kubernetes 1.36 promotes in-place pod vertical resize to stable, removes the in-tree cloud provider shims entirely, and deprecates the legacy endpoints API.",
		impact:
			"In-place resize removes the restart that vertical autoscaling has always cost, which changes what workloads can be autoscaled at all.",
		context: "Clusters still relying on in-tree cloud providers cannot upgrade without migrating first.",
		roles: [
			r("official", "Kubernetes v1.36: release announcement"),
			r("github", "kubernetes v1.36.0: in-place pod resize GA, in-tree providers removed"),
			r("hackernews", "In-place pod resize is finally stable"),
			r("reddit", "1.36 removed the in-tree providers and our upgrade plan just doubled"),
		],
		primary: ["official", "github"],
	},
	{
		key: "std-cb-pause",
		date: "2026-09-12",
		changeType: "NEW",
		important: true,
		section: "MACRO",
		canonicalTitle: "Central bank signals an extended pause after the inflation print",
		org: "Reserve Board",
		sub: "economics",
		outlet: "Reuters",
		detail:
			"Two governors said in prepared remarks that the policy rate is likely to stay at its current level through at least the first quarter, explicitly citing the shelter deceleration in the morning's inflation data.",
		impact:
			"The explicit link to the data release converts the print from a data point into a policy signal for the next two meetings.",
		context: "The remarks are individual governor views, not a committee statement.",
		roles: [
			r("official", "Remarks on the policy outlook"),
			r("media", "Governors point to an extended hold"),
			r("hackernews", "Rates are on hold and the shelter component is the stated reason"),
			r("reddit", "Two governors on the same day is not a coincidence"),
		],
		primary: ["official"],
	},
	{
		key: "std-biotech-approval",
		date: "2026-09-12",
		changeType: "NEW",
		important: true,
		section: "COMPANIES",
		canonicalTitle: "Regulator approves Larkspur Bio's oral therapy with a boxed warning",
		org: "Larkspur Bio",
		sub: "biotech",
		outlet: "STAT",
		detail:
			"The regulator approved Larkspur Bio's oral therapy for a rare metabolic disorder but attached a boxed warning for hepatic injury and required a post-marketing registry.",
		impact:
			"The boxed warning narrows the realistic prescribing population well below the company's addressable-market slide.",
		context: "Pricing has not been announced and the registry requirement adds an ongoing compliance cost.",
		roles: [
			r("official", "Approval letter and prescribing information"),
			r("sec", "Larkspur Bio Inc. Form 8-K, Item 8.01 regulatory approval"),
			r("media", "Larkspur therapy approved with a boxed warning"),
			r("hackernews", "The boxed warning is doing a lot of work in this approval"),
		],
		primary: ["official", "sec"],
	},
	{
		key: "std-bridge-exploit",
		date: "2026-09-12",
		changeType: "NEW",
		important: true,
		section: "CRYPTO_MARKET",
		canonicalTitle: "Cross-chain bridge drained of 190 million dollars via a signature replay",
		org: "Keelson Bridge",
		repo: "keelson/keelson-contracts",
		sub: "CryptoCurrency",
		outlet: "CoinDesk",
		detail:
			"An attacker replayed validator signatures from a deprecated message format to mint wrapped assets on the destination chain without a matching lock, draining roughly 190 million dollars over forty minutes.",
		impact:
			"The deprecated format was still accepted by the verifier contract, which is a decommissioning failure rather than a cryptographic one.",
		context: "The bridge is paused and one exchange has frozen 31 million dollars of the outflow.",
		roles: [
			r("official", "Incident report: unauthorised minting on the destination chain"),
			r("github", "keelson-contracts: reject deprecated message format in verifier"),
			r("hackernews", "The old message format was never removed from the verifier"),
			r("media", "Bridge loses 190 million dollars to signature replay"),
		],
		primary: ["official"],
	},
	{
		key: "std-contamination",
		date: "2026-09-12",
		changeType: "NEW",
		important: true,
		section: "RESEARCH",
		canonicalTitle: "Audit finds benchmark contamination in widely cited evaluation suites",
		org: "Kestrel Institute",
		repo: "kestrel-inst/contam-audit",
		sub: "MachineLearning",
		outlet: "Quanta",
		detail:
			"An n-gram and paraphrase audit of six standard evaluation suites finds that between 4% and 31% of test items appear in common pretraining corpora, with the worst contamination in the two most cited suites.",
		impact:
			"Reported scores on the affected suites are not comparable across models trained on different corpus snapshots, which undercuts a large body of published comparisons.",
		context: "The audit tooling and the contaminated item lists are released alongside the paper.",
		roles: [
			r("arxiv", "Measuring test-set contamination in six standard evaluation suites"),
			r("github", "contam-audit: released contaminated item lists and detection tooling"),
			r("hackernews", "31% contamination in the suite everyone quotes"),
			r("reddit", "We need to stop citing these benchmarks until they are rebuilt"),
		],
		primary: ["arxiv"],
	},
];

export const EVENTS: EventSpec[] = [
	...ARC_EVENTS,
	...TREND_EVENTS,
	...ROUTINE_EVENTS,
	...STANDALONE_EVENTS,
];

/** The aggregate-only signal: no item names it, gold knows which events carry it. */
export const EMERGING_SIGNALS: { date: DateKey; label: string; eventKeys: string[] }[] = [
	{
		date: "2026-09-10",
		label: "Electrical power is becoming the binding constraint on compute capacity",
		eventKeys: ["trend-power-a", "trend-power-b"],
	},
	{
		date: "2026-09-11",
		label: "Electrical power is becoming the binding constraint on compute capacity",
		eventKeys: ["trend-power-c", "trend-power-d"],
	},
	{
		date: "2026-09-12",
		label: "Electrical power is becoming the binding constraint on compute capacity",
		eventKeys: ["trend-power-e", "trend-power-f"],
	},
];

/** Crypto tickers that produce pure-noise ordinary-volatility items every day. */
export const CRYPTO_ASSETS: { symbol: string; name: string; basePrice: number }[] = [
	{ symbol: "BTC", name: "Bitcoin", basePrice: 71240 },
	{ symbol: "ETH", name: "Ethereum", basePrice: 3810 },
	{ symbol: "SOL", name: "Solana", basePrice: 186.4 },
	{ symbol: "AVAX", name: "Avalanche", basePrice: 32.75 },
	{ symbol: "LINK", name: "Chainlink", basePrice: 19.08 },
	{ symbol: "DOGE", name: "Dogecoin", basePrice: 0.187 },
];

export interface NoiseTemplate {
	sourceType: SourceType;
	sourceName: string;
	title: string;
	summary: string;
}

/** Irrelevant consumer, lifestyle and low-signal content. */
export const NOISE_TEMPLATES: NoiseTemplate[] = [
	{ sourceType: "rss", sourceName: "Gadget Weekly", title: "The 14 best wireless earbuds you can buy this autumn", summary: "A refreshed buying guide with affiliate links and no new testing since spring." },
	{ sourceType: "rss", sourceName: "Gadget Weekly", title: "This robot vacuum is 40% off for one more day", summary: "A time-limited retail promotion on a two-year-old model." },
	{ sourceType: "rss", sourceName: "Lifestyle Daily", title: "Nine sheet-pan dinners that take under thirty minutes", summary: "Seasonal recipe roundup aimed at weeknight cooking." },
	{ sourceType: "rss", sourceName: "Lifestyle Daily", title: "How to actually keep a houseplant alive in a north-facing flat", summary: "Light and watering advice for low-light apartments." },
	{ sourceType: "rss", sourceName: "Sports Desk", title: "Late equaliser keeps the title race alive going into the break", summary: "Match report from last night's fixture." },
	{ sourceType: "rss", sourceName: "Sports Desk", title: "Transfer window closes with three deadline-day moves", summary: "Summary of completed transfers and fees." },
	{ sourceType: "rss", sourceName: "Screen Report", title: "The streaming series everyone will be arguing about this weekend", summary: "Television review with no industry or business angle." },
	{ sourceType: "rss", sourceName: "Screen Report", title: "Box office: sequel opens softer than tracking suggested", summary: "Weekend box office figures for a film franchise." },
	{ sourceType: "rss", sourceName: "Auto Trends", title: "First drive: the updated compact crossover is fine, mostly", summary: "Consumer vehicle review covering ride and interior." },
	{ sourceType: "rss", sourceName: "Auto Trends", title: "Five things to check before a long autumn drive", summary: "Routine seasonal vehicle maintenance checklist." },
	{ sourceType: "rss", sourceName: "Travel Notes", title: "A long weekend in a city you have probably overlooked", summary: "Destination piece with hotel and restaurant suggestions." },
	{ sourceType: "rss", sourceName: "Travel Notes", title: "Airline adds a seasonal route for the winter schedule", summary: "Route announcement for leisure travellers." },
	{ sourceType: "rss", sourceName: "Home Ideas", title: "Small bathroom renovations that do not need planning permission", summary: "Home improvement ideas and rough cost ranges." },
	{ sourceType: "rss", sourceName: "Wellness Digest", title: "Does the ten thousand step target actually mean anything?", summary: "General wellness explainer referencing older observational studies." },
	{ sourceType: "rss", sourceName: "Wellness Digest", title: "Six stretches for people who sit all day", summary: "Illustrated stretching routine." },
	{ sourceType: "rss", sourceName: "Retail Watch", title: "Supermarket loyalty schemes compared", summary: "Consumer price comparison of grocery loyalty programmes." },
	{ sourceType: "web", sourceName: "Deals Roundup", title: "Every laptop discount worth looking at right now", summary: "Aggregated retail discounts refreshed daily." },
	{ sourceType: "web", sourceName: "Listicle Central", title: "21 kitchen gadgets under fifty that people swear by", summary: "Product listicle with affiliate links." },
	{ sourceType: "web", sourceName: "Listicle Central", title: "The ultimate guide to organising a small wardrobe", summary: "Storage and decluttering advice." },
	{ sourceType: "web", sourceName: "Local Bulletin", title: "Roadworks on the ring road extended by two weeks", summary: "Local transport notice affecting one city." },
	{ sourceType: "web", sourceName: "Local Bulletin", title: "Weekend market returns to the town square", summary: "Community events notice." },
	{ sourceType: "web", sourceName: "Weather Desk", title: "Unseasonably mild week ahead before a cold snap", summary: "Regional weather forecast." },
	{ sourceType: "reddit", sourceName: "r/gaming", title: "Patch notes are up and they nerfed the shotgun again", summary: "Community reaction to a live-service game balance patch." },
	{ sourceType: "reddit", sourceName: "r/gaming", title: "What is everyone playing this weekend?", summary: "Recurring weekend discussion thread." },
	{ sourceType: "reddit", sourceName: "r/mildlyinteresting", title: "My local cafe writes the wifi password in a different language every day", summary: "Photo post with no technical content." },
	{ sourceType: "reddit", sourceName: "r/AskReddit", title: "What is a small purchase that noticeably improved your life?", summary: "Open-ended discussion thread." },
	{ sourceType: "reddit", sourceName: "r/food", title: "Made pasta from scratch for the first time", summary: "Photo post of a home-cooked meal." },
	{ sourceType: "reddit", sourceName: "r/DIY", title: "Built a bookshelf from reclaimed scaffold boards", summary: "Woodworking project write-up with photos." },
	{ sourceType: "youtube", sourceName: "YouTube", title: "I tried every coffee machine under three hundred", summary: "Consumer product comparison video." },
	{ sourceType: "youtube", sourceName: "YouTube", title: "Cleaning a keyboard that has not been cleaned in four years", summary: "Satisfying cleaning video with no technical content." },
	{ sourceType: "youtube", sourceName: "YouTube", title: "Cosy autumn desk setup tour", summary: "Desk aesthetics video." },
	{ sourceType: "hackernews", sourceName: "Hacker News", title: "Ask HN: what chair are you using?", summary: "Recurring low-signal furniture thread." },
	{ sourceType: "hackernews", sourceName: "Hacker News", title: "The history of the paperclip (2011)", summary: "Reposted historical curiosity from fifteen years ago." },
	{ sourceType: "hackernews", sourceName: "Hacker News", title: "Show HN: I made a website that tells you if it is Tuesday", summary: "Single-purpose novelty site." },
	{ sourceType: "hackernews", sourceName: "Hacker News", title: "Why I switched my terminal font again", summary: "Personal blog post about editor aesthetics." },
	{ sourceType: "rss", sourceName: "Culture Column", title: "The return of the very long album", summary: "Music criticism piece." },
	{ sourceType: "rss", sourceName: "Culture Column", title: "A museum show that rewards a second visit", summary: "Exhibition review." },
	{ sourceType: "rss", sourceName: "Pet Corner", title: "Signs your cat is bored and what to do about it", summary: "Pet behaviour advice." },
	{ sourceType: "web", sourceName: "Coupon Feed", title: "Promo codes that still work this week", summary: "Aggregated discount codes." },
	{ sourceType: "web", sourceName: "Horoscope Hub", title: "Your week ahead, by star sign", summary: "Astrology column." },
	{ sourceType: "rss", sourceName: "Gardening Monthly", title: "What to plant now for an early spring", summary: "Seasonal planting calendar." },
	{ sourceType: "rss", sourceName: "Sports Desk", title: "Marathon organisers announce a new qualifying window", summary: "Amateur athletics scheduling notice." },
];
