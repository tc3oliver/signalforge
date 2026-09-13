import Link from "next/link";
import { Tag } from "../../components/bits.tsx";
import { loadBriefHistory } from "../../lib/queries.ts";
import { formatDateKey, formatInstant, sectionLabel } from "../../lib/format.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "History — SignalForge" };

export default async function HistoryPage() {
	const briefs = await loadBriefHistory(120);
	if (briefs.length === 0) {
		return (
			<>
				<h1>History</h1>
				<p className="lede">No briefs have been published yet.</p>
			</>
		);
	}
	return (
		<>
			<h1>History</h1>
			<p className="dateline">
				{briefs.length} published brief{briefs.length === 1 ? "" : "s"} · newest first
			</p>
			<ol className="timeline">
				{briefs.map((brief) => (
					<li key={brief.date}>
						<strong>
							<Link href={`/brief/${brief.date}`}>{formatDateKey(brief.date)}</Link>
						</strong>
						{brief.headline ? <div>{brief.headline}</div> : null}
						<div className="meta">
							<span>
								{brief.storyCount} stor{brief.storyCount === 1 ? "y" : "ies"}
							</span>
							{brief.mustKnowCount > 0 ? (
								<Tag tone="accent">{brief.mustKnowCount} must-know</Tag>
							) : null}
							{brief.signalCount > 0 ? <Tag>{brief.signalCount} signals</Tag> : null}
							<span className="host">produced {formatInstant(brief.producedAt)}</span>
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
