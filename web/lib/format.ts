import type { ConfidenceLevel } from "../../src/schemas/brief.ts";
import type { ChangeType, StoryStatus } from "../../src/schemas/story.ts";
import type { Disposition } from "../../src/schemas/decision.ts";
import type { SignalState } from "../../src/db/signals.ts";

/*
 * Every formatter here is pure and locale-independent. `toLocaleString` would
 * resolve differently on the server and in the browser and produce a hydration
 * mismatch, so dates are assembled by hand in UTC instead.
 */

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

/** Ledger confidence is a 0..1 score; the brief uses three buckets. */
export function confidenceLevelFromScore(score: number): ConfidenceLevel {
	if (score >= 0.75) return "HIGH";
	if (score >= 0.45) return "MEDIUM";
	return "LOW";
}

const MONTHS = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** "2026-09-13" -> "Sun, 13 Sep 2026". Invalid input is returned unchanged. */
export function formatDateKey(date: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) return date;
	const [, y, m, d] = match;
	const parsed = new Date(`${date}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) return date;
	const month = MONTHS[Number(m) - 1] ?? m;
	return `${WEEKDAYS[parsed.getUTCDay()]}, ${Number(d)} ${month} ${y}`;
}

/** "2026-09-13" -> "SEP 13 · SUNDAY", the dashboard's date banner. */
export function formatDateBanner(date: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) return date;
	const m = match[2] ?? "";
	const d = match[3] ?? "";
	const parsed = new Date(`${date}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) return date;
	const month = (MONTHS[Number(m) - 1] ?? m).toUpperCase();
	const weekday = WEEKDAY_LONG[parsed.getUTCDay()] ?? "";
	return `${month} ${Number(d)} · ${weekday.toUpperCase()}`;
}

/** ISO instant -> "12:29", for a feed that states its timezone once in its heading. */
export function formatClock(iso: string | undefined): string {
	if (!iso) return "—";
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return iso;
	return `${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())}`;
}

/** ISO instant -> "13 Sep 2026 06:00 UTC". Invalid input is returned unchanged. */
export function formatInstant(iso: string | undefined): string {
	if (!iso) return "—";
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return iso;
	const month = MONTHS[parsed.getUTCMonth()] ?? "";
	return `${parsed.getUTCDate()} ${month} ${parsed.getUTCFullYear()} ` +
		`${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())} UTC`;
}

/** ISO instant -> "06:00 UTC", for timestamps inside an already-dated context. */
export function formatTimeOfDay(iso: string | undefined): string {
	if (!iso) return "—";
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return iso;
	return `${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())} UTC`;
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

const CHANGE_TYPE_LABEL: Record<ChangeType, string> = {
	NEW: "New",
	UPDATE: "Update",
	ESCALATION: "Escalation",
	RESOLUTION: "Resolution",
	REVERSAL: "Reversal",
	CONFIRMATION: "Confirmation",
	RUMOR: "Rumour",
	NO_MATERIAL_CHANGE: "No material change",
};

export function changeTypeLabel(value: string): string {
	return CHANGE_TYPE_LABEL[value as ChangeType] ?? value;
}

const STATUS_LABEL: Record<StoryStatus, string> = {
	OPEN: "Open",
	RESOLVED: "Resolved",
	DORMANT: "Dormant",
};

export function storyStatusLabel(value: string): string {
	return STATUS_LABEL[value as StoryStatus] ?? value;
}

const SIGNAL_STATE_LABEL: Record<SignalState, string> = {
	emerging: "Emerging",
	strengthening: "Strengthening",
	confirmed: "Confirmed",
	fading: "Fading",
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

const SECTION_LABEL: Record<string, string> = {
	MUST_KNOW: "Must Know",
	AI_LLM: "AI / LLM",
	DEVELOPER_OSS: "Developer / Open Source",
	RESEARCH: "Research",
	CRYPTO_MARKET: "Crypto / Market",
	MACRO: "Macro",
	COMPANIES: "Companies",
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
