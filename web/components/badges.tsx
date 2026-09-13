import Link from "next/link";
import type { ConfidenceLevel } from "../../src/schemas/brief.ts";
import type { ChangeType } from "../../src/schemas/story.ts";
import type { ImportanceLevel } from "../lib/dashboard.ts";

/*
 * One badge system for the whole reader. Every badge carries its meaning as
 * text, so nothing here is conveyed by colour alone; the colour only reinforces
 * a word that is already on the page.
 */

const CHANGE_TEXT: Record<ChangeType, string> = {
	NEW: "New",
	UPDATE: "Update",
	ESCALATION: "Escalation",
	RESOLUTION: "Resolved",
	REVERSAL: "Reversal",
	CONFIRMATION: "Confirmed",
	RUMOR: "Rumour",
	NO_MATERIAL_CHANGE: "No change",
};

export function ChangeBadge({ type }: { type: ChangeType | undefined }) {
	if (type === undefined) return null;
	return (
		<span className={`badge change-${type.toLowerCase()}`}>
			{CHANGE_TEXT[type] ?? type}
		</span>
	);
}

export function ImportanceBadge({ level }: { level: ImportanceLevel | undefined }) {
	if (level === undefined) return null;
	return (
		<span className={`badge importance-${level.toLowerCase()}`}>
			<span className="sr-only">Importance </span>
			{level}
		</span>
	);
}

const CONFIDENCE_TEXT: Record<ConfidenceLevel, string> = {
	HIGH: "High confidence",
	MEDIUM: "Medium confidence",
	LOW: "Low confidence",
};

export function ConfidenceBadge({ level }: { level: ConfidenceLevel | undefined }) {
	if (level === undefined) return null;
	return (
		<span className={`badge quiet confidence-${level.toLowerCase()}`}>
			{CONFIDENCE_TEXT[level] ?? level}
		</span>
	);
}

/** "3 sources →" linking to where the sources are actually listed. */
export function SourceCount({ count, href }: { count: number; href: string }) {
	const label = `${count} source${count === 1 ? "" : "s"}`;
	return (
		<Link href={href} className="source-count">
			{label} <span aria-hidden="true">→</span>
		</Link>
	);
}
