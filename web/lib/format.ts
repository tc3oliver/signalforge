import type { ConfidenceLevel } from "../../src/schemas/brief.ts";
import type { ChangeType, StoryStatus } from "../../src/schemas/story.ts";
import type { Disposition } from "../../src/schemas/decision.ts";
import type { SignalState } from "../../src/db/signals.ts";
import { reportingZone, zoneOffsetMs } from "../../src/runtime/local-day.ts";

/*
 * Every formatter here is pure and locale-independent. `toLocaleString` would
 * resolve differently on the server and in the browser and produce a hydration
 * mismatch, so dates are assembled by hand instead.
 *
 * Instants are shown in the reporting zone — the one the pipeline keys its
 * days on (`DI_TIMEZONE`, see `src/runtime/local-day.ts`) — because the
 * person reading "整理於 05:52" is standing in that zone, not in UTC. The zone
 * is an explicit argument with the configured default, so a test can pin it
 * and a page never depends on the machine's TZ.
 */

/** How a zone is named next to a time. Anything unlisted shows its IANA name. */
const ZONE_LABELS: Record<string, string> = {
	"Asia/Taipei": "台北",
	UTC: "UTC",
};

/** The label the pages print after a wall-clock time, e.g. "台北". */
export function zoneLabel(zone: string = reportingZone()): string {
	return ZONE_LABELS[zone] ?? zone;
}

/** `at` shifted so that its UTC getters read as wall-clock time in `zone`. */
function wallClock(at: Date, zone: string): Date {
	return new Date(at.getTime() + zoneOffsetMs(at, zone));
}

export interface ConfidenceDisplay {
	/** The renderer's label, kept identical so the page and the markdown agree. */
	label: string;
	/** Spelled-out level for screen readers and admin tables. */
	level: ConfidenceLevel;
	/** Maps onto the shared Tag tones so confidence reads the same everywhere. */
	tone: "ok" | "warn" | "bad";
}

const CONFIDENCE: Record<ConfidenceLevel, ConfidenceDisplay> = {
	HIGH: { label: "高", level: "HIGH", tone: "ok" },
	MEDIUM: { label: "中", level: "MEDIUM", tone: "warn" },
	LOW: { label: "低", level: "LOW", tone: "bad" },
};

export function confidenceDisplay(level: string): ConfidenceDisplay {
	return CONFIDENCE[level as ConfidenceLevel] ?? { label: level, level: "LOW", tone: "bad" };
}

/*
 * Reader-facing wording. "可信度" is how much the evidence supports the claim,
 * which is what a reader wants to know; "信心" would describe the model's own
 * certainty, which is not the point. The enum never reaches the page.
 */
const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
	HIGH: "可信度高",
	MEDIUM: "可信度中等",
	LOW: "可信度低",
};

export function confidenceLabel(level: string): string {
	return CONFIDENCE_LABEL[level as ConfidenceLevel] ?? level;
}

const IMPORTANCE_LABEL: Record<"HIGH" | "MEDIUM" | "LOW", string> = {
	HIGH: "重要",
	MEDIUM: "一般",
	LOW: "次要",
};

export function importanceLabel(level: string): string {
	return IMPORTANCE_LABEL[level as "HIGH" | "MEDIUM" | "LOW"] ?? level;
}

/** Ledger confidence is a 0..1 score; the brief uses three buckets. */
export function confidenceLevelFromScore(score: number): ConfidenceLevel {
	if (score >= 0.75) return "HIGH";
	if (score >= 0.45) return "MEDIUM";
	return "LOW";
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** "2026-09-13" -> "2026 年 9 月 13 日（日）". Invalid input is returned unchanged. */
export function formatDateKey(date: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) return date;
	const [, y, m, d] = match;
	const parsed = new Date(`${date}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) return date;
	return `${y} 年 ${Number(m)} 月 ${Number(d)} 日（${WEEKDAYS[parsed.getUTCDay()]}）`;
}

/** "2026-09-13" -> "9 月 13 日 · 星期日", the dashboard's date banner. */
export function formatDateBanner(date: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) return date;
	const m = match[2] ?? "";
	const d = match[3] ?? "";
	const parsed = new Date(`${date}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) return date;
	return `${Number(m)} 月 ${Number(d)} 日 · 星期${WEEKDAYS[parsed.getUTCDay()]}`;
}

