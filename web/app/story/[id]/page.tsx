import Link from "next/link";
import { notFound } from "next/navigation";
import { FactList } from "../../../components/facts.tsx";
import { SourceList } from "../../../components/sources.tsx";
import { Field, Tag } from "../../../components/bits.tsx";
import { ChangeBadge, ConfidenceBadge, ImportanceBadge } from "../../../components/badges.tsx";
import { importanceLevelFromScore } from "../../../lib/dashboard.ts";
import type { ConfidenceLevel } from "../../../../src/schemas/brief.ts";
import { loadStoryPage } from "../../../lib/queries.ts";
import {
	confidenceLabel,
	confidenceLevelFromScore,
	formatDateKey,
	formatInstant,
	formatScore,
	sectionLabel,
	signalStateLabel,
	storyStatusLabel,
} from "../../../lib/format.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const data = await loadStoryPage(decodeURIComponent(id));
	return { title: data ? `${data.latest.canonicalTitle} — SignalForge` : "找不到事件 — SignalForge" };
}

export default async function StoryPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const data = await loadStoryPage(decodeURIComponent(id));
	if (!data) notFound();

	const { latest, timeline, appearances, facts, primarySources, allSources, related, signals } =
		data;
	const published = appearances[0];
	// Published prose is preferred where it exists; the ledger's own reason is
	// the fallback so a story that never reached a brief still explains itself.
	const confidence: ConfidenceLevel = published
		? (published.confidence as ConfidenceLevel)
		: confidenceLevelFromScore(latest.confidence);
	const earlier = appearances.slice(1);

	return (
		<>
			<h1>{latest.canonicalTitle}</h1>
			<p className="dateline">
				<span className="mono">{latest.storyId}</span> · 首次出現{" "}
				{formatInstant(latest.firstSeenAt)} · 最近更新 {formatInstant(latest.lastSeenAt)}
			</p>
			<p className="meta">
				<ImportanceBadge level={importanceLevelFromScore(latest.importance)} />
				<ChangeBadge type={latest.changeType} />
				<Tag>{storyStatusLabel(latest.status)}</Tag>
				<ConfidenceBadge level={confidence} />
				{published ? (
					<Link href={`/brief/${published.date}`}>
						收錄於 {formatDateKey(published.date)} · {sectionLabel(published.section)}
					</Link>
				) : (
					<Tag tone="warn">尚未收錄到任何一天的重點</Tag>
				)}
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
							<li key={entry.date}>
								<strong>{formatDateKey(entry.date)}</strong>{" "}
								<ChangeBadge type={entry.changeType} />{" "}
								<Tag>{storyStatusLabel(entry.status)}</Tag>
								<div>{entry.canonicalTitle}</div>
								<div className="host">{entry.reason}</div>
								<div className="meta">
									<span className="host">重要性 {formatScore(entry.importance)}</span>
									<span className="host">新穎度 {formatScore(entry.novelty)}</span>
									<span className="host">可信度 {formatScore(entry.confidence)}</span>
									<span>{entry.sourceItemIds.length} 個來源</span>
									{appearance ? (
										<Link href={`/brief/${entry.date}`}>
											收錄於 {sectionLabel(appearance.section)}
										</Link>
									) : (
										<span>當天未選入</span>
									)}
								</div>
							</li>
						);
					})}
				</ol>
			</section>

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
					<ul className="plain tight">
						{signals.map((signal) => (
							<li key={signal.signalId}>
								<Link href="/signals">{signal.label}</Link>{" "}
								<Tag>{signalStateLabel(signal.state)}</Tag>{" "}
								<span className="host">{confidenceLabel(confidenceLevelFromScore(signal.confidence))}</span>
							</li>
						))}
					</ul>
				</section>
			) : null}

			{related.length > 0 ? (
				<section aria-labelledby="story-related">
					<h2 id="story-related">相關事件</h2>
					<div className="cards">
						{related.map(({ entry, sharedItemCount, tokenOverlap }) => (
							<div key={entry.storyId} className="card">
								<h3>
									<Link href={`/story/${encodeURIComponent(entry.storyId)}`}>
										{entry.canonicalTitle}
									</Link>
								</h3>
								<p className="meta">
									<ChangeBadge type={entry.changeType} />
									<span>{formatDateKey(entry.date)}</span>
								</p>
								<p className="host">
									{sharedItemCount > 0
										? `共用 ${sharedItemCount} 個來源項目`
										: `標題與理由的詞彙重疊 ${formatScore(tokenOverlap)}`}
								</p>
							</div>
						))}
					</div>
				</section>
			) : null}

			<section aria-labelledby="story-history">
				<h2 id="story-history">歷史脈絡</h2>
				<p>
					自 {formatInstant(latest.firstSeenAt)} 起追蹤 {timeline.length} 天，收錄於{" "}
					{appearances.length} 天的重點。
				</p>
				{earlier.length > 0 ? (
					<ul className="plain tight">
						{earlier.map((appearance) => (
							<li key={appearance.date}>
								<Link href={`/brief/${appearance.date}`}>{formatDateKey(appearance.date)}</Link>{" "}
								<span className="host">
									{sectionLabel(appearance.section)} — {appearance.title}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="lede">這個事件之前沒有被收錄過。</p>
				)}
			</section>
		</>
	);
}
