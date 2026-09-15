import Link from "next/link";
import type { ChangeRowView } from "../../lib/dashboard.ts";
import { ChangeBadge, changeClass } from "../badges.tsx";

/**
 * One line per story that changed, strongest change first, on the site's
 * timeline rail: a sequence of moments, each dot coloured by its kind of
 * change. On a day when the ledger recorded no movement the section says so,
 * rather than being padded with something that did not change.
 */
export function WhatChanged({ rows }: { rows: readonly ChangeRowView[] }) {
	return (
		<section className="block" aria-labelledby="what-changed">
			<h2 id="what-changed" className="block-label">
				最新變化
			</h2>
			{rows.length === 0 ? (
				<p className="empty">與前一天相比，沒有實質變化。</p>
			) : (
				<ol className="timeline compact">
					{rows.map((row) => (
						<li key={row.storyId} className={changeClass(row.changeType)}>
							<ChangeBadge type={row.changeType} />
							<Link href={`/story/${encodeURIComponent(row.storyId)}`}>{row.title}</Link>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