/** ISO instant -> "20:29", for a feed that states its zone once in its heading. */
export function formatClock(iso: string | undefined, zone: string = reportingZone()): string {
	if (!iso) return "—";
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return iso;
	const local = wallClock(parsed, zone);
	return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/** ISO instant -> "2026-09-13 14:00 台北". Invalid input is returned unchanged. */
export function formatInstant(iso: string | undefined, zone: string = reportingZone()): string {
	if (!iso) return "—";
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return iso;
	const local = wallClock(parsed, zone);
	return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
		`${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} ${zoneLabel(zone)}`;
}

/** ISO instant -> "14:00 台北", for timestamps inside an already-dated context. */
export function formatTimeOfDay(iso: string | undefined, zone: string = reportingZone()): string {
	if (!iso) return "—";
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return iso;
	const local = wallClock(parsed, zone);
	return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} ${zoneLabel(zone)}`;
}

/**
 * A source name as a reader should see it. Items collected before the
 * Miniflux collector stopped prefixing its feed titles still carry
 * "Miniflux: PANews"; the transport is not the source, so it is dropped here
 * rather than by rewriting stored rows.
 */
export function displaySourceName(name: string): string {
	return name.replace(/^Miniflux:\s*/, "");
}

/**
 * 1234567 -> "1,234,567". Grouped by hand for the same reason the dates are:
 * `toLocaleString` resolves against the runtime's locale data, which differs
 * between the server and the browser and produces a hydration mismatch.
 */
export function formatCount(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	// Above 1e21 String() switches to exponential notation, and grouping by
	// character position would render "1e+21" as "1e,+21". No count here reaches
	// that, but a wrong number is worse than an ungrouped one.
	if (!Number.isSafeInteger(Math.trunc(value))) return String(value);
	const negative = value < 0;
	const digits = String(Math.trunc(Math.abs(value)));
	let grouped = "";
	for (let i = 0; i < digits.length; i += 1) {
		if (i > 0 && (digits.length - i) % 3 === 0) grouped += ",";
		grouped += digits[i];
	}
	return negative ? `-${grouped}` : grouped;
}

/** 0.732 -> "73%". Scores in this schema are always 0..1. */
export function formatScore(score: number | undefined): string {
	if (score === undefined || Number.isNaN(score)) return "—";
	return `${Math.round(score * 100)}%`;
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || Number.isNaN(ms)) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${pad(seconds)}s`;
}

/*
 * Change types, presentation only. The ledger enum is untouched; these are the
 * words a reader sees. The full form is used in prose and tooltips, the short
 * form where a badge has no room to wrap.
 */
const CHANGE_TYPE_LABEL: Record<ChangeType, string> = {
	NEW: "新事件",
	UPDATE: "新進展",
	ESCALATION: "情勢升高",
	RESOLUTION: "已告一段落",
	REVERSAL: "出現反轉",
	CONFIRMATION: "已確認",
	RUMOR: "尚未證實",
	NO_MATERIAL_CHANGE: "無實質新進展",
};

const CHANGE_TYPE_SHORT: Record<ChangeType, string> = {
	NEW: "新",
	UPDATE: "更新",
	ESCALATION: "升溫",
	RESOLUTION: "已結束",
	REVERSAL: "反轉",
	CONFIRMATION: "確認",
	RUMOR: "未證實",
	NO_MATERIAL_CHANGE: "無變化",
};

export function changeTypeLabel(value: string): string {
	return CHANGE_TYPE_LABEL[value as ChangeType] ?? value;
}

export function changeTypeShortLabel(value: string): string {
	return CHANGE_TYPE_SHORT[value as ChangeType] ?? value;
}

const STATUS_LABEL: Record<StoryStatus, string> = {
	OPEN: "追蹤中",
	RESOLVED: "已結束",
	DORMANT: "暫無動靜",
};

export function storyStatusLabel(value: string): string {
	return STATUS_LABEL[value as StoryStatus] ?? value;
}

const SIGNAL_STATE_LABEL: Record<SignalState, string> = {
	emerging: "剛浮現",
	strengthening: "持續增強",
	confirmed: "已成形",
	fading: "逐漸淡出",
};

export function signalStateLabel(value: string): string {
	return SIGNAL_STATE_LABEL[value as SignalState] ?? value;
}

/**
 * The reader-facing wording for a disposition. "IRRELEVANT" alone reads as a
 * verdict on the source; the explanation page has to say what the pipeline
 * actually concluded and at which step.
 */
const DISPOSITION_LABEL: Record<Disposition, string> = {
	IRRELEVANT: "Judged not relevant to the profile",
	DUPLICATE: "Folded into an existing story as a duplicate",
	CANDIDATE: "Promoted to a story candidate",
};

export function dispositionLabel(value: string | undefined): string {
	if (value === undefined) return "Never scanned — no decision was recorded";
	return DISPOSITION_LABEL[value as Disposition] ?? value;
}

/*
 * Section names as a Taiwanese engineer would say them. Established technical
 * terms stay in English; "AI / LLM" is the name, not a phrase to translate.
 * The section enum and the markdown renderer's English headings are untouched.
 */
const SECTION_LABEL: Record<string, string> = {
	MUST_KNOW: "今日必看",
	AI_LLM: "AI / LLM",
	DEVELOPER_OSS: "開發工具 / Open Source",
	RESEARCH: "研究",
	CRYPTO_MARKET: "Crypto / Web3",
	MACRO: "總體經濟",
	COMPANIES: "產業動態",
};

export function sectionLabel(value: string): string {
	return SECTION_LABEL[value] ?? value;
}

/** Previous/next day for the brief pager. Pure date arithmetic in UTC. */
export function shiftDateKey(date: string, days: number): string | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
	const parsed = new Date(`${date}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) return undefined;
	parsed.setUTCDate(parsed.getUTCDate() + days);
	return parsed.toISOString().slice(0, 10);
}
