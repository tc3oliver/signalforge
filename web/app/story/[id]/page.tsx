import Link from "next/link";
import { unstable_noStore as noStore } from "next/cache";
import { notFound } from "next/navigation";
import { FactList } from "../../../components/facts.tsx";
import { SourceList } from "../../../components/sources.tsx";
import { Field } from "../../../components/bits.tsx";
import { ChangeBadge, ConfidenceBadge, changeClass } from "../../../components/badges.tsx";
import { ADMIN_ENABLED } from "../../../lib/admin.ts";
import type { ConfidenceLevel } from "../../../../src/schemas/brief.ts";
import { loadStoryPage } from "../../../lib/queries.ts";
import {
	storyDisplayDescription,
	storyDisplayTitle,
	timelineDisplayTitle,
} from "../../../lib/story-title.ts";
import {
	confidenceLevelFromScore,
	formatDateKey,
	formatInstant,
	formatScore,
	sectionLabel,
	signalStateLabel,
	storyStatusLabel,
} from "../../../lib/format.ts";

/* A story page reflects published ledger rows; see /brief/[date] for why 300s. */
export const revalidate = 300;
export const runtime = "nodejs";

/*
 * A story id is a slug the curator writes, and it arrives here as a path
 * segment: user input. Matching the stored shape before any query keeps a
 * garbage id from costing a round trip, and -- because this route is revalidated
 * rather than dynamic -- from leaving a full-route cache entry on disk per
 * distinct string anyone chooses to request.
 */
const STORY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const storyId = decodeURIComponent(id);
	if (!STORY_ID.test(storyId)) return { title: "找不到事件 — SignalForge" };
	const data = await loadStoryPage(storyId);
	if (!data) return { title: "找不到事件 — SignalForge" };
	/*
	 * Presentation, not identity: the published editorial title and the brief's
	 * own account of the event, both trimmed to snippet length. The canonical
	 * URL below still uses the id, which never changes.
	 */
	const title = storyDisplayTitle(data.appearances, data.latest);
	const description = storyDisplayDescription(data.appearances, data.latest).slice(0, 160);
	return {
		title: `${title} — SignalForge`,
		description,
		// See /brief/[date]: a child `openGraph` replaces the parent, images included.
		openGraph: {
			title,
			description,
			type: "article",
			images: ["/opengraph-image.png"],
		},
		alternates: { canonical: `/story/${encodeURIComponent(storyId)}` },
	};
}

