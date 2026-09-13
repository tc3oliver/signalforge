import Link from "next/link";
import type { ConfidenceLevel } from "../../src/schemas/brief.ts";
import type { ChangeType } from "../../src/schemas/story.ts";
import type { ImportanceLevel } from "../lib/dashboard.ts";
import {
	changeTypeLabel,
	changeTypeShortLabel,
	confidenceLabel,
	importanceLabel,
} from "../lib/format.ts";

/*
 * One badge system for the whole reader. Every badge carries its meaning as
 * text, so nothing here is conveyed by colour alone; the colour only reinforces
 * a word that is already on the page.
 *
 * The reader is Traditional Chinese. Enum values (NEW, HIGH, …) never reach the
 * page: the short form goes in the badge, the full form in its tooltip.
 */

export function ChangeBadge({ type }: { type: ChangeType | undefined }) {
	if (type === undefined) return null;
	return (
		<span className={`badge change-${type.toLowerCase()}`} title={changeTypeLabel(type)}>
			{changeTypeShortLabel(type)}
		</span>
	);
}

export function ImportanceBadge({ level }: { level: ImportanceLevel | undefined }) {
	if (level === undefined) return null;
	return (
		<span className={`badge importance-${level.toLowerCase()}`}>
			<span className="sr-only">重要程度：</span>
			{importanceLabel(level)}
		</span>
	);
}

export function ConfidenceBadge({ level }: { level: ConfidenceLevel | undefined }) {
	if (level === undefined) return null;
	return (
		<span className={`badge quiet confidence-${level.toLowerCase()}`}>
			{confidenceLabel(level)}
		</span>
	);
}

/** "3 個來源 →" linking to where the sources are actually listed. */
export function SourceCount({ count, href }: { count: number; href: string }) {
	return (
		<Link href={href} className="source-count">
			{count} 個來源 <span aria-hidden="true">→</span>
		</Link>
	);
}
