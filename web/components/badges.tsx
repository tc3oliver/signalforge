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
 * State primitives for the whole reader. Every one carries its meaning as
 * text, so nothing is conveyed by colour alone; the colour only reinforces a
 * word that is already on the page.
 *
 * The reader is Traditional Chinese. Enum values (NEW, HIGH, …) never reach the
 * page: the short form is shown, the full form goes in the tooltip.
 *
 * Only importance is still a chip, and only where it is genuinely categorical
 * (the full brief, admin). Change type is a coloured word with a dot;
 * confidence is a quiet phrase. Reader pages should not stack chips.
 */

export function ChangeBadge({ type }: { type: ChangeType | undefined }) {
	if (type === undefined) return null;
	return (
		<span className={`change change-${type.toLowerCase()}`} title={changeTypeLabel(type)}>
			{changeTypeShortLabel(type)}
		</span>
	);
}

/** The CSS class that colours a timeline dot for this change type. */
export function changeClass(type: ChangeType | undefined): string {
	return type === undefined ? "" : `change-${type.toLowerCase()}`;
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
	return <span className={`confidence confidence-${level.toLowerCase()}`}>{confidenceLabel(level)}</span>;
}

/** "3 個來源 →" linking to where the sources are actually listed. */
export function SourceCount({ count, href }: { count: number; href: string }) {
	return (
		<Link href={href} className="source-count">
			{count} 個來源 <span aria-hidden="true">→</span>
		</Link>
	);
}
