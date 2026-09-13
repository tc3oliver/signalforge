import Link from "next/link";
import { Tag } from "../../components/bits.tsx";
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
		<>
			<h1>歷史</h1>
			<p className="dateline">共 {briefs.length} 天 · 由新到舊</p>
			<ol className="timeline">
				{briefs.map((brief) => (
					<li key={brief.date}>
						<strong>
							<Link href={`/brief/${brief.date}`}>{formatDateKey(brief.date)}</Link>
						</strong>
						{brief.headline ? <div>{brief.headline}</div> : null}
						<div className="meta">
							<span>{brief.storyCount} 則事件</span>
							{brief.mustKnowCount > 0 ? (
								<Tag tone="accent">{brief.mustKnowCount} 則必看</Tag>
							) : null}
							{brief.signalCount > 0 ? <Tag>{brief.signalCount} 個趨勢</Tag> : null}
							<span className="host">整理於 {formatInstant(brief.producedAt)}</span>
						</div>
						{brief.sections.length > 0 ? (
							<div className="meta">
								{brief.sections.map((section) => (
									<Tag key={section}>{sectionLabel(section)}</Tag>
								))}
							</div>
						) : null}
					</li>
				))}
			</ol>
		</>
	);
}
