import Link from "next/link";
import { loadBriefHistory } from "../../lib/queries.ts";
import { formatDateKey, formatInstant, sectionLabel } from "../../lib/format.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "歷史 — SignalForge" };

export default async function HistoryPage() {
	const briefs = await loadBriefHistory(120);
	if (briefs.length === 0) {
		return (
			<>
				<h1>歷史</h1>
				<p className="lede">還沒有任何一天的內容。</p>
			</>
		);
	}
	return (
		<div className="ref-history">
			<h1>歷史</h1>
			<p className="dateline">共 {briefs.length} 天 · 由新到舊</p>
			<ol className="timeline">
				{briefs.map((brief) => {
					// One muted line, not three chips: the counts only ever
					// differ by a number, so they read better as a sentence.
					const counts = [`${brief.storyCount} 則事件`];
					if (brief.mustKnowCount > 0) counts.push(`${brief.mustKnowCount} 則必看`);
					if (brief.signalCount > 0) counts.push(`${brief.signalCount} 個趨勢`);
					counts.push(`整理於 ${formatInstant(brief.producedAt)}`);
					return (
						<li key={brief.date}>
							<strong>
								<Link href={`/brief/${brief.date}`}>{formatDateKey(brief.date)}</Link>
							</strong>
							{brief.headline ? <div className="ref-headline">{brief.headline}</div> : null}
							<p className="ref-line">{counts.join(" · ")}</p>
							{brief.sections.length > 0 ? (
								<p className="ref-line">
									{brief.sections.map((section) => sectionLabel(section)).join(" · ")}
								</p>
							) : null}
						</li>
					);
				})}
			</ol>
		</div>
	);
}
