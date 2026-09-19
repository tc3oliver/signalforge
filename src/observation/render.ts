import type { AuditTally } from "./audit.ts";
import type { AttributionResult } from "./attribution.ts";
import type { ContinuityMetrics, ContinuityVerdict, SignalObservation } from "./continuity.ts";
import type { Epoch, EpochAggregationCheck } from "./epoch.ts";
import { REQUIRED_CLEAN_DAYS } from "./epoch.ts";
import type { TopicFunnel } from "./funnel.ts";
import type { RoutingReadiness, TriageFunnel } from "./triage-funnel.ts";
import type { ScreeningFunnel, ScreeningReadiness, StageUsage } from "./screening-funnel.ts";
import type { ModelChainRow } from "./queries.ts";
import { AMPLIFICATION, CHARS_PER_PROMPT_TOKEN, type LedgerPair, type LedgerTelemetry } from "./story-ledger.ts";

/*
 * Plain text, not Markdown or JSON: this is read in a terminal next to the
 * manual review sheet, and it is pasted into the five-day report by hand. The
 * numbers it prints are whatever the rows said -- nothing here rounds a rate
 * into a verdict or omits a bucket because it was empty, because an empty
 * bucket is usually the finding.
 */

function bar(label: string, value: string | number, width = 28): string {
	return `${label.padEnd(width)}${value}`;
}

