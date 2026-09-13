import Link from "next/link";
import type { ChangeRowView } from "../../lib/dashboard.ts";
import { ChangeBadge } from "../badges.tsx";

/**
 * One line per story that changed, strongest change first. On a day when the
 * ledger recorded no movement the section says so, rather than being padded
 * with something that did not change.
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
				<ul className="change-list">
					{rows.map((row) => (
						<li key={row.storyId}>
							<ChangeBadge type={row.changeType} />
							<Link href={`/story/${encodeURIComponent(row.storyId)}`}>{row.title}</Link>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
