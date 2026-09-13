import Link from "next/link";
import { notFound } from "next/navigation";
import { FactList } from "../../../components/facts.tsx";
import { SourceList } from "../../../components/sources.tsx";
import { Field, Tag } from "../../../components/bits.tsx";
import { loadStoryPage } from "../../../lib/queries.ts";
import {
	changeTypeLabel,
	confidenceDisplay,
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
	return { title: data ? `${data.latest.canonicalTitle} — Daily Intelligence` : "Story not found" };
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
	const confidence = published
		? confidenceDisplay(published.confidence)
		: confidenceDisplay(confidenceLevelFromScore(latest.confidence));
	const earlier = appearances.slice(1);

	return (
		<>
			<h1>{latest.canonicalTitle}</h1>
			<p className="dateline">
				<span className="mono">{latest.storyId}</span> · first seen{" "}
				{formatInstant(latest.firstSeenAt)} · last seen {formatInstant(latest.lastSeenAt)}
			</p>
			<p className="meta">
				<Tag tone="accent">{changeTypeLabel(latest.changeType)}</Tag>
				<Tag>{storyStatusLabel(latest.status)}</Tag>
				<Tag tone={confidence.tone}>
					信心 {confidence.label} ({confidence.level})
				</Tag>
				<span>importance {formatScore(latest.importance)}</span>
				<span>novelty {formatScore(latest.novelty)}</span>
				<span>relevance {formatScore(latest.relevance)}</span>
				{published ? (
					<Link href={`/brief/${published.date}`}>
						in the {formatDateKey(published.date)} brief · {sectionLabel(published.section)}
					</Link>
				) : (
					<Tag tone="warn">never selected into a brief</Tag>
				)}
			</p>

			<section aria-labelledby="story-summary">
				<h2 id="story-summary">Summary</h2>
				<Field label="什麼發生了">
					{published ? published.whatHappened : latest.reason}
				</Field>
				{published ? (
					<>
						<Field label="為何重要">{published.whyItMatters}</Field>
						<Field label="有什麼變化">{published.whatChanged}</Field>
						<Field label="影響">{published.impact}</Field>
					</>
				) : (
					<p className="lede">
						This story is in the ledger but was not selected into a published brief, so it has
						no editorial “why it matters”, “what changed” or “impact” text. The curator&apos;s
						recorded reason above is what exists.
					</p>
				)}
				<FactList factRefs={latest.factRefs} facts={facts} />
			</section>

			<section aria-labelledby="story-timeline">
				<h2 id="story-timeline">Timeline</h2>
				<ol className="timeline">
					{timeline.map((entry) => {
						const appearance = appearances.find((a) => a.date === entry.date);
						return (
							<li key={entry.date}>
								<strong>{formatDateKey(entry.date)}</strong>{" "}
								<Tag tone="accent">{changeTypeLabel(entry.changeType)}</Tag>{" "}
								<Tag>{storyStatusLabel(entry.status)}</Tag>
								<div>{entry.canonicalTitle}</div>
								<div className="host">{entry.reason}</div>
								<div className="meta">
									<span>importance {formatScore(entry.importance)}</span>
									<span>novelty {formatScore(entry.novelty)}</span>
									<span>confidence {formatScore(entry.confidence)}</span>
									<span>{entry.sourceItemIds.length} sources</span>
									{appearance ? (
										<Link href={`/brief/${entry.date}`}>
											published in {sectionLabel(appearance.section)}
										</Link>
									) : (
										<span>not selected that day</span>
									)}
								</div>
							</li>
						);
					})}
				</ol>
			</section>

			{primarySources.length > 0 ? (
				<section aria-labelledby="story-primary">
					<h2 id="story-primary">Primary Sources</h2>
					<SourceList items={primarySources} />
				</section>
			) : null}

			<section aria-labelledby="story-sources">
				<h2 id="story-sources">All Sources</h2>
				<SourceList items={allSources} unresolvedIds={data.unresolvedSourceIds} />
			</section>

			{signals.length > 0 ? (
				<section aria-labelledby="story-signals">
					<h2 id="story-signals">Signals Citing This Story</h2>
					<ul className="plain tight">
						{signals.map((signal) => (
							<li key={signal.signalId}>
								<Link href="/signals">{signal.label}</Link>{" "}
								<Tag>{signalStateLabel(signal.state)}</Tag>{" "}
								<span className="host">confidence {formatScore(signal.confidence)}</span>
							</li>
						))}
					</ul>
				</section>
			) : null}

			{related.length > 0 ? (
				<section aria-labelledby="story-related">
					<h2 id="story-related">Related Stories</h2>
					<div className="cards">
						{related.map(({ entry, sharedItemCount, tokenOverlap }) => (
							<div key={entry.storyId} className="card">
								<h3>
									<Link href={`/story/${encodeURIComponent(entry.storyId)}`}>
										{entry.canonicalTitle}
									</Link>
								</h3>
								<p className="meta">
									<Tag>{changeTypeLabel(entry.changeType)}</Tag>
									<span>{formatDateKey(entry.date)}</span>
								</p>
								<p className="host">
									{sharedItemCount > 0
										? `${sharedItemCount} shared source item${sharedItemCount === 1 ? "" : "s"}`
										: `${formatScore(tokenOverlap)} title/reason token overlap`}
								</p>
							</div>
						))}
					</div>
				</section>
			) : null}

			<section aria-labelledby="story-history">
				<h2 id="story-history">Historical Context</h2>
				<p>
					Tracked across {timeline.length} day{timeline.length === 1 ? "" : "s"} since{" "}
					{formatInstant(latest.firstSeenAt)}, published in {appearances.length} brief
					{appearances.length === 1 ? "" : "s"}.
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
					<p className="lede">No earlier published appearance of this story.</p>
				)}
			</section>
		</>
	);
}