function pct(value: number | null): string {
	return value === null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

export function renderEpochs(check: EpochAggregationCheck, current: Epoch | undefined): string {
	const lines = ["## Intelligence epochs", ""];
	for (const epoch of check.epochs) {
		const version = epoch.profileVersion ?? "(none — pre-personalization)";
		lines.push(`${epoch.id}`);
		lines.push(`  profile version  ${version}`);
		lines.push(`  dates            ${epoch.startedAt} .. ${epoch.endedAt} (${epoch.days} day(s))`);
		if (epoch === current) {
			const remaining = Math.max(0, REQUIRED_CLEAN_DAYS - epoch.days);
			lines.push(
				`  status           current epoch; ${epoch.days}/${REQUIRED_CLEAN_DAYS} clean days` +
					(remaining > 0 ? ` (${remaining} more before it is a baseline)` : " — baseline complete"),
			);
		} else {
			lines.push("  status           closed; historical reference only");
		}
		lines.push("");
	}
	if (!check.ok) {
		lines.push("AGGREGATION REFUSED");
		lines.push(`  ${check.refusal}`);
		lines.push("");
	}
	return lines.join("\n");
}

export function renderFunnel(funnel: TopicFunnel): string {
	const lines = ["## Topic funnel", ""];
	lines.push("A story counts towards every topic it carries, so rows do not sum to the total.");
	lines.push("");
	lines.push(
		`${"topic".padEnd(24)}${"weight".padEnd(8)}${"cand".padEnd(7)}${"matl".padEnd(7)}${"final".padEnd(7)}mustKnow`,
	);
	for (const row of funnel.rows) {
		lines.push(
			row.label.slice(0, 23).padEnd(24) +
				row.weight.toFixed(2).padEnd(8) +
				String(row.candidateStories).padEnd(7) +
				String(row.materialStories).padEnd(7) +
				String(row.finalStories).padEnd(7) +
				String(row.mustKnowStories),
		);
	}
	lines.push("");
	lines.push(bar("candidate stories total", funnel.totalCandidates));
	lines.push(bar("carrying no topic", funnel.untagged));
	for (const stage of funnel.unavailableStages) {
		lines.push(`unavailable: ${stage}`);
	}
	return lines.join("\n");
}

export function renderAudit(tallies: readonly AuditTally[]): string {
	const lines = ["## AI Engineering vs AI Business", ""];
	lines.push("Audit grouping only. config/observation-audit.yaml is read by this report and nothing else;");
	lines.push("it does not reach the Curator or the Editor and does not influence selection.");
	lines.push("");
	const published = tallies.reduce((sum, t) => sum + t.stories, 0);
	// The labels carry the definition of each bucket, so they are printed whole
	// and the counts go underneath. Truncating them to keep one line would hide
	// exactly the part a reader needs to judge whether the split means anything.
	for (const tally of tallies) {
		const share = published === 0 ? "n/a" : `${((tally.stories / published) * 100).toFixed(0)}%`;
		lines.push(tally.label);
		lines.push(`  ${bar("stories in brief", `${tally.stories}  (${share})`, 20)}`);
		lines.push(`  ${bar("of them must-know", tally.mustKnow, 20)}`);
	}
	lines.push("");
	lines.push(bar("published stories", published));
	const unclassified = tallies.find((t) => t.bucket === "UNCLASSIFIED")?.stories ?? 0;
	if (published > 0 && unclassified / published > 0.3) {
		lines.push("");
		lines.push(
			`NOTE: ${((unclassified / published) * 100).toFixed(0)}% of published stories could not be classified from`,
		);
		lines.push("their topic ids. The engineering/business ratio is not yet measurable from data alone —");
		lines.push("fill in the two manual fields in the daily review sheet instead of reading the split above.");
	}
	return lines.join("\n");
}

export function renderContinuity(days: readonly ContinuityMetrics[], verdict: ContinuityVerdict): string {
	const lines = ["## Historical intelligence", ""];
	for (const day of days) {
		lines.push(`${day.date}`);
		for (const count of day.counts) lines.push(`  ${bar(count.changeType, count.count, 26)}`);
		lines.push(`  ${bar("Non-NEW continuity rate", pct(day.nonNewRate), 26)}`);
		lines.push("");
	}
	lines.push(verdict.message);
	return lines.join("\n");
}

export function renderSignals(signals: readonly SignalObservation[]): string {
	const lines = ["## Emerging signals", ""];
	if (signals.length === 0) return `${lines.join("\n")}(none)`;
	lines.push("Recorded, not acted on. The WATCHING/EMERGING/STRENGTHENING split stays deferred");
	lines.push("until this has five days of evidence behind it.");
	lines.push("");
	for (const signal of signals) {
		lines.push(`${signal.label} [${signal.state}]`);
		lines.push(`  confidence ${signal.confidence.toFixed(2)}   day span ${signal.daySpan}`);
		lines.push(`  evidence   ${signal.evidenceStories} story/ies across ${signal.evidenceSources} source(s)`);
		lines.push(`  first seen ${signal.firstSeenAt}   last seen ${signal.lastSeenAt}`);
		lines.push("");
	}
	return lines.join("\n");
}

export function renderAttribution(pattern: string, result: AttributionResult): string {
	const lines = [`## Missing-story attribution: "${pattern}"`, ""];
	lines.push(`verdict  ${result.verdict}`);
	lines.push(`meaning  ${result.meaning}`);
	lines.push("");
	lines.push("evidence, in the order the stages were checked:");
	for (const line of result.evidence) lines.push(`  ${line}`);
	return lines.join("\n");
}

/**
 * @param rulesVersion Which pass these funnels describe. Named in the heading
 * because two passes now report side by side, and a recall figure whose pass is
 * unstated is not attributable to anything.
 */
export function renderTriage(
	funnels: readonly TriageFunnel[],
	readiness: RoutingReadiness,
	rulesVersion?: string,
): string {
	const heading = rulesVersion
		? `## Stage 0 triage — ${rulesVersion} (SHADOW MODE — routing unaffected)`
		: "## Stage 0 triage (SHADOW MODE — routing unaffected)";
	const lines = [heading, ""];
	if (funnels.length === 0) {
		lines.push("No triage rows for these days. Nothing to measure yet.");
		return lines.join("\n");
	}
	lines.push("Every item still reached the Curator. These numbers are the counterfactual:");
	lines.push("what a filter that dropped LOW would have cost, measured against real outcomes.");
	lines.push("");

	const total = funnels.reduce((n, f) => n + f.total, 0);
	const merged: Record<string, number> = {};
	for (const f of funnels) {
		for (const [k, v] of Object.entries(f.byCategory)) merged[k] = (merged[k] ?? 0) + v;
	}
	lines.push(bar("items triaged", total));
	for (const category of ["PRIORITY", "NORMAL", "UNCERTAIN", "LOW", "DUPLICATE_HINT"]) {
		const n = merged[category] ?? 0;
		const share = total === 0 ? "n/a" : `${((n / total) * 100).toFixed(1)}%`;
		lines.push(`  ${bar(category, `${n}  (${share})`, 20)}`);
	}
	const undecided = funnels.reduce((n, f) => n + f.undecided, 0);
	if (undecided > 0) {
		lines.push("");
		lines.push(
			bar("predicted, never decided", `${undecided}  (incomplete scan — not a triage result)`),
		);
	}

	lines.push("");
	lines.push("LOW bucket leakage — what a drop would have taken with it:");
	const leak = (pick: (f: TriageFunnel) => number) => funnels.reduce((n, f) => n + pick(f), 0);
	lines.push(`  ${bar("LOW -> CANDIDATE", leak((f) => f.lowLeakage.candidate), 26)}`);
	lines.push(`  ${bar("LOW -> MATERIAL story", leak((f) => f.lowLeakage.materialStories), 26)}`);
	lines.push(`  ${bar("LOW -> FINAL story", leak((f) => f.lowLeakage.finalStories), 26)}`);
	lines.push(`  ${bar("LOW -> MUST KNOW story", leak((f) => f.lowLeakage.mustKnowStories), 26)}`);

	lines.push("");
	lines.push("Recall a LOW-dropping filter would have achieved (story-level except candidate):");
	const showRecall = (label: string, pick: (f: TriageFunnel) => number | null) => {
		const measured = funnels.map(pick).filter((v): v is number => v !== null);
		const value = measured.length === 0 ? "n/a" : `${(Math.min(...measured) * 100).toFixed(1)}% (worst day)`;
		lines.push(`  ${bar(label, value, 26)}`);
	};
	showRecall("candidate recall", (f) => f.recall.candidate);
	showRecall("material recall", (f) => f.recall.material);
	showRecall("final-story recall", (f) => f.recall.final);
	showRecall("must-know recall", (f) => f.recall.mustKnow);

	const lostMustKnow = funnels.flatMap((f) => f.lostMustKnowStoryIds);
	if (lostMustKnow.length > 0) {
		lines.push("");
		lines.push("Must Know stories that would have been lost entirely:");
		for (const id of lostMustKnow) lines.push(`  ${id}`);
	}

	lines.push("");
	lines.push(`Routing readiness: ${readiness.ready ? "GATE MET" : "NOT READY"}`);
	for (const reason of readiness.reasons) lines.push(`  - ${reason}`);
	if (readiness.ready) {
		lines.push("  Evidence supports enabling routing. Enabling it is still a manual decision.");
	}
	return lines.join("\n");
}

export function renderScreening(
	funnels: readonly ScreeningFunnel[],
	readiness: ScreeningReadiness,
	version: { provider: string; model: string; policyVersion: string },
	mode: string,
): string {
	const lines = [`## Screening — ${version.provider}/${version.model} @ ${version.policyVersion} (mode: ${mode})`, ""];
	if (funnels.length === 0) {
		lines.push("No screening rows for these days. Run `pnpm screen --date <day>` to backfill a past day.");
		return lines.join("\n");
	}
	const anyRouted = funnels.some((f) => f.rescued > 0 || f.byVerdict.DROP > f.dropEvaluated + 0);
	lines.push(
		anyRouted
			? "Some DROPs were withheld from the Curator. DROP precision below is measured on the audit sample and on rescues only."
			: "Every item reached the Curator. These numbers are the exact counterfactual of routing on DROP.",
	);
	lines.push("");

	const total = funnels.reduce((n, f) => n + f.total, 0);
	const drops = funnels.reduce((n, f) => n + f.byVerdict.DROP, 0);
	const keeps = funnels.reduce((n, f) => n + f.byVerdict.KEEP, 0);
	const unsure = funnels.reduce((n, f) => n + f.byVerdict.UNSURE, 0);
	const share = (n: number) => (total === 0 ? "n/a" : `${((n / total) * 100).toFixed(1)}%`);
	lines.push(bar("items screened", `${total} over ${funnels.length} day(s)`));
	lines.push(`  ${bar("DROP", `${drops}  (${share(drops)})`, 20)}`);
	lines.push(`  ${bar("KEEP", `${keeps}  (${share(keeps)})`, 20)}`);
	lines.push(`  ${bar("UNSURE", `${unsure}  (${share(unsure)})`, 20)}`);

	lines.push("");
	lines.push("DROP against the Curator's own decision:");
	const evaluated = funnels.reduce((n, f) => n + f.dropEvaluated, 0);
	const agreed = funnels.reduce((n, f) => n + f.dropAgreed, 0);
	const fn = funnels.reduce((n, f) => n + f.dropToCandidate, 0);
	lines.push(`  ${bar("DROPs with a decision", evaluated, 26)}`);
	lines.push(`  ${bar("Curator agreed (IRRELEVANT/DUPLICATE)", agreed, 26)}`);
	lines.push(`  ${bar("Curator made CANDIDATE", fn, 26)}`);
	lines.push(`  ${bar("DROP precision", pct(evaluated === 0 ? null : agreed / evaluated), 26)}`);

	lines.push("");
	lines.push("What a full DROP filter would have taken with it (story-level except candidate):");
	lines.push(`  ${bar("material stories lost", funnels.reduce((n, f) => n + f.lost.materialStories, 0), 26)}`);
	lines.push(`  ${bar("final stories lost", funnels.reduce((n, f) => n + f.lost.finalStories, 0), 26)}`);
	lines.push(`  ${bar("must-know stories lost", funnels.reduce((n, f) => n + f.lost.mustKnowStories, 0), 26)}`);
	const showRecall = (label: string, pick: (f: ScreeningFunnel) => number | null) => {
		const measured = funnels.map(pick).filter((v): v is number => v !== null);
		const value = measured.length === 0 ? "n/a" : `${(Math.min(...measured) * 100).toFixed(1)}% (worst day)`;
		lines.push(`  ${bar(label, value, 26)}`);
	};
	showRecall("candidate recall", (f) => f.recall.candidate);
	showRecall("material recall", (f) => f.recall.material);
	showRecall("final-story recall", (f) => f.recall.final);
	showRecall("must-know recall", (f) => f.recall.mustKnow);

	const lostMustKnow = funnels.flatMap((f) => f.lostMustKnowStoryIds);
	if (lostMustKnow.length > 0) {
		lines.push("");
		lines.push("Must Know stories that would have been lost entirely:");
		for (const id of lostMustKnow) lines.push(`  ${id}`);
	}
	const lostFinal = funnels.flatMap((f) => f.lostFinalStoryIds);
	if (lostFinal.length > 0) {
		lines.push("");
		lines.push("Final stories that would have been lost entirely:");
		for (const id of lostFinal) lines.push(`  ${id}`);
	}

	lines.push("");
	lines.push("Continuous ground truth on a routed day:");
	lines.push(`  ${bar("audit-sampled DROPs", funnels.reduce((n, f) => n + f.auditSampled, 0), 26)}`);
	lines.push(`  ${bar("audit leakage (kept)", funnels.reduce((n, f) => n + f.auditLeakage, 0), 26)}`);
	lines.push(`  ${bar("rescued DROPs", funnels.reduce((n, f) => n + f.rescued, 0), 26)}`);
	lines.push(`  ${bar("rescued -> CANDIDATE", funnels.reduce((n, f) => n + f.rescuedToCandidate, 0), 26)}`);
	const undecided = funnels.reduce((n, f) => n + f.undecidedOffered, 0);
	if (undecided > 0) {
		lines.push(`  ${bar("offered, never decided", `${undecided}  (incomplete scan)`, 26)}`);
	}

	lines.push("");
	lines.push("Per day:");
	// Every recall column, per day, so a day's material loss cannot hide behind
	// a 100% in the final and Must Know columns beside it.
	lines.push(
		`  ${"date".padEnd(12)}${"items".padEnd(7)}${"drop%".padEnd(7)}${"prec".padEnd(7)}${"cand".padEnd(7)}${"matl".padEnd(7)}${"final".padEnd(7)}${"mustKnow".padEnd(10)}lost(matl/final/mk)`,
	);
	for (const f of funnels) {
		lines.push(
			`  ${f.date.padEnd(12)}${String(f.total).padEnd(7)}${pct(f.dropRate).padEnd(7)}${pct(f.dropPrecision).padEnd(7)}${pct(f.recall.candidate).padEnd(7)}${pct(f.recall.material).padEnd(7)}${pct(f.recall.final).padEnd(7)}${pct(f.recall.mustKnow).padEnd(10)}${f.lost.materialStories}/${f.lost.finalStories}/${f.lost.mustKnowStories}`,
		);
	}

	lines.push("");
	const label =
		readiness.verdict === "READY_TO_ROUTE"
			? "READY TO ROUTE"
			: readiness.verdict === "NOT_WORTH_ROUTING"
				? "NOT WORTH ROUTING"
				: "KEEP SHADOWING";
	lines.push(`Routing verdict: ${label}  (${readiness.evaluatedItems} evaluated items over ${readiness.days} day(s))`);
	for (const reason of readiness.reasons) lines.push(`  - ${reason}`);
	if (readiness.verdict === "READY_TO_ROUTE") {
		lines.push(
			`  Evidence supports routing on ${version.model} @ ${version.policyVersion}. Enabling it is a manual edit of config/agent.yaml (mode: route, routing.trusted*).`,
		);
	}
	return lines.join("\n");
}

export function renderStageUsage(usage: readonly StageUsage[], screenedItems: number, curatorItems: number): string {
	const lines = ["## Model usage by stage (provider-reported; never estimated)", ""];
	if (usage.length === 0) return `${lines.join("\n")}(no attempts)`;
	lines.push(`${"stage".padEnd(10)}${"attempts".padEnd(10)}${"wall".padEnd(9)}${"input".padEnd(12)}${"output".padEnd(10)}${"cacheRead".padEnd(12)}total`);
	for (const u of usage) {
		const wall = `${Math.round(u.wallClockMs / 1000)}s`;
		if (u.reported === 0) {
			lines.push(`${u.stage.padEnd(10)}${String(u.attempts).padEnd(10)}${wall.padEnd(9)}usage unavailable (no attempt reported it)`);
			continue;
		}
		const partial = u.reported < u.attempts ? ` (${u.reported}/${u.attempts} reported)` : "";
		lines.push(
			`${u.stage.padEnd(10)}${String(u.attempts).padEnd(10)}${wall.padEnd(9)}${String(u.input).padEnd(12)}${String(u.output).padEnd(10)}${String(u.cacheRead).padEnd(12)}${u.totalTokens}${partial}`,
		);
	}
	const per = (stage: string, items: number) => {
		const u = usage.find((x) => x.stage === stage);
		if (!u || u.reported === 0 || items === 0) return "n/a";
		return `${Math.round(u.totalTokens / items)} tokens/item`;
	};
	lines.push("");
	lines.push(bar("per screened item", per("SCREENER", screenedItems)));
	lines.push(bar("per Curator item", per("CURATOR", curatorItems)));
	return lines.join("\n");
}

/*
 * The story ledger's own report: what the near-duplicate check did, what the
 * id-only story list saved, and which pairs survived to the ledger anyway.
 *
 * Printed as three separate counts rather than one rate. A fire the model
 * declined is not a false positive on its own -- two similar titles can be two
 * events -- and a pair in the final ledger is not a split event until someone
 * reads the two titles. The report keeps those apart so neither gets credited
 * to the other.
 */
export function renderStoryLedger(input: {
	date: string;
	telemetry: LedgerTelemetry;
	savings: { before: number; after: number; beforeTokens: number; afterTokens: number };
	pairs: LedgerPair[];
	threshold: number;
	storyCount: number;
}): string {
	const { telemetry: t, savings, pairs } = input;
	const lines = [`## Story ledger — ${input.date}`, ""];

	lines.push("list_today_stories");
	lines.push(bar("  calls", `${t.listCalls} (${t.listMatchCalls} with match)`));
	lines.push(bar("  result chars", t.listChars.toLocaleString()));
	lines.push(bar("  largest single result", t.largestList.toLocaleString()));
	lines.push(
		bar("  amplified tokens", `${t.listTokens.toLocaleString()} (×${AMPLIFICATION} re-sent, ${CHARS_PER_PROMPT_TOKEN} chars/token)`),
	);
	if (savings.before > 0) {
		const saved = savings.beforeTokens - savings.afterTokens;
		lines.push(
			bar(
				"  same calls with titles",
				`${savings.before.toLocaleString()} chars / ${savings.beforeTokens.toLocaleString()} tokens`,
			),
		);
		lines.push(
			bar("  saved", `${saved.toLocaleString()} tokens (${((1 - savings.after / savings.before) * 100).toFixed(1)}%)`),
		);
	}
	lines.push("");

	lines.push(`todayNear (threshold ${input.threshold})`);
	lines.push(bar("  upserts", t.upserts));
	lines.push(
		bar("  fired", `${t.fires.length}${t.upserts > 0 ? ` (${((100 * t.fires.length) / t.upserts).toFixed(1)}% of upserts)` : ""}`),
	);
	lines.push(bar("  merged into the candidate", t.accepted));
	lines.push(bar("  wrote a new story anyway", t.declined));
	if (t.fires.length > 0) {
		lines.push("");
		lines.push("  story                                    top candidate                            score  merged");
		for (const f of t.fires) {
			lines.push(
				`  ${f.storyId.slice(0, 38).padEnd(40)} ${f.top.slice(0, 38).padEnd(40)} ${f.score.toFixed(2).padStart(5)}  ${f.accepted ? "yes" : "no"}`,
			);
		}
	}
	lines.push("");

	lines.push(`Residual pairs in the ledger (${input.storyCount} stories, overlap ≥ ${input.threshold})`);
	if (pairs.length === 0) {
		lines.push("  none");
	} else {
		lines.push(`  ${pairs.length} pair(s). Read the two titles; token overlap cannot tell a follow-up from a neighbour.`);
		for (const p of pairs) {
			lines.push("");
			lines.push(`  ${p.score.toFixed(2)}${p.sharesSource ? "  shares a source item" : ""}`);
			lines.push(`    ${p.storyId}`);
			lines.push(`      ${p.title}`);
			lines.push(`    ${p.otherStoryId}`);
			lines.push(`      ${p.otherTitle}`);
		}
	}
	return lines.join("\n");
}

/**
 * The model chain, per stage: who did the work and who only failed.
 *
 * Prints a line of its own when a model's failures were all silent — zero
 * provider-reported tokens — because that is not a model doing badly, it is a
 * provider that is not there, and the only way it ever shows up is that
 * everything downstream quietly runs on the expensive fallback.
 */
export function renderModelChain(rows: ModelChainRow[]): string {
	const lines = ["## Model chain", ""];
	if (rows.length === 0) {
		lines.push("No attempts recorded.");
		return lines.join("\n");
	}
	lines.push("stage    model                                    att  ok  yld  fail  silent      tokens");
	for (const r of rows) {
		lines.push(
			`${r.stage.padEnd(8)} ${`${r.provider}/${r.model}`.slice(0, 38).padEnd(40)} ` +
				`${String(r.attempts).padStart(3)} ${String(r.succeeded).padStart(3)} ${String(r.yielded).padStart(4)} ` +
				`${String(r.failed).padStart(5)} ${String(r.silent).padStart(7)} ${r.totalTokens.toLocaleString().padStart(11)}`,
		);
	}
	const dead = rows.filter((r) => r.attempts > 0 && r.silent === r.attempts);
	if (dead.length > 0) {
		lines.push("");
		for (const r of dead) {
			lines.push(
				`!! ${r.provider}/${r.model} answered nothing on all ${r.attempts} ${r.stage} attempt(s): zero`,
			);
			lines.push(
				"   provider-reported tokens, so it never ran. Every token below it in the chain",
			);
			lines.push(
				"   was spent because this model was unavailable, not because it was unsuitable.",
			);
		}
	}
	return lines.join("\n");
}