export default async function StoryPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const storyId = decodeURIComponent(id);
	if (!STORY_ID.test(storyId)) notFound();
	const data = await loadStoryPage(storyId);
	if (!data) {
		// As on /brief/[date]: a miss must not be cached for 300s.
		noStore();
		notFound();
	}

	const {
		latest,
		timeline,
		appearances,
		facts,
		primarySources,
		allSources,
		related,
		relatedTitles,
		signals,
	} = data;
	const published = appearances[0];
	// Published prose is preferred where it exists; the ledger's own reason is
	// the fallback so a story that never reached a brief still explains itself.
	const confidence: ConfidenceLevel = published
		? (published.confidence as ConfidenceLevel)
		: confidenceLevelFromScore(latest.confidence);
	const earlier = appearances.slice(1);

	return (
		<article className="story-page">
			<div className="story-main">
				<h1>{storyDisplayTitle(appearances, latest)}</h1>
				<p className="meta">
					<ChangeBadge type={latest.changeType} />
					<span>{storyStatusLabel(latest.status)}</span>
					<ConfidenceBadge level={confidence} />
					{published ? (
						<Link href={`/brief/${published.date}`}>
							收錄於 {formatDateKey(published.date)} · {sectionLabel(published.section)}
						</Link>
					) : (
						<span className="host">尚未收錄到任何一天的重點</span>
					)}
				</p>
				<p className="dateline">
					首次出現 {formatInstant(latest.firstSeenAt)} · 最近更新{" "}
					{formatInstant(latest.lastSeenAt)}
				</p>

				<section aria-labelledby="story-summary">
					<h2 id="story-summary">摘要</h2>
					<Field label="發生了什麼">
						{published ? published.whatHappened : latest.reason}
					</Field>
					{published ? (
						<>
							<Field label="為什麼值得注意">{published.whyItMatters}</Field>
							<Field label="最新變化">{published.whatChanged}</Field>
							<Field label="可能影響">{published.impact}</Field>
						</>
					) : (
						<p className="lede">
							這個事件有被追蹤，但沒有被選入任何一天的重點，所以沒有「為什麼值得注意」「最新變化」「可能影響」的內容。上面顯示的是篩選階段記錄的理由。
						</p>
					)}
					<FactList factRefs={latest.factRefs} facts={facts} />
				</section>

				<section aria-labelledby="story-timeline">
					<h2 id="story-timeline">時間線</h2>
					<ol className="timeline">
						{timeline.map((entry) => {
							const appearance = appearances.find((a) => a.date === entry.date);
							return (
								<li key={entry.date} className={changeClass(entry.changeType)}>
									<strong>{formatDateKey(entry.date)}</strong>{" "}
									<ChangeBadge type={entry.changeType} />{" "}
									<span className="host">{storyStatusLabel(entry.status)}</span>
									<div>{timelineDisplayTitle(appearance, entry)}</div>
									<div className="meta">
										<span>{entry.sourceItemIds.length} 個來源</span>
										{appearance ? (
											<Link href={`/brief/${entry.date}`}>
												收錄於 {sectionLabel(appearance.section)}
											</Link>
										) : (
											<span>當天未選入</span>
										)}
									</div>
									{ADMIN_ENABLED ? (
										<details className="story-internals">
											<summary>策展內部資料</summary>
											<p className="host">{entry.reason}</p>
											<p className="meta">
												<span className="host">重要性 {formatScore(entry.importance)}</span>
												<span className="host">新穎度 {formatScore(entry.novelty)}</span>
												<span className="host">可信度 {formatScore(entry.confidence)}</span>
											</p>
										</details>
									) : null}
								</li>
							);
						})}
					</ol>
				</section>
				{related.length > 0 ? (
					<section aria-labelledby="story-related">
						<h2 id="story-related">相關事件</h2>
						<ul className="story-list">
							{related.map(({ entry, sharedItemCount }) => (
								<li key={entry.storyId}>
									<Link href={`/story/${encodeURIComponent(entry.storyId)}`}>
										{relatedTitles.get(entry.storyId) ?? entry.canonicalTitle}
									</Link>
									<p className="meta">
										<ChangeBadge type={entry.changeType} />
										<span>{formatDateKey(entry.date)}</span>
									</p>
									{sharedItemCount > 0 ? (
										<p className="host">共用 {sharedItemCount} 個來源項目</p>
									) : null}
								</li>
							))}
						</ul>
					</section>
				) : null}

				<section aria-labelledby="story-history">
					<h2 id="story-history">歷史脈絡</h2>
					<p>
						自 {formatInstant(latest.firstSeenAt)} 起追蹤 {timeline.length} 天，收錄於{" "}
						{appearances.length} 天的重點。
					</p>
					{earlier.length > 0 ? (
						<ol className="timeline compact">
							{earlier.map((appearance) => (
								<li key={appearance.date}>
									<Link href={`/brief/${appearance.date}`}>{formatDateKey(appearance.date)}</Link>{" "}
									<span className="host">
										{sectionLabel(appearance.section)} — {appearance.title}
									</span>
								</li>
							))}
						</ol>
					) : (
						<p className="lede">這個事件之前沒有被收錄過。</p>
					)}
				</section>
			</div>

			<aside className="story-aside">
				{primarySources.length > 0 ? (
					<section aria-labelledby="story-primary">
						<h2 id="story-primary">主要來源</h2>
						<SourceList items={primarySources} />
					</section>
				) : null}

				<section aria-labelledby="story-sources">
					<h2 id="story-sources">全部來源</h2>
					<SourceList items={allSources} unresolvedIds={data.unresolvedSourceIds} />
				</section>

				{signals.length > 0 ? (
					<section aria-labelledby="story-signals">
						<h2 id="story-signals">相關趨勢</h2>
						<ul className="story-list">
							{signals.map((signal) => (
								<li key={signal.signalId}>
									<Link href="/signals">{signal.label}</Link>{" "}
									<span className="host">{signalStateLabel(signal.state)}</span>
								</li>
							))}
						</ul>
					</section>
				) : null}

			</aside>
		</article>
	);
}
